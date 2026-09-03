"""Endpoints del motor de señales cuantitativas.

Coste de API: la señal reutiliza fundamentales y precios ya cacheados (24 h y
15 min). El backtest descarga estados financieros de EDGAR — gratis — y el
histórico de precios que el gráfico ya trajo. El LLM solo entra bajo petición
explícita.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.decision import decide
from app.analysis.backtest import (
    metrics_from_period,
    monthly_rebalance_dates,
    run_walk_forward,
)
from app.analysis.rule_backtest import rebalance_dates_mensuales, run_rule_backtest
from app.analysis.shortlist import construir_lista_corta
from app.analysis.sizing import dimensionar
from app.analysis.factors import (
    DEFAULT_WEIGHTS,
    build_raw_factors,
    composite_score,
    family_scores,
    zscores,
)
from app.analysis.signal import (
    FAVORABLE_MIN,
    UNFAVORABLE_MAX,
    build_signal,
    calibrate,
    calibrate_walk_forward,
    rank_universe,
)
from app.analysis.markets import (
    DEFAULT_MARKET,
    MIN_SECTOR_SIZE,
    list_markets,
    load_market,
    universes_meta,
)
from app.analysis.universes import get_universe, list_universes
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import Instrument, LlmOutput, Position, WatchlistItem
from app.deps import get_llm, get_service
from app.llm.base import LLMProvider, LLMUnavailableError
from app.llm.signal_llm import explain_signal, extract_events, sentiment_from_events
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/signals", tags=["signals"])
logger = logging.getLogger(__name__)

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")
MAX_UNIVERSE = 15  # tope de coste: cada símbolo cuesta llamadas de fundamentales

# Fundamentales nuevos por petición de /today. Con Finnhub a 60/min, 120 deja
# margen para que el resto de la app siga funcionando mientras se completa el
# S&P 500 a lo largo de varias pasadas.
DEFAULT_FETCH_BUDGET = 120

# Campos que la UI necesita sí o sí en la respuesta de /today. Sirven para
# descartar respuestas cacheadas por versiones anteriores con otra forma.
_PAYLOAD_KEYS = frozenset(
    {
        "signals",
        "shortlist",
        "counts",
        "thresholds",
        "sectors",
        "scored",
        "requested",
        "complete",
    }
)


class SignalRequest(BaseModel):
    symbols: list[str] = Field(min_length=3, max_length=MAX_UNIVERSE)
    use_news: bool = Field(
        False, description="Incluir el factor de sentimiento (gasta API de Claude)"
    )


class ScanRequest(BaseModel):
    universe: str = Field(
        "megacaps", description="Clave de universo curado, o 'watchlist'"
    )
    top_n: int = Field(10, ge=3, le=25, description="Cuántas finalistas devolver")


class BacktestRequest(BaseModel):
    symbols: list[str] = Field(min_length=3, max_length=MAX_UNIVERSE)
    horizon_months: int = Field(12, ge=6, le=12)
    years: int = Field(6, ge=2, le=12)


class RuleBacktestRequest(BaseModel):
    symbols: list[str] = Field(min_length=3, max_length=MAX_UNIVERSE)
    years: int = Field(6, ge=2, le=12)
    # Quien invierte desde Canadá paga conversión de divisa en cada operación,
    # y suele pesar más que cualquier ventaja del modelo. Por defecto se cobra.
    con_divisa: bool = True


def _validate(symbols: list[str]) -> list[str]:
    out: list[str] = []
    for raw in symbols:
        symbol = raw.strip().upper()
        if not _SYMBOL_RE.match(symbol):
            raise HTTPException(status_code=422, detail=f"Símbolo inválido: {raw}")
        if symbol not in out:
            out.append(symbol)
    if len(out) < 3:
        raise HTTPException(
            status_code=422,
            detail=(
                "Se necesitan al menos 3 empresas distintas: los factores se "
                "puntúan contra el universo, no contra umbrales absolutos."
            ),
        )
    return out


def _safe_get(service: MarketDataService, data_type: str, **kwargs):
    try:
        return service.get(data_type, **kwargs)
    except (DataNotFoundError, AllProvidersFailedError):
        return None


def _lista_corta_dimensionada(
    ranked: list[dict], posiciones: dict[str, dict] | None = None
) -> dict:
    """La lista corta, con el tamaño decidido sobre el conjunto.

    El peso que trae cada decisión es BRUTO: lo que su stop permitiría mirando
    esa empresa sola. Aquí se aplica lo que solo se puede saber viendo la
    cartera entera — topes por posición, por sector y por correlación, más el
    objetivo de volatilidad. Sin este paso, cinco ideas «del 12 %» suman 60 %
    en cinco apuestas que probablemente caen juntas.

    Y «la cartera entera» incluye lo que ya tienes abierto, no solo las ideas
    nuevas. Se le pasan las dos cosas al dimensionador: las series de retornos
    (sin las cuales el límite por correlación no se ejecutaba) y las posiciones
    en libro (sin las cuales los topes por sector solo contaban la mitad).
    """
    corta = construir_lista_corta(ranked)
    candidatas = [
        {
            "symbol": s["symbol"],
            "sector": (s.get("context") or {}).get("sector_name"),
            "peso_bruto_pct": ((s.get("decision") or {}).get("levels") or {}).get(
                "peso_bruto_pct"
            ),
            "vol_anual_pct": _vol_anual(s),
        }
        for s in corta["ideas"]
    ]
    candidatas = [c for c in candidatas if c["peso_bruto_pct"]]
    cartera, aviso_cartera = _cartera_actual(ranked, posiciones or {})
    interesan = {c["symbol"] for c in candidatas} | {p["symbol"] for p in cartera}

    corta["sizing"] = dimensionar(
        candidatas,
        retornos=_retornos_desde_spark(ranked, interesan),
        cartera=cartera,
    )
    if aviso_cartera:
        corta["sizing"]["aviso_cartera"] = aviso_cartera
    for idea in corta["ideas"]:
        idea["peso_final_pct"] = corta["sizing"]["pesos"].get(idea["symbol"])
    return corta


def _vol_anual(signal: dict) -> float | None:
    """Volatilidad anualizada desde la diaria que ya trae el precio."""
    diaria = (signal.get("price") or {}).get("daily_vol_pct")
    return round(diaria * (252 ** 0.5), 2) if diaria else None


# `correlacion()` exige 20 retornos, o sea 21 puntos de precio.
SPARK_MIN_PUNTOS = 21
# Dos series solo se cruzan si sus historiales tienen longitudes parecidas.
TOLERANCIA_HISTORIAL = 0.05


def _retornos_desde_spark(
    signals: list[dict], simbolos: set[str]
) -> dict[str, list[float]]:
    """Retornos aproximados desde la miniatura de precio que ya viaja en la señal.

    El límite por correlación estaba escrito y nunca se ejecutaba: `dimensionar`
    aceptaba `retornos` y se llamaba sin ellos, así que la matriz salía vacía,
    `clusters` salía siempre `[]` y dos posiciones con correlación 0,9 pasaban el
    filtro como si fueran apuestas independientes. Esto lo alimenta con datos que
    ya están en la respuesta, sin una sola llamada más a ninguna API.

    La contrapartida hay que decirla: `spark` son 32 puntos muestreados
    uniformemente sobre el año de historial, o sea retornos de ~11 sesiones, no
    diarios. La correlación que sale de ahí es GRUESA — 31 observaciones, justo
    por encima del mínimo de la función — y sirve para detectar «esto se mueve
    claramente junto», no para dar un número fino. Se prefiere una estimación
    tosca a ninguna: sin ella el límite sencillamente no existe.

    Solo se cruzan símbolos con historiales de longitud parecida. Los puntos se
    muestrean sobre la serie de cada uno, así que si una empresa tiene 250
    sesiones y otra 100, sus 32 puntos cubren periodos distintos y correlacionar
    los dos no mide nada — daría un número con la misma pinta que uno bueno.
    """
    crudos: dict[str, tuple[int, list[float]]] = {}
    for signal in signals:
        if signal["symbol"] not in simbolos:
            continue
        precio = signal.get("price") or {}
        spark = precio.get("spark") or []
        if len(spark) < SPARK_MIN_PUNTOS:
            continue
        crudos[signal["symbol"]] = (precio.get("points") or len(spark), spark)

    if len(crudos) < 2:
        return {}

    longitudes = sorted(p for p, _ in crudos.values())
    mediana = longitudes[len(longitudes) // 2]

    salida: dict[str, list[float]] = {}
    for symbol, (puntos, spark) in crudos.items():
        if mediana and abs(puntos - mediana) / mediana > TOLERANCIA_HISTORIAL:
            continue
        retornos = [
            spark[i] / spark[i - 1] - 1
            for i in range(1, len(spark))
            if spark[i - 1]
        ]
        if len(retornos) >= 20:
            salida[symbol] = retornos
    return salida


def _cartera_actual(
    ranked: list[dict], posiciones: dict[str, dict]
) -> tuple[list[dict], str | None]:
    """Las posiciones abiertas, con peso y sector, para que los topes las cuenten.

    El peso se mide sobre el valor de mercado de las posiciones abiertas, que es
    la misma convención que ya usa el presupuesto de riesgo. La app no registra
    efectivo: asume que lo anotado es la cartera entera. El error va hacia el
    lado prudente (sobreestima la concentración, los topes aprietan antes), pero
    se dice, aquí y en la nota que viaja al frontend.

    Las posiciones que este barrido no puede valorar —de otro mercado, o sin
    precio— quedan fuera y se avisa: un tope calculado sobre media cartera es
    peor que ninguno si no sabes que le falta la otra mitad.
    """
    if not posiciones:
        return [], None

    por_simbolo = {s["symbol"]: s for s in ranked}
    valoradas: list[dict] = []
    sin_valorar: list[str] = []
    for symbol, datos in posiciones.items():
        signal = por_simbolo.get(symbol)
        precio = ((signal or {}).get("price") or {}).get("last")
        cantidad = datos.get("quantity")
        if not signal or not precio or not cantidad:
            sin_valorar.append(symbol)
            continue
        valoradas.append(
            {
                "symbol": symbol,
                "sector": (signal.get("context") or {}).get("sector_name"),
                "valor": precio * cantidad,
                "vol_anual_pct": _vol_anual(signal),
            }
        )

    total = sum(p["valor"] for p in valoradas)
    aviso = None
    if sin_valorar:
        muestra = ", ".join(sorted(sin_valorar)[:5])
        aviso = (
            f"{len(sin_valorar)} posición(es) abierta(s) no entran en los topes "
            f"por sector y correlación ({muestra}): este barrido no las cubre o "
            "no tienen precio. Tu concentración real es mayor que la que se ve "
            "aquí."
        )
    if not total:
        return [], aviso

    return [
        {
            "symbol": p["symbol"],
            "sector": p["sector"],
            "peso_pct": round(p["valor"] / total * 100, 2),
            "vol_anual_pct": p["vol_anual_pct"],
        }
        for p in valoradas
    ], aviso


def _stored_rule_backtest(session: Session) -> dict | None:
    """Último backtest de reglas. Es lo que convierte «razonable» en «probada»."""
    record = session.execute(
        select(LlmOutput)
        .where(LlmOutput.kind == "rule_backtest")
        .order_by(LlmOutput.created_at.desc())
    ).scalars().first()
    if record is None:
        return None
    import json

    try:
        return json.loads(record.content_md)
    except json.JSONDecodeError:
        return None


def _proximos_resultados(service: MarketDataService, dias: int = 7) -> dict[str, str]:
    """Símbolos que presentan resultados en los próximos `dias`.

    Una sola llamada cubre el mercado entero y está cacheada 12 h, así que
    aplicar este filtro a 500 empresas cuesta lo mismo que a una.
    """
    hoy = date.today()
    payload = _safe_get(
        service,
        "earnings_calendar",
        start=hoy.isoformat(),
        end=(hoy + timedelta(days=dias)).isoformat(),
    )
    salida: dict[str, str] = {}
    for evento in (payload or {}).get("events", []):
        simbolo, fecha = evento.get("symbol"), evento.get("date")
        if simbolo and fecha and simbolo not in salida:
            salida[simbolo] = fecha
    return salida


def _decision_segura(
    signal: dict,
    position: dict | None,
    reglas: dict | None = None,
    clase: str = "accion",
    resultados_en: str | None = None,
) -> dict:
    """`decide()` acotado a su propia fila.

    Una empresa con datos raros —un precio imposible, una posición con coste
    cero— no puede tumbar la lista entera de 500. Si su decisión falla, esa
    fila queda como "sin datos" diciendo por qué, y las demás siguen.
    """
    try:
        return decide(
            signal,
            signal.get("price"),
            position,
            favorable_min=FAVORABLE_MIN,
            desfavorable_max=UNFAVORABLE_MAX,
            reglas=reglas,
            clase=clase,
            resultados_en=resultados_en,
        )
    except Exception as exc:  # noqa: BLE001 — se reporta, no se traga
        logger.exception("decide() falló para %s", signal.get("symbol"))
        return {
            "action": "sin_datos",
            "label": "Sin datos",
            "reasons": [
                "No se pudo decidir con los datos de esta empresa: "
                f"{type(exc).__name__}."
            ],
            "levels": None,
            "triggers": [],
            "confidence": "ninguna",
            "owned": position is not None,
        }


class FetchBudget:
    """Tope de descargas NUEVAS de fundamentales en una sola petición.

    Existe porque el limitador de cuota descarta, no espera: lanzar 500
    llamadas contra un tier de 60/min puntuaría las primeras 60 y perdería el
    resto. Con presupuesto, cada petición avanza un trozo, lo cachea 24 h y la
    siguiente sigue por donde iba — la cobertura se acumula en vez de fallar.
    Lo ya cacheado no consume presupuesto: es gratis.
    """

    def __init__(self, limit: int):
        self.remaining = limit
        self.spent = 0

    def spend(self) -> bool:
        if self.remaining <= 0:
            return False
        self.remaining -= 1
        self.spent += 1
        return True


def _metrics_desde_edgar(
    service: MarketDataService, symbol: str, precio: float | None
) -> tuple[dict | None, str | None]:
    """Métricas de valoración desde EDGAR en vez de Finnhub.

    Es la palanca de coste más grande de toda la app. `fundamentals` iba a
    Finnhub, que da **60 llamadas por minuto**: puntuar 502 empresas gastaba la
    cuota entera en los primeros 60 símbolos, dejaba el resto sin puntuar y
    encima secaba la cuota que necesitan noticias, calendario y cotizaciones.

    EDGAR da los mismos números —los que la propia empresa presentó a la SEC—
    gratis y con un límite cinco veces mayor. Necesita un precio para los
    múltiplos, y ese precio ya lo trajo la descarga masiva de momentum sin coste
    adicional.

    Se usa el último ejercicio **publicado**, así que es anual y no TTM: más
    rugoso que un dato de proveedor, y a cambio gratis, auditable y trazable
    hasta el filing. Para un z-score transversal —donde todas las empresas se
    miden con la misma vara— esa rugosidad no cambia el orden.
    """
    if not precio:
        return None, None
    financials = _safe_get(service, "financials", symbol=symbol)
    if not financials or not financials.get("periods"):
        return None, None
    periodo = financials["periods"][-1]
    metrics = metrics_from_period(periodo, precio, periodo.get("shares_outstanding"))
    if not any(v is not None for v in metrics.values()):
        return None, None
    return metrics, financials.get("source", "edgar")


def _score_symbols(
    service: MarketDataService,
    session: Session,
    symbols: list[str],
    budget: FetchBudget | None = None,
    solo_momentum: bool = False,
) -> dict:
    """Puntúa un conjunto de símbolos unos contra otros.

    Los z-scores son **relativos al conjunto que se le pasa**: puntuar los
    mismos símbolos dentro de su sector o dentro de una mezcla de sectores da
    resultados distintos, y el sectorial es el limpio (comparar el P/E de un
    banco con el de una tecnológica castiga a la segunda sin motivo).

    Nunca lanza por falta de datos: devuelve lo que pudo puntuar y la lista de
    los que quedaron fuera, para que quien llama decida si es suficiente.
    """
    # 1) Momentum de todo el conjunto en una sola descarga (gratis).
    momentum_map: dict[str, float | None] = {}
    momentum_source = None
    # La misma descarga trae un año de cierres: de ahí salen precio, variación
    # y minigráfico sin ninguna llamada extra.
    price_map: dict[str, dict | None] = {}
    price_as_of = None
    bulk = _safe_get(service, "bulk_momentum", symbols=symbols)
    # Una entrada guardada antes de que la descarga trajera precios sigue
    # vigente hasta 6 h. Servirla daría una lista sin precio ni minigráfico y
    # sin decir por qué, así que se tira y se vuelve a pedir una sola vez.
    # Solo aplica a lo CACHEADO: si una respuesta recién descargada no trae
    # precios, volver a pedirla duplicaría la descarga sin arreglar nada.
    if bulk is not None and bulk.get("cached") and "prices" not in bulk:
        service.cache.invalidate("bulk_momentum", {"symbols": symbols})
        bulk = _safe_get(service, "bulk_momentum", symbols=symbols)
    if bulk:
        momentum_map = bulk.get("momentum", {})
        momentum_source = bulk.get("source")
        price_map = bulk.get("prices") or {}
        price_as_of = bulk.get("as_of")

    # 2) Fundamentales por empresa (caché 24 h).
    raw_by_symbol: dict[str, dict] = {}
    context: dict[str, dict] = {}
    unavailable = []
    pending: list[str] = []
    for symbol in symbols:
        # Cripto no tiene estados financieros que descargar: ni valor ni
        # calidad existen ahí. Se puntúa con lo único medible —momentum— y la
        # app lo declara, en vez de fingir un compuesto de cuatro factores del
        # que tres estarían vacíos.
        if solo_momentum:
            if momentum_map.get(symbol) is None:
                unavailable.append({"symbol": symbol, "reason": "sin histórico suficiente"})
                continue
            raw_by_symbol[symbol] = build_raw_factors(
                {}, momentum_map.get(symbol), None
            )
            context[symbol] = {"source": momentum_source or "yfinance"}
            continue

        # EDGAR primero: gratis y con cinco veces más cuota que Finnhub. Solo
        # si la empresa no está en la SEC se recurre al proveedor de pago, y
        # entonces sí consume presupuesto.
        precio = (price_map.get(symbol) or {}).get("last")
        metrics_edgar, fuente_edgar = _metrics_desde_edgar(service, symbol, precio)
        if metrics_edgar is not None:
            raw_by_symbol[symbol] = build_raw_factors(
                metrics_edgar, momentum_map.get(symbol), None
            )
            context[symbol] = {"source": fuente_edgar or "edgar"}
            continue

        fundamentals = None
        if budget is not None:
            # Lo cacheado es gratis; solo lo nuevo consume presupuesto.
            fundamentals = service.cache.get("fundamentals", {"symbol": symbol})
            if fundamentals is None and not budget.spend():
                pending.append(symbol)
                continue
        if fundamentals is None:
            fundamentals = _safe_get(service, "fundamentals", symbol=symbol)
        if fundamentals is None:
            unavailable.append({"symbol": symbol, "reason": "sin fundamentales o cuota agotada"})
            continue
        raw_by_symbol[symbol] = build_raw_factors(
            dict(fundamentals["metrics"]), momentum_map.get(symbol), None
        )
        context[symbol] = {"source": fundamentals["source"]}

    calibration = _stored_calibration(session)
    if not raw_by_symbol:
        return {
            "ranked": [],
            "raw": {},
            "unavailable": unavailable,
            "momentum": momentum_map,
            "momentum_source": momentum_source,
            "calibration": calibration,
            "scored": 0,
            "pending": pending,
        }

    # 3) z-scores sobre el conjunto puntuado, y ranking.
    factor_names = {f for raw in raw_by_symbol.values() for f in raw}
    factor_z = {
        factor: zscores({s: raw.get(factor) for s, raw in raw_by_symbol.items()})
        for factor in factor_names
    }
    families = family_scores(factor_z)

    signals = []
    for symbol in raw_by_symbol:
        composite = composite_score(
            {f: families[f].get(symbol) for f in families}, DEFAULT_WEIGHTS
        )
        signal = build_signal(symbol, composite, calibration, horizon="6-12 meses")
        signal["context"] = context.get(symbol, {})
        signal["events"] = []
        # Precio y serie con su procedencia: la app nunca enseña una cifra sin
        # decir de dónde sale y de cuándo es.
        precio = price_map.get(symbol)
        signal["price"] = (
            {**precio, "source": momentum_source, "as_of": price_as_of}
            if precio
            else None
        )
        signals.append(signal)

    return {
        "ranked": rank_universe(signals),
        "raw": raw_by_symbol,
        "unavailable": unavailable,
        "momentum": momentum_map,
        "momentum_source": momentum_source,
        "calibration": calibration,
        "scored": len(raw_by_symbol),
        "pending": pending,
    }


def _momentum_from_history(bars: list[dict]) -> float | None:
    """Momentum 12-1 sobre el histórico ya cacheado (barras diarias)."""
    if len(bars) < 200:
        return None
    closes = [b["close"] for b in bars]
    # ~252 sesiones al año, ~21 al mes: t−12m a t−1m.
    start_idx = max(len(closes) - 252, 0)
    end_idx = len(closes) - 21
    if end_idx <= start_idx or not closes[start_idx]:
        return None
    return closes[end_idx] / closes[start_idx] - 1


def _enrich_from_edgar(
    service: MarketDataService, symbol: str, metrics: dict
) -> dict:
    """Añade FCF yield y cobertura de intereses desde EDGAR.

    EDGAR es gratis y ya está cacheado 24 h, así que estos dos factores no
    cuestan cuota. Si la empresa no está en la SEC, simplemente no estarán y
    el compuesto se renormaliza sobre lo disponible.
    """
    financials = _safe_get(service, "financials", symbol=symbol)
    if not financials or not financials.get("periods"):
        return metrics

    from app.analysis.fundamentals import free_cash_flow

    latest = financials["periods"][-1]
    fcf = free_cash_flow(latest)
    market_cap = metrics.get("market_cap")
    if fcf is not None and market_cap:
        metrics["fcf_yield"] = fcf / market_cap

    ebit = latest.get("operating_income")
    interest = latest.get("interest_expense")
    if ebit is not None and interest:
        metrics["interest_coverage"] = ebit / interest
    return metrics


def _stored_calibration(session: Session) -> dict | None:
    """Última tabla de calibración guardada por un backtest."""
    record = session.execute(
        select(LlmOutput)
        .where(LlmOutput.kind == "backtest_calibration")
        .order_by(LlmOutput.created_at.desc())
    ).scalars().first()
    if record is None:
        return None
    import json

    try:
        return json.loads(record.content_md)
    except json.JSONDecodeError:
        return None


@router.post("/score")
def score_universe(
    request: SignalRequest = Body(...),
    service: MarketDataService = Depends(get_service),
    session: Session = Depends(get_session),
    llm: LLMProvider | None = Depends(get_llm),
):
    """Puntúa un universo y devuelve las señales ordenadas.

    Sin calibración previa (endpoint /backtest) las señales muestran solo la
    puntuación relativa: no se publica ninguna probabilidad.
    """
    symbols = _validate(request.symbols)

    raw_by_symbol: dict[str, dict] = {}
    context: dict[str, dict] = {}
    unavailable = []
    events_by_symbol: dict[str, list] = {}

    for symbol in symbols:
        fundamentals = _safe_get(service, "fundamentals", symbol=symbol)
        if fundamentals is None:
            unavailable.append({"symbol": symbol, "reason": "sin fundamentales"})
            continue
        metrics = _enrich_from_edgar(service, symbol, dict(fundamentals["metrics"]))

        history = _safe_get(
            service, "price_history", symbol=symbol, interval="1day", outputsize=252
        )
        momentum = _momentum_from_history(history["bars"]) if history else None

        sentiment = None
        if request.use_news and llm is not None:
            news = _safe_get(service, "news", symbol=symbol, days=30)
            if news and news.get("items"):
                events = extract_events(llm, news["items"][:10])
                events_by_symbol[symbol] = events
                sentiment = sentiment_from_events(events)

        raw_by_symbol[symbol] = build_raw_factors(metrics, momentum, sentiment)
        profile = _safe_get(service, "profile", symbol=symbol) or {}
        context[symbol] = {
            "name": profile.get("name"),
            "sector": profile.get("sector"),
            "source": fundamentals["source"],
        }

    if len(raw_by_symbol) < 3:
        raise HTTPException(
            status_code=422,
            detail="Menos de 3 empresas con datos: no hay corte transversal que puntuar.",
        )

    factor_names = {f for raw in raw_by_symbol.values() for f in raw}
    factor_z = {
        factor: zscores({s: raw.get(factor) for s, raw in raw_by_symbol.items()})
        for factor in factor_names
    }
    families = family_scores(factor_z)
    calibration = _stored_calibration(session)

    signals = []
    for symbol in raw_by_symbol:
        composite = composite_score(
            {f: families[f].get(symbol) for f in families}, DEFAULT_WEIGHTS
        )
        signal = build_signal(symbol, composite, calibration, horizon="6-12 meses")
        signal["context"] = context.get(symbol, {})
        signal["events"] = events_by_symbol.get(symbol, [])
        signals.append(signal)

    return {
        "signals": rank_universe(signals),
        "unavailable": unavailable,
        "calibrated": calibration is not None,
        "weights": DEFAULT_WEIGHTS,
        "universe_size": len(raw_by_symbol),
        "note": (
            "Las puntuaciones son relativas a este universo: cambiar las empresas "
            "cambia todas las puntuaciones. No son medidas absolutas."
        ),
        "disclaimer": (
            "Modelo de investigación, no asesoría. Una puntuación favorable "
            "describe cómo ordena el modelo a esta empresa frente a las demás, "
            "no una recomendación de compra."
        ),
    }


@router.get("/universes")
def get_universes():
    """Universos curados disponibles para el escaneo automático."""
    return {
        "universes": list_universes(),
        "note": (
            "Los universos sectoriales dan comparaciones más limpias: el modelo "
            "puntúa unas empresas contra otras, y comparar un banco con una "
            "tecnológica distorsiona los factores de valor."
        ),
    }


@router.post("/scan")
def scan_universe(
    request: ScanRequest = Body(...),
    service: MarketDataService = Depends(get_service),
    session: Session = Depends(get_session),
):
    """Escanea un universo entero y devuelve las mejor puntuadas.

    Estrategia de coste: el momentum de TODO el universo se descarga de una
    sola vez con yfinance (gratis). Los fundamentales van por Finnhub, con
    caché de 24 h — la primera pasada tarda, las siguientes son instantáneas.
    Si la cuota se agota a mitad, se devuelve lo puntuado hasta ahí y se dice
    cuántas quedaron fuera, en vez de fallar entero.
    """
    if request.universe == "watchlist":
        rows = session.execute(
            select(Instrument)
            .join(WatchlistItem, WatchlistItem.instrument_id == Instrument.id)
        ).scalars().all()
        symbols = [r.symbol for r in rows]
        universe_name = "Mi watchlist"
        description = "Las empresas que sigues, puntuadas unas contra otras."
        if len(symbols) < 3:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Tu watchlist tiene menos de 3 empresas. El modelo puntúa "
                    "por comparación, así que necesita al menos 3."
                ),
            )
    else:
        try:
            universe = get_universe(request.universe)
        except KeyError:
            raise HTTPException(
                status_code=404, detail=f"Universo desconocido: {request.universe}"
            ) from None
        symbols = universe["symbols"]
        universe_name = universe["name"]
        description = universe["description"]

    scoring = _score_symbols(service, session, symbols)
    if scoring["scored"] < 3:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Solo se pudieron puntuar {scoring['scored']} empresas de "
                f"{len(symbols)}. Revisa que FINNHUB_API_KEY esté en .env y que "
                "quede cuota disponible."
            ),
        )

    ranked = scoring["ranked"]
    unavailable = scoring["unavailable"]
    momentum_source = scoring["momentum_source"]
    momentum_map = scoring["momentum"]
    calibration = scoring["calibration"]
    raw_by_symbol = scoring["raw"]
    top = ranked[: request.top_n]

    # Nombres solo para las finalistas: pedir el perfil de las 30 costaría
    # 30 llamadas para información puramente cosmética.
    for signal in top:
        profile = _safe_get(service, "profile", symbol=signal["symbol"])
        if profile:
            signal["context"]["name"] = profile.get("name")
            signal["context"]["sector"] = profile.get("sector")

    return {
        "universe_key": request.universe,
        "universe_name": universe_name,
        "universe_description": description,
        "top": top,
        "all_ranked": [
            {"symbol": s["symbol"], "score": s["score"], "label": s["label"], "rank": s.get("rank")}
            for s in ranked
        ],
        "scored": len(raw_by_symbol),
        "requested": len(symbols),
        "unavailable": unavailable,
        "calibrated": calibration is not None,
        "momentum_source": momentum_source,
        "momentum_coverage": sum(1 for v in momentum_map.values() if v is not None),
        "weights": DEFAULT_WEIGHTS,
        "note": (
            f"Puntuadas {len(raw_by_symbol)} de {len(symbols)} empresas. Las "
            "puntuaciones son relativas a este universo: la misma empresa puede "
            "salir favorable aquí y neutral en otro conjunto."
        ),
        "disclaimer": (
            "Este ranking ordena empresas según los factores del modelo. NO es "
            "una lista de compra: que una empresa encabece el ranking significa "
            "que puntúa mejor que sus comparables en valor, calidad y momentum, "
            "no que vaya a subir."
        ),
    }


@router.get("/markets")
def markets():
    """Mercados disponibles para la lista diaria, con su procedencia."""
    return {"markets": list_markets(), "meta": universes_meta()}


@router.get("/today")
def today(
    market: str = Query(DEFAULT_MARKET, description="Clave de mercado"),
    refresh: bool = Query(False, description="Ignora la caché y sigue puntuando"),
    budget: int = Query(
        DEFAULT_FETCH_BUDGET,
        ge=10,
        le=600,
        description="Máximo de fundamentales NUEVOS a descargar en esta petición",
    ),
    service: MarketDataService = Depends(get_service),
    session: Session = Depends(get_session),
):
    """Lista del día, con el motivo real de cualquier fallo.

    Un fallo inesperado aquí salía como 500 sin cuerpo, y la pantalla solo
    podía decir «Error HTTP 500» — inservible para saber qué arreglar. Este
    envoltorio traduce cualquier excepción a un `detail` legible y deja la
    traza completa en el log del backend.
    """
    try:
        return _today(market, refresh, budget, service, session)
    except HTTPException:
        raise  # 404/502 ya llevan su explicación
    except Exception as exc:  # noqa: BLE001 — se reporta, no se traga
        logger.exception("Fallo inesperado en /today (market=%s)", market)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Fallo inesperado al construir la lista: {type(exc).__name__}: "
                f"{exc}. La traza completa está en el log del backend "
                "(/tmp/bolsa-backend.log)."
            ),
        ) from exc


def _today(
    market: str,
    refresh: bool,
    budget: int,
    service: MarketDataService,
    session: Session,
):
    """Lista del día de un mercado: todo lo puntuable, ordenado, sin elegir nada.

    Puntúa **dentro de cada sector** y luego mezcla los resultados en una sola
    lista, porque comparar un banco con una tecnológica premiaría a sectores
    enteros por tener múltiplos estructuralmente bajos.

    Cobertura incremental: el S&P 500 son ~500 empresas y los tiers gratuitos
    dan 60 llamadas/min, así que cada petición descarga como mucho `budget`
    fundamentales nuevos (los ya cacheados salen gratis) y deja el resto en
    `pending`. Repetir con `refresh=true` sigue por donde iba hasta completar.
    """
    try:
        market_data = load_market(market)
    except KeyError:
        raise HTTPException(
            status_code=404, detail=f"Mercado desconocido: {market}"
        ) from None

    cache_params = {"v": 6, "market": market}
    if not refresh:
        cached = service.cache.get("daily_picks", cache_params)
        # Una respuesta guardada por una versión anterior de la app puede no
        # tener los campos que la UI espera, y servirla dejaba la pantalla en
        # blanco. Se valida la forma en vez de confiar solo en subir "v": así
        # olvidarse de subirla no vuelve a romper nada.
        if cached is not None and _PAYLOAD_KEYS <= cached.keys():
            return cached

    # Lo que ya tienes cambia la pregunta: sobre una posición abierta no se
    # decide si comprar, sino si sostenerla o soltarla.
    posiciones = {
        symbol: {"cost_basis": coste, "quantity": cantidad}
        for symbol, coste, cantidad in session.execute(
            select(Instrument.symbol, Position.cost_basis, Position.quantity)
            .join(Position, Position.instrument_id == Instrument.id)
            .where(Position.closed_at.is_(None))
        ).all()
    }

    # Si hay un backtest de reglas guardado, cada decisión puede decir si su
    # sistema está probado, refutado o solo es razonable.
    reglas = _stored_rule_backtest(session)
    # Una sola llamada cacheada 12 h cubre el mercado entero.
    resultados = _proximos_resultados(service)

    fetch_budget = FetchBudget(budget)
    ranked: list[dict] = []
    unavailable: list[dict] = []
    pending: list[str] = []
    sectors_meta: list[dict] = []
    momentum_source = None
    calibrated = False
    requested = 0

    for sector_name, companies in market_data["sectors"].items():
        symbols = [c["symbol"] for c in companies]
        names = {c["symbol"]: c["name"] for c in companies}
        requested += len(symbols)
        scoring = _score_symbols(
            service, session, symbols, budget=fetch_budget,
            solo_momentum=market_data.get("solo_momentum", False),
        )

        # Un sector con menos de MIN_SECTOR_SIZE puntuadas no produce z-scores
        # con sentido: se descarta entero en vez de contaminar la lista.
        usable = scoring["scored"] >= MIN_SECTOR_SIZE
        if usable:
            for signal in scoring["ranked"]:
                # Las no puntuables (score None) quedan fuera: no se pueden
                # ordenar ni etiquetar, y colarlas sería fingir cobertura.
                if signal.get("score") is None:
                    unavailable.append(
                        {"symbol": signal["symbol"], "reason": "sin factores suficientes"}
                    )
                    continue
                signal["context"]["sector_key"] = sector_name
                signal["context"]["sector_name"] = sector_name
                # El nombre sale del archivo del universo: pedirlo al API
                # costaría ~500 llamadas por información puramente cosmética.
                signal["context"]["name"] = names.get(signal["symbol"])
                signal["sector_rank"] = signal.pop("rank", None)
                signal["decision"] = _decision_segura(
                    signal,
                    posiciones.get(signal["symbol"]),
                    reglas,
                    clase=market_data.get("asset_class", "accion"),
                    resultados_en=resultados.get(signal["symbol"]),
                )
                ranked.append(signal)

        unavailable.extend(scoring["unavailable"])
        pending.extend(scoring["pending"])
        momentum_source = momentum_source or scoring["momentum_source"]
        calibrated = calibrated or scoring["calibration"] is not None
        sectors_meta.append(
            {
                "key": sector_name,
                "name": sector_name,
                "requested": len(symbols),
                "scored": scoring["scored"],
                "pending": len(scoring["pending"]),
                "usable": usable,
            }
        )

    if not ranked:
        raise HTTPException(
            status_code=502,
            detail=(
                "No se pudo puntuar ningún sector. Revisa que FINNHUB_API_KEY "
                "esté en .env y que quede cuota disponible."
            ),
        )

    ranked.sort(key=lambda s: s["score"], reverse=True)
    for i, signal in enumerate(ranked, start=1):
        signal["rank"] = i

    n_favorables = sum(1 for s in ranked if s["score"] >= FAVORABLE_MIN)
    n_desfavorables = sum(1 for s in ranked if s["score"] <= UNFAVORABLE_MAX)
    complete = not pending

    payload = {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "market_key": market,
        "market_name": market_data["name"],
        "market_description": market_data["description"],
        # La UI necesita saberlo para avisar: una puntuación de un solo factor
        # no puede presentarse con la misma cara que una de cuatro.
        "asset_class": market_data.get("asset_class", "accion"),
        "solo_momentum": market_data.get("solo_momentum", False),
        # TODAS las puntuadas, de mejor a peor. Antes solo viajaban los dos
        # extremos y la franja neutral —casi la mitad del índice— era
        # imposible de ver en la UI: si buscabas una empresa concreta y salía
        # neutral, parecía que el modelo no la cubría.
        "signals": ranked,
        # 98 candidatas no son 98 oportunidades. La lista corta ordena por
        # convicción y recorta a unas pocas: es la diferencia entre un filtro
        # y una recomendación.
        "shortlist": _lista_corta_dimensionada(ranked, posiciones),
        "counts": {
            "favorables": n_favorables,
            "neutrales": len(ranked) - n_favorables - n_desfavorables,
            "desfavorables": n_desfavorables,
        },
        "thresholds": {"favorable": FAVORABLE_MIN, "desfavorable": UNFAVORABLE_MAX},
        "sectors": sectors_meta,
        "scored": len(ranked),
        "requested": requested,
        "pending": len(pending),
        "complete": complete,
        "fetched_now": fetch_budget.spent,
        "unavailable": unavailable,
        "calibrated": calibrated,
        "momentum_source": momentum_source,
        "data_meta": universes_meta(),
        "note": (
            f"Puntuadas {len(ranked)} empresas de {requested} en "
            f"{sum(1 for s in sectors_meta if s['usable'])} sectores. Cada empresa "
            "se compara con las de su propio sector, no con el mercado entero."
        )
        + (
            ""
            if complete
            else (
                f" Faltan {len(pending)} por puntuar: los tiers gratuitos limitan "
                "cuántos fundamentales se pueden descargar de una vez. Pulsa "
                "«Seguir completando» para continuar."
            )
        ),
        "disclaimer": (
            "Cada acción sale de reglas mecánicas escritas, no de una "
            "predicción: 'Comprar' significa que la empresa puntúa mejor que "
            "sus comparables de sector y que el precio acompaña, no que vaya a "
            "subir. Las reglas son razonables pero aún no están validadas "
            "contra histórico — ejecuta el backtest en Señales para saber si "
            "han funcionado. El tamaño sugerido asume arriesgar un 1 % de tu "
            "cartera por operación; ajústalo a tu situación."
        ),
    }

    service.cache.set("daily_picks", cache_params, payload)
    payload["cached"] = False
    return payload


@router.post("/backtest")
def run_backtest(
    request: BacktestRequest = Body(...),
    service: MarketDataService = Depends(get_service),
    session: Session = Depends(get_session),
):
    """Valida el modelo con walk-forward y guarda la calibración resultante.

    Usa EDGAR (gratis) para fundamentales point-in-time y el histórico de
    precios cacheado. Es la única vía por la que la app llega a publicar una
    probabilidad.
    """
    symbols = _validate(request.symbols)

    universe: dict[str, dict] = {}
    missing = []
    for symbol in symbols:
        financials = _safe_get(service, "financials", symbol=symbol)
        filings = _safe_get(service, "filings", symbol=symbol)
        history = _safe_get(
            service, "price_history", symbol=symbol, interval="1day", outputsize=5000
        )
        if not financials or not history:
            missing.append(symbol)
            continue
        universe[symbol] = {
            "periods": financials["periods"],
            "filings": (filings or {}).get("filings", []),
            "bars": history["bars"],
        }

    if len(universe) < 3:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Solo {len(universe)} empresas con histórico suficiente "
                "(se necesitan 3+). EDGAR solo cubre empresas registradas en la SEC."
            ),
        )

    end = date.today() - timedelta(days=int(request.horizon_months * 30.44))
    start = end - timedelta(days=365 * request.years)
    dates = monthly_rebalance_dates(start, end, step_months=3)

    result = run_walk_forward(universe, dates, request.horizon_months)
    calibration = calibrate(result["observations"])
    # La tabla de arriba se ajusta con la muestra entera y luego publica
    # esas mismas tasas como predicción, que es circular. Esta se ajusta
    # solo con el pasado de cada observación: es la estimación honesta.
    fuera_de_muestra = calibrate_walk_forward(result["observations"])

    if result["n_observations"] > 0:
        import json

        session.add(
            LlmOutput(
                kind="backtest_calibration",
                content_md=json.dumps(calibration),
                model=f"walk-forward/{request.horizon_months}m",
            )
        )
        session.commit()

    reliable = [b for b in calibration.values() if b.get("reliable")]
    hits = sum(1 for o in result["observations"] if o["outperformed"])
    n = result["n_observations"]
    return {
        "calibration": calibration,
        "calibracion_fuera_de_muestra": fuera_de_muestra,
        "n_observations": n,
        "n_rebalances": result["n_rebalances"],
        "overall_hit_rate": (hits / n) if n else None,
        "horizon_months": request.horizon_months,
        "universe": list(universe),
        "missing": missing,
        "excluded_factors": result["excluded_factors"],
        "methodology": result["methodology"],
        "reliable_buckets": len(reliable),
        "verdict": _backtest_verdict(n, len(reliable), hits / n if n else None),
    }


@router.post("/rule-backtest")
def run_rules_backtest(
    request: RuleBacktestRequest = Body(...),
    service: MarketDataService = Depends(get_service),
    session: Session = Depends(get_session),
):
    """¿Ganan dinero las reglas de compra y venta? Simulación operación a operación.

    `/backtest` valida el **modelo de factores**: si la puntuación ordena mejor
    que la mediana. Este endpoint valida el **sistema que se ejecuta**: entrar
    solo por encima de la media de 200 sesiones, con stop por volatilidad,
    objetivo al doble y salida por lo que llegue antes — neto de costes.

    Son preguntas distintas y una puede salir bien con la otra mal.
    """
    symbols = _validate(request.symbols)

    universe: dict[str, dict] = {}
    missing: list[str] = []
    for symbol in symbols:
        financials = _safe_get(service, "financials", symbol=symbol)
        filings = _safe_get(service, "filings", symbol=symbol)
        history = _safe_get(
            service, "price_history", symbol=symbol, interval="1day", outputsize=5000
        )
        if not financials or not history:
            missing.append(symbol)
            continue
        universe[symbol] = {
            "periods": financials["periods"],
            "filings": (filings or {}).get("filings", []),
            "bars": history["bars"],
        }

    if len(universe) < 3:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Solo {len(universe)} empresas con histórico suficiente "
                "(se necesitan 3+). EDGAR solo cubre empresas registradas en la SEC."
            ),
        )

    # Se deja un año al final para que las operaciones abiertas al borde del
    # periodo puedan cerrarse. Sin ese margen se contarían solo las rápidas.
    end = date.today() - timedelta(days=365)
    start = end - timedelta(days=365 * request.years)
    fechas = rebalance_dates_mensuales(start, end)

    resultado = run_rule_backtest(universe, fechas, con_divisa=request.con_divisa)
    # La misma prueba sin el filtro de tendencia. Es la única forma de saber si
    # esa regla aporta o solo suena bien.
    sin_filtro = run_rule_backtest(
        universe, fechas, con_divisa=request.con_divisa, exigir_tendencia=False
    )

    if resultado["n_operaciones"] > 0:
        import json

        session.add(
            LlmOutput(
                kind="rule_backtest",
                content_md=json.dumps(
                    {k: v for k, v in resultado.items() if k != "operaciones"}
                ),
                model=f"reglas/{request.years}a",
            )
        )
        session.commit()

    return {
        **resultado,
        "universo": list(universe),
        "sin_datos": missing,
        "periodo": {"desde": start.isoformat(), "hasta": end.isoformat()},
        "comparativa_sin_filtro_tendencia": {
            "n_operaciones": sin_filtro["n_operaciones"],
            "esperanza_pct": sin_filtro.get("esperanza_pct"),
            "tasa_acierto": sin_filtro.get("tasa_acierto"),
        },
        "veredicto": _rule_verdict(resultado, sin_filtro),
    }


def _rule_verdict(resultado: dict, sin_filtro: dict) -> str:
    """Lectura honesta. Un resultado malo se dice, no se maquilla."""
    n = resultado["n_operaciones"]
    if n == 0:
        return (
            "Ninguna operación cumplió las condiciones. Sin operaciones no hay "
            "nada que validar: las reglas siguen sin respaldo."
        )
    if not resultado["fiable"]:
        return (
            f"Solo {n} operaciones: por debajo de 30 cualquier tasa de acierto "
            "es ruido. No sirve para concluir nada todavía."
        )

    esperanza = resultado["esperanza_pct"]
    ventaja = resultado.get("ventaja_pct")
    partes = [
        f"{n} operaciones, {resultado['tasa_acierto'] * 100:.0f} % de aciertos, "
        f"esperanza de {esperanza:+.2f} % por operación neta de costes."
    ]

    if esperanza <= 0:
        partes.append(
            "La esperanza es negativa: aplicar estas reglas habría perdido "
            "dinero. No las uses tal cual."
        )
    elif ventaja is not None and ventaja <= 0:
        partes.append(
            f"Pero comprar el universo entero a ciegas daba {resultado['referencia_pct']:+.2f} %: "
            "las reglas ganan menos que no hacer nada. El trabajo extra no se paga."
        )
    else:
        partes.append(
            f"Supera en {ventaja:+.2f} puntos a comprar a ciegas. Es una ventaja "
            "real en el periodo probado, no una garantía futura."
        )

    propia = resultado["esperanza_pct"]
    otra = sin_filtro.get("esperanza_pct")
    if otra is not None and sin_filtro["n_operaciones"] >= 30:
        if propia > otra:
            partes.append(
                f"El filtro de la media de 200 sesiones aporta: sin él la "
                f"esperanza baja a {otra:+.2f} %."
            )
        else:
            partes.append(
                f"El filtro de la media de 200 sesiones NO aporta: sin él la "
                f"esperanza sube a {otra:+.2f} %. Conviene revisarlo."
            )

    partes.append(
        f"Racha perdedora más larga: {resultado['racha_perdedora']} operaciones "
        "seguidas. Si no aguantarías eso, el sistema no es para ti aunque gane."
    )
    return " ".join(partes)


def _backtest_verdict(n: int, reliable_buckets: int, hit_rate: float | None) -> str:
    """Lectura honesta del backtest. No maquilla un resultado pobre."""
    if n == 0:
        return (
            "Sin observaciones. El universo no tiene histórico suficiente para "
            "validar nada; el modelo no puede publicar probabilidades."
        )
    if reliable_buckets == 0:
        return (
            f"{n} observaciones, ninguna categoría con muestra suficiente. El "
            "modelo sigue SIN calibrar: cualquier probabilidad sería ruido. "
            "Amplía el universo o el periodo."
        )
    if hit_rate is not None and 0.45 <= hit_rate <= 0.55:
        return (
            f"Tasa de acierto global {hit_rate:.0%} sobre {n} observaciones: "
            "indistinguible de lanzar una moneda. El modelo NO demuestra tener "
            "capacidad de ordenar el universo."
        )
    return (
        f"Tasa de acierto global {hit_rate:.0%} sobre {n} observaciones "
        f"({reliable_buckets} categorías con muestra suficiente). Ojo: con "
        "universos pequeños y pocos rebalanceos, este resultado tiene mucha "
        "varianza — repítelo con otro universo antes de darlo por bueno."
    )


@router.post("/{symbol}/explain")
def explain(
    symbol: str,
    payload: dict = Body(...),
    llm: LLMProvider | None = Depends(get_llm),
    session: Session = Depends(get_session),
):
    """Explicación por IA de una señal ya calculada (bajo demanda)."""
    if llm is None:
        raise HTTPException(
            status_code=503,
            detail="Capa de IA no configurada: añade ANTHROPIC_API_KEY en .env",
        )
    signal = payload.get("signal")
    if not signal or signal.get("score") is None:
        raise HTTPException(status_code=422, detail="Señal sin puntuación que explicar")
    try:
        result = explain_signal(llm, signal, payload.get("context") or {})
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    session.add(
        LlmOutput(
            kind="signal_explanation",
            content_md=result["content_md"],
            model=result["model"],
        )
    )
    session.commit()
    return result

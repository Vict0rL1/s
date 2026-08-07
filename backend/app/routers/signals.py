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
from app.analysis.backtest import monthly_rebalance_dates, run_walk_forward
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
    {"signals", "counts", "thresholds", "sectors", "scored", "requested", "complete"}
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


def _decision_segura(signal: dict, position: dict | None) -> dict:
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


def _score_symbols(
    service: MarketDataService,
    session: Session,
    symbols: list[str],
    budget: FetchBudget | None = None,
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

    cache_params = {"v": 3, "market": market}
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
        scoring = _score_symbols(service, session, symbols, budget=fetch_budget)

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
                    signal, posiciones.get(signal["symbol"])
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
        # TODAS las puntuadas, de mejor a peor. Antes solo viajaban los dos
        # extremos y la franja neutral —casi la mitad del índice— era
        # imposible de ver en la UI: si buscabas una empresa concreta y salía
        # neutral, parecía que el modelo no la cubría.
        "signals": ranked,
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

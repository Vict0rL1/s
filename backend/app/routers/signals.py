"""Endpoints del motor de señales cuantitativas.

Coste de API: la señal reutiliza fundamentales y precios ya cacheados (24 h y
15 min). El backtest descarga estados financieros de EDGAR — gratis — y el
histórico de precios que el gráfico ya trajo. El LLM solo entra bajo petición
explícita.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.backtest import monthly_rebalance_dates, run_walk_forward
from app.analysis.factors import (
    DEFAULT_WEIGHTS,
    build_raw_factors,
    composite_score,
    family_scores,
    zscores,
)
from app.analysis.signal import build_signal, calibrate, rank_universe
from app.analysis.universes import DAILY_SECTOR_KEYS, get_universe, list_universes
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import Instrument, LlmOutput, WatchlistItem
from app.deps import get_llm, get_service
from app.llm.base import LLMProvider, LLMUnavailableError
from app.llm.signal_llm import explain_signal, extract_events, sentiment_from_events
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/signals", tags=["signals"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")
MAX_UNIVERSE = 15  # tope de coste: cada símbolo cuesta llamadas de fundamentales


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


def _score_symbols(
    service: MarketDataService, session: Session, symbols: list[str]
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
    bulk = _safe_get(service, "bulk_momentum", symbols=symbols)
    if bulk:
        momentum_map = bulk.get("momentum", {})
        momentum_source = bulk.get("source")

    # 2) Fundamentales por empresa (caché 24 h).
    raw_by_symbol: dict[str, dict] = {}
    context: dict[str, dict] = {}
    unavailable = []
    for symbol in symbols:
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
        signals.append(signal)

    return {
        "ranked": rank_universe(signals),
        "raw": raw_by_symbol,
        "unavailable": unavailable,
        "momentum": momentum_map,
        "momentum_source": momentum_source,
        "calibration": calibration,
        "scored": len(raw_by_symbol),
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


@router.get("/today")
def today(
    refresh: bool = Query(False, description="Ignora la caché y vuelve a puntuar"),
    service: MarketDataService = Depends(get_service),
    session: Session = Depends(get_session),
):
    """Lista del día: todo lo puntuable, ordenado, sin elegir universo.

    Puntúa **dentro de cada sector** y luego mezcla los resultados en una sola
    lista. Es más caro que un escaneo suelto (un z-score por sector en vez de
    uno global) pero es la única forma de que la lista no premie a sectores
    enteros por tener múltiplos estructuralmente bajos.

    El resultado se cachea 6 h: la primera pasada del día tarda (un
    fundamental por empresa, caché de 24 h), las siguientes son instantáneas.
    """
    cache_params = {"v": 1, "sectors": DAILY_SECTOR_KEYS}
    if not refresh:
        cached = service.cache.get("daily_picks", cache_params)
        if cached is not None:
            return cached

    ranked: list[dict] = []
    unavailable: list[dict] = []
    sectors_meta: list[dict] = []
    momentum_source = None
    calibrated = False
    requested = 0

    for key in DAILY_SECTOR_KEYS:
        universe = get_universe(key)
        symbols = universe["symbols"]
        requested += len(symbols)
        scoring = _score_symbols(service, session, symbols)

        # Un sector con menos de 3 puntuadas no produce z-scores con sentido:
        # se descarta entero en vez de contaminar la lista con ruido.
        usable = scoring["scored"] >= 3
        if usable:
            for signal in scoring["ranked"]:
                # Las no puntuables (score None) quedan fuera de la lista: no se
                # pueden ordenar ni etiquetar, y colarlas sería fingir cobertura.
                if signal.get("score") is None:
                    unavailable.append(
                        {"symbol": signal["symbol"], "reason": "sin factores suficientes"}
                    )
                    continue
                signal["context"]["sector_key"] = key
                signal["context"]["sector_name"] = universe["name"]
                signal["sector_rank"] = signal.pop("rank", None)
                ranked.append(signal)

        unavailable.extend(scoring["unavailable"])
        momentum_source = momentum_source or scoring["momentum_source"]
        calibrated = calibrated or scoring["calibration"] is not None
        sectors_meta.append(
            {
                "key": key,
                "name": universe["name"],
                "requested": len(symbols),
                "scored": scoring["scored"],
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

    favorables = [s for s in ranked if s["score"] >= 0.35]
    desfavorables = [s for s in ranked if s["score"] <= -0.35]

    # Nombres solo para lo que se muestra destacado: pedir el perfil de las ~90
    # costaría 90 llamadas para información puramente cosmética.
    for signal in favorables[:15] + desfavorables[-10:]:
        profile = _safe_get(service, "profile", symbol=signal["symbol"])
        if profile:
            signal["context"]["name"] = profile.get("name")

    payload = {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "favorables": favorables,
        "desfavorables": list(reversed(desfavorables)),  # peor primero
        "neutrales": len(ranked) - len(favorables) - len(desfavorables),
        "all_ranked": [
            {
                "symbol": s["symbol"],
                "score": s["score"],
                "label": s["label"],
                "rank": s["rank"],
                "sector_name": s["context"].get("sector_name"),
            }
            for s in ranked
        ],
        "sectors": sectors_meta,
        "scored": len(ranked),
        "requested": requested,
        "unavailable": unavailable,
        "calibrated": calibrated,
        "momentum_source": momentum_source,
        "note": (
            f"Puntuadas {len(ranked)} empresas de {requested} en "
            f"{sum(1 for s in sectors_meta if s['usable'])} sectores. Cada empresa "
            "se compara con las de su propio sector, no con el mercado entero."
        ),
        "disclaimer": (
            "Esto NO es una lista de compra. 'Favorable' significa que la "
            "empresa puntúa mejor que sus comparables del sector en valor, "
            "calidad y momentum — no que vaya a subir, ni que te convenga a ti: "
            "eso depende de tu cartera, tu horizonte y tu tolerancia al riesgo. "
            "Úsala para decidir qué mirar primero, no qué comprar."
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

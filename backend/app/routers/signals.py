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
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import LlmOutput
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

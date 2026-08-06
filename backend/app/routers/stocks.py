from __future__ import annotations

import re
from datetime import datetime, timezone

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from app.analysis.fundamentals import (
    derive_ratio_series,
    free_cash_flow,
    growth_summary,
    total_debt,
)
from app.analysis.health import health_snapshot
from app.analysis.indicators import macd, rsi, sma
from app.analysis.risk import annualized_volatility, beta, daily_returns, max_drawdown
from app.analysis.valuation import dcf, scenario_set, sensitivity_grid
from app.cache.cache import MarketDataService
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError
from app.schemas.market import (
    DcfRequest,
    FundamentalsResponse,
    HistoryResponse,
    ProfileResponse,
    QuoteResponse,
)

router = APIRouter(prefix="/api/stocks", tags=["stocks"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")

# range -> (intervalo, nº de barras). 5A/10A usan barras semanales para
# mantener el payload razonable; los indicadores se calculan sobre el
# intervalo mostrado (convención de las plataformas de charting).
_RANGES: dict[str, tuple[str, int]] = {
    "1M": ("1day", 22),
    "3M": ("1day", 66),
    "6M": ("1day", 130),
    "1Y": ("1day", 252),
    "5Y": ("1week", 261),
    "10Y": ("1week", 522),
}


def _validate_symbol(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail=f"Símbolo inválido: {symbol}")
    return symbol.upper()


def _fetch(service: MarketDataService, data_type: str, **kwargs) -> dict:
    try:
        return service.get(data_type, **kwargs)
    except DataNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AllProvidersFailedError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _nan_to_none(series: pd.Series) -> list[float | None]:
    return [None if pd.isna(v) else round(float(v), 4) for v in series]


@router.get("/{symbol}/quote", response_model=QuoteResponse)
def get_quote(symbol: str, service: MarketDataService = Depends(get_service)):
    return _fetch(service, "quote", symbol=_validate_symbol(symbol))


@router.get("/{symbol}/profile", response_model=ProfileResponse)
def get_profile(symbol: str, service: MarketDataService = Depends(get_service)):
    return _fetch(service, "profile", symbol=_validate_symbol(symbol))


@router.get("/{symbol}/fundamentals", response_model=FundamentalsResponse)
def get_fundamentals(symbol: str, service: MarketDataService = Depends(get_service)):
    return _fetch(service, "fundamentals", symbol=_validate_symbol(symbol))


@router.get("/{symbol}/history", response_model=HistoryResponse)
def get_history(
    symbol: str,
    range: str = Query("1Y", pattern="^(1M|3M|6M|YTD|1Y|5Y|10Y)$"),
    service: MarketDataService = Depends(get_service),
):
    symbol = _validate_symbol(symbol)
    if range == "YTD":
        days = (datetime.now(timezone.utc) - datetime(
            datetime.now(timezone.utc).year, 1, 1, tzinfo=timezone.utc
        )).days
        interval, outputsize = "1day", max(int(days * 5 / 7), 5)
    else:
        interval, outputsize = _RANGES[range]

    payload = _fetch(
        service, "price_history", symbol=symbol, interval=interval, outputsize=outputsize
    )

    closes = pd.Series([bar["close"] for bar in payload["bars"]], dtype="float64")
    macd_df = macd(closes)
    payload["range"] = range
    payload["indicators"] = {
        "sma20": _nan_to_none(sma(closes, 20)),
        "sma50": _nan_to_none(sma(closes, 50)),
        "sma200": _nan_to_none(sma(closes, 200)),
        "rsi14": _nan_to_none(rsi(closes, 14)),
        "macd": {
            "macd": _nan_to_none(macd_df["macd"]),
            "signal": _nan_to_none(macd_df["signal"]),
            "histogram": _nan_to_none(macd_df["histogram"]),
        },
    }
    return payload


# ---------------------------------------------------------------------------
# Fase 2: estados financieros, salud, valoración, pares, riesgo, filings
# ---------------------------------------------------------------------------


@router.get("/{symbol}/financials")
def get_financials(symbol: str, service: MarketDataService = Depends(get_service)):
    """Estados financieros anuales (EDGAR) + ratios derivados + crecimiento.

    Una sola descarga cacheada 24 h alimenta todo el análisis fundamental:
    es la vía barata en créditos de API.
    """
    payload = _fetch(service, "financials", symbol=_validate_symbol(symbol))
    payload["ratios"] = derive_ratio_series(payload["periods"])
    payload["growth"] = growth_summary(payload["periods"])
    return payload


@router.get("/{symbol}/health")
def get_health(symbol: str, service: MarketDataService = Depends(get_service)):
    """Altman Z, Piotroski F y cobertura de intereses, con desglose completo."""
    symbol = _validate_symbol(symbol)
    financials = _fetch(service, "financials", symbol=symbol)
    market_cap = None
    try:
        market_cap = service.get("profile", symbol=symbol).get("market_cap")
    except (DataNotFoundError, AllProvidersFailedError):
        pass  # sin market cap, el Z-score reporta el componente faltante
    snapshot = health_snapshot(financials["periods"], market_cap)
    snapshot.update(
        {
            "symbol": symbol,
            "source": financials["source"],
            "as_of": financials["as_of"],
            "cached": financials.get("cached", False),
            "market_cap_used": market_cap,
        }
    )
    return snapshot


@router.get("/{symbol}/valuation/defaults")
def get_valuation_defaults(symbol: str, service: MarketDataService = Depends(get_service)):
    """Valores de partida para el DCF, derivados de datos reales (EDGAR +
    cotización cacheada). Son un punto de arranque editable, no una
    recomendación."""
    symbol = _validate_symbol(symbol)
    financials = _fetch(service, "financials", symbol=symbol)
    periods = financials["periods"]
    latest = periods[-1]
    growth = growth_summary(periods)

    price = None
    try:
        price = service.get("quote", symbol=symbol).get("price")
    except (DataNotFoundError, AllProvidersFailedError):
        pass

    fcf = free_cash_flow(latest)
    debt = total_debt(latest)
    suggested_growth = growth.get("fcf_cagr") or growth.get("revenue_cagr")
    if suggested_growth is not None:
        # El pasado no se extrapola alegremente: se acota a [0 %, 15 %].
        suggested_growth = max(0.0, min(suggested_growth, 0.15))
    return {
        "symbol": symbol,
        "source": financials["source"],
        "as_of": financials["as_of"],
        "cached": financials.get("cached", False),
        "base_fcf": fcf,
        "net_debt": (debt - (latest.get("cash") or 0.0)) if debt is not None else None,
        "shares_outstanding": latest.get("shares_outstanding"),
        "historical_growth": growth,
        "suggested_growth_capped": suggested_growth,
        "current_price": price,
        "fiscal_year": latest.get("fiscal_year"),
        "note": (
            "Punto de partida calculado desde estados financieros reales; "
            "edita cada supuesto según tu propia tesis."
        ),
    }


@router.post("/{symbol}/valuation/dcf")
def post_dcf(
    symbol: str,
    request: DcfRequest = Body(...),
    service: MarketDataService = Depends(get_service),
):
    """Ejecuta el DCF con TUS supuestos. Cálculo 100 % local: no gasta APIs.

    Devuelve escenarios bajista/base/alcista + matriz de sensibilidad, nunca
    un único número.
    """
    symbol = _validate_symbol(symbol)
    try:
        scenarios = scenario_set(
            {
                name: sc.model_dump()
                for name, sc in request.scenarios.items()
            },
            base_fcf=request.base_fcf,
            years=request.years,
            net_debt=request.net_debt,
            shares_outstanding=request.shares_outstanding,
        )
        base = request.scenarios.get("base")
        sensitivity = (
            sensitivity_grid(
                base_fcf=request.base_fcf,
                growth_rate=base.growth_rate,
                discount_rate=base.discount_rate,
                terminal_growth=base.terminal_growth,
                years=request.years,
                net_debt=request.net_debt,
                shares_outstanding=request.shares_outstanding,
            )
            if base
            else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    price = None
    try:
        price = service.get("quote", symbol=symbol).get("price")
    except (DataNotFoundError, AllProvidersFailedError):
        pass
    return {
        "symbol": symbol,
        "scenarios": scenarios,
        "sensitivity": sensitivity,
        "current_price": price,
        "computed_by": "app",  # calculado con datos, no generado por LLM
    }


@router.get("/{symbol}/peers")
def get_peers(symbol: str, service: MarketDataService = Depends(get_service)):
    """Comparativa contra pares del sector con percentiles.

    Coste acotado: máx. 6 pares, fundamentales cacheados 24 h y lista de
    pares cacheada 7 días.
    """
    symbol = _validate_symbol(symbol)
    peers_payload = _fetch(service, "peers", symbol=symbol)
    peer_symbols = peers_payload["peers"][:6]

    rows = []
    target_metrics = None
    for sym in [symbol, *peer_symbols]:
        try:
            fund = service.get("fundamentals", symbol=sym)
        except (DataNotFoundError, AllProvidersFailedError):
            continue
        row = {"symbol": sym, "metrics": fund["metrics"], "source": fund["source"]}
        rows.append(row)
        if sym == symbol:
            target_metrics = fund["metrics"]

    comparison_keys = [
        "pe_ttm", "pb", "ps_ttm", "roe", "operating_margin", "net_margin",
        "debt_to_equity", "dividend_yield", "revenue_growth_5y", "beta",
    ]
    percentiles = {}
    if target_metrics:
        for key in comparison_keys:
            values = [
                r["metrics"].get(key) for r in rows if r["metrics"].get(key) is not None
            ]
            target = target_metrics.get(key)
            if target is None or len(values) < 3:
                percentiles[key] = None
                continue
            below = sum(1 for v in values if v <= target)
            percentiles[key] = round(below / len(values) * 100)
    return {
        "symbol": symbol,
        "peers": rows,
        "percentiles": percentiles,
        "comparison_keys": comparison_keys,
        "source": peers_payload["source"],
        "as_of": peers_payload["as_of"],
        "cached": peers_payload.get("cached", False),
        "note": "Percentil = % de la muestra (empresa + pares) con valor ≤ al de la empresa.",
    }


@router.get("/{symbol}/risk")
def get_risk(symbol: str, service: MarketDataService = Depends(get_service)):
    """Beta vs. SPY, volatilidad anualizada y máximo drawdown (1 año).

    Reutiliza el histórico ya cacheado del gráfico: coste marginal cero.
    """
    symbol = _validate_symbol(symbol)
    history = _fetch(service, "price_history", symbol=symbol, interval="1day", outputsize=252)
    closes = pd.Series(
        [b["close"] for b in history["bars"]],
        index=[b["ts"][:10] for b in history["bars"]],
    )
    returns = daily_returns(closes)

    beta_value = None
    benchmark = "SPY"
    try:
        bench = service.get("price_history", symbol=benchmark, interval="1day", outputsize=252)
        bench_closes = pd.Series(
            [b["close"] for b in bench["bars"]],
            index=[b["ts"][:10] for b in bench["bars"]],
        )
        beta_value = beta(returns, daily_returns(bench_closes))
    except (DataNotFoundError, AllProvidersFailedError):
        pass

    return {
        "symbol": symbol,
        "window": "1Y (barras diarias)",
        "beta_vs_spy": beta_value,
        "annualized_volatility": annualized_volatility(returns),
        "max_drawdown": max_drawdown(closes),
        "source": history["source"],
        "as_of": history["as_of"],
        "cached": history.get("cached", False),
    }


@router.get("/{symbol}/filings")
def get_filings(symbol: str, service: MarketDataService = Depends(get_service)):
    """Filings recientes (10-K/10-Q/8-K...) y filings de insiders (Forms 3/4/5)
    con enlace directo a EDGAR."""
    return _fetch(service, "filings", symbol=_validate_symbol(symbol))

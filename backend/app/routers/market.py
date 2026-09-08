"""Dashboard de mercado: índices, sectores, curva de rendimientos, macro y
calendario de resultados.

Estrategia de créditos: los índices y sectores usan ETFs proxy cotizados en
EE. UU. (los cubre el tier gratuito de Finnhub y se cachean 1 min); lo macro
sale de FRED (gratis, TTL 24 h). El VIX solo existe en yfinance (^VIX), por
eso fuerza `_order`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.cache.cache import MarketDataService
from app.deps import get_service
from app.providers.base import DataNotFoundError, ProviderError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/market", tags=["market"])

# Índices vía ETF proxy: cotizables con el tier gratuito de Finnhub.
INDEX_PROXIES = [
    ("SPY", "S&P 500 (SPY)"),
    ("QQQ", "Nasdaq 100 (QQQ)"),
    ("DIA", "Dow Jones (DIA)"),
    ("IWM", "Russell 2000 (IWM)"),
    ("XIU.TO", "TSX 60 (XIU)"),
    ("^VIX", "VIX"),
]

SECTOR_ETFS = [
    ("XLK", "Tecnología"),
    ("XLF", "Financiero"),
    ("XLV", "Salud"),
    ("XLE", "Energía"),
    ("XLI", "Industriales"),
    ("XLY", "Consumo discrecional"),
    ("XLP", "Consumo básico"),
    ("XLU", "Utilities"),
    ("XLB", "Materiales"),
    ("XLRE", "Inmobiliario"),
    ("XLC", "Comunicaciones"),
]

YIELD_TENORS = [
    ("DGS1MO", "1M"),
    ("DGS3MO", "3M"),
    ("DGS6MO", "6M"),
    ("DGS1", "1A"),
    ("DGS2", "2A"),
    ("DGS5", "5A"),
    ("DGS10", "10A"),
    ("DGS30", "30A"),
]

MACRO_SERIES = [
    ("UNRATE", "Desempleo EE. UU.", "pct"),
    ("FEDFUNDS", "Tasa Fed (efectiva)", "pct"),
    ("CPIAUCSL", "Inflación (CPI, interanual)", "yoy"),
]


def _quote_or_none(service: MarketDataService, symbol: str) -> dict | None:
    kwargs: dict = {"symbol": symbol}
    if symbol.startswith("^"):
        kwargs["_order"] = ["yfinance"]  # índices puros: solo yfinance los sirve
    try:
        return service.get("quote", **kwargs)
    except (DataNotFoundError, AllProvidersFailedError, ProviderError):
        return None


@router.get("/overview")
def market_overview(service: MarketDataService = Depends(get_service)):
    return {
        "indices": [
            {"symbol": symbol, "label": label, "quote": _quote_or_none(service, symbol)}
            for symbol, label in INDEX_PROXIES
        ]
    }


@router.get("/sectors")
def sector_performance(service: MarketDataService = Depends(get_service)):
    """Rendimiento del día por sector (ETFs SPDR como proxy)."""
    sectors = []
    for symbol, label in SECTOR_ETFS:
        quote = _quote_or_none(service, symbol)
        sectors.append(
            {
                "symbol": symbol,
                "label": label,
                "change_pct": quote.get("change_pct") if quote else None,
                "quote": quote,
            }
        )
    sectors.sort(key=lambda s: s["change_pct"] if s["change_pct"] is not None else -999, reverse=True)
    return {"sectors": sectors, "note": "Proxy: ETFs SPDR sectoriales; variación del día."}


@router.get("/yield-curve")
def yield_curve(service: MarketDataService = Depends(get_service)):
    """Curva de rendimientos del Tesoro EE. UU. (FRED, TTL 24 h) y spread 10A-2A."""
    start = (datetime.now(timezone.utc) - timedelta(days=14)).date().isoformat()
    curve = []
    for series_id, tenor in YIELD_TENORS:
        value = ts = None
        try:
            payload = service.get("macro", series_id=series_id, start=start)
            valid = [p for p in payload["points"] if p["value"] is not None]
            if valid:
                value, ts = valid[-1]["value"], valid[-1]["ts"]
        except (DataNotFoundError, AllProvidersFailedError):
            pass
        curve.append({"tenor": tenor, "series_id": series_id, "value": value, "ts": ts})

    spread = None
    spread_series: list[dict] = []
    try:
        year_ago = (datetime.now(timezone.utc) - timedelta(days=365)).date().isoformat()
        payload = service.get("macro", series_id="T10Y2Y", start=year_ago)
        spread_series = [p for p in payload["points"] if p["value"] is not None]
        if spread_series:
            spread = spread_series[-1]["value"]
    except (DataNotFoundError, AllProvidersFailedError):
        pass
    return {
        "curve": curve,
        "spread_10y_2y": spread,
        "spread_series": spread_series,
        "source": "fred",
        "note": "Un spread 10A-2A negativo = curva invertida (históricamente precede recesiones, no las garantiza).",
    }


@router.get("/macro")
def macro_indicators(service: MarketDataService = Depends(get_service)):
    """Indicadores macro básicos desde FRED (TTL 24 h)."""
    start = (datetime.now(timezone.utc) - timedelta(days=750)).date().isoformat()
    out = []
    for series_id, label, kind in MACRO_SERIES:
        try:
            payload = service.get("macro", series_id=series_id, start=start)
        except (DataNotFoundError, AllProvidersFailedError):
            out.append({"series_id": series_id, "label": label, "value": None, "ts": None})
            continue
        valid = [p for p in payload["points"] if p["value"] is not None]
        if not valid:
            out.append({"series_id": series_id, "label": label, "value": None, "ts": None})
            continue
        latest = valid[-1]
        if kind == "yoy":
            # CPI llega como índice: la cifra útil es la variación interanual.
            base = next((p for p in reversed(valid) if p["ts"] <= _year_before(latest["ts"])), None)
            value = (
                (latest["value"] / base["value"] - 1) * 100 if base and base["value"] else None
            )
        else:
            value = latest["value"]
        out.append({"series_id": series_id, "label": label, "value": value, "ts": latest["ts"]})
    return {"indicators": out, "source": "fred"}


def _year_before(iso_date: str) -> str:
    dt = datetime.fromisoformat(iso_date)
    return dt.replace(year=dt.year - 1).date().isoformat()


@router.get("/calendar")
def earnings_calendar(service: MarketDataService = Depends(get_service)):
    """Próximos resultados (14 días), cacheado 12 h."""
    today = datetime.now(timezone.utc).date()
    try:
        payload = service.get(
            "earnings_calendar",
            start=today.isoformat(),
            end=(today + timedelta(days=14)).isoformat(),
        )
    except (DataNotFoundError, AllProvidersFailedError) as exc:
        return {"events": [], "error": str(exc)}
    events = sorted(payload["events"], key=lambda e: (e["date"] or "", e["symbol"] or ""))
    return {
        "events": events[:120],
        "source": payload["source"],
        "as_of": payload["as_of"],
        "cached": payload.get("cached", False),
    }

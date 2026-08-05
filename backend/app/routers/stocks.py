from __future__ import annotations

import re
from datetime import datetime, timezone

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query

from app.analysis.indicators import macd, rsi, sma
from app.cache.cache import MarketDataService
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError
from app.schemas.market import (
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

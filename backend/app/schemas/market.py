"""Modelos de respuesta del API interno.

Regla no negociable de la app: toda cifra sale con `source`, `as_of` y
estado de caché (`cached`, `fetched_at`). La UI decide cómo mostrarlo, pero
el backend nunca entrega un número sin origen ni fecha.
"""

from __future__ import annotations

from pydantic import BaseModel


class Sourced(BaseModel):
    source: str
    as_of: str
    cached: bool = False
    fetched_at: str | None = None


class QuoteResponse(Sourced):
    symbol: str
    price: float
    change: float | None = None
    change_pct: float | None = None
    prev_close: float | None = None
    day_high: float | None = None
    day_low: float | None = None
    day_open: float | None = None
    currency: str | None = None
    freshness: str  # live | delayed | prev_close (o cached=True encima)


class Bar(BaseModel):
    ts: str
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None


class MacdSeries(BaseModel):
    macd: list[float | None]
    signal: list[float | None]
    histogram: list[float | None]


class IndicatorBundle(BaseModel):
    """Indicadores calculados por nosotros a partir de los datos (no LLM)."""

    sma20: list[float | None]
    sma50: list[float | None]
    sma200: list[float | None]
    rsi14: list[float | None]
    macd: MacdSeries


class HistoryResponse(Sourced):
    symbol: str
    interval: str
    range: str
    currency: str | None = None
    bars: list[Bar]
    indicators: IndicatorBundle


class ProfileResponse(Sourced):
    symbol: str
    name: str | None = None
    exchange: str | None = None
    sector: str | None = None
    industry: str | None = None
    market_cap: float | None = None
    currency: str | None = None
    country: str | None = None
    ipo: str | None = None
    website: str | None = None


class FundamentalsResponse(Sourced):
    symbol: str
    period: str
    metrics: dict[str, float | None]


class ProviderUsage(BaseModel):
    provider: str
    configured: bool
    limit: int
    window_seconds: int
    used: int
    remaining: int

"""Proveedor Finnhub (https://finnhub.io/docs/api).

Tier gratuito verificado (2026): ~60 llamadas/min. Cotizaciones en tiempo
real para acciones de EE. UU., perfil de empresa y métricas fundamentales
básicas. OJO: el endpoint de velas (/stock/candle) dejó de ser gratuito en
2024 — el histórico de precios NO se pide aquí, lo cubren Twelve Data y
yfinance (ver router.py).
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from app.providers.base import (
    BASIC_FUNDAMENTAL_KEYS,
    DataNotFoundError,
    DataProvider,
    ProviderError,
    RateLimitError,
    iso_utc,
)

BASE_URL = "https://finnhub.io/api/v1"

# Mapa nombre-Finnhub -> clave normalizada de la app.
_METRIC_MAP = {
    "marketCapitalization": "market_cap",  # en millones; se convierte abajo
    "peTTM": "pe_ttm",
    "pb": "pb",
    "psTTM": "ps_ttm",
    "roeTTM": "roe",
    "grossMarginTTM": "gross_margin",
    "operatingMarginTTM": "operating_margin",
    "netProfitMarginTTM": "net_margin",
    "totalDebt/totalEquityQuarterly": "debt_to_equity",
    "currentRatioQuarterly": "current_ratio",
    "dividendYieldIndicatedAnnual": "dividend_yield",
    "epsGrowth5Y": "eps_growth_5y",
    "revenueGrowth5Y": "revenue_growth_5y",
    "beta": "beta",
    "52WeekHigh": "week52_high",
    "52WeekLow": "week52_low",
}


class FinnhubProvider(DataProvider):
    name = "finnhub"
    capabilities = frozenset({"quote", "profile", "fundamentals"})

    def __init__(self, api_key: str, timeout: float = 10.0):
        self.api_key = api_key
        self.timeout = timeout

    def _get(self, path: str, params: dict) -> dict:
        try:
            resp = httpx.get(
                f"{BASE_URL}{path}",
                params={**params, "token": self.api_key},
                timeout=self.timeout,
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"finnhub: error de red: {exc}") from exc
        if resp.status_code == 429:
            raise RateLimitError("finnhub: rate limit alcanzado")
        if resp.status_code in (401, 403):
            raise ProviderError("finnhub: API key inválida o sin permiso")
        if resp.status_code != 200:
            raise ProviderError(f"finnhub: HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError as exc:
            raise ProviderError("finnhub: respuesta no es JSON") from exc

    def get_quote(self, symbol: str) -> dict:
        data = self._get("/quote", {"symbol": symbol})
        # Finnhub devuelve ceros para símbolos inexistentes.
        if not data or (data.get("c") in (0, None) and data.get("pc") in (0, None)):
            raise DataNotFoundError(f"finnhub: sin cotización para {symbol}")
        as_of = (
            datetime.fromtimestamp(data["t"], tz=timezone.utc)
            if data.get("t")
            else datetime.now(timezone.utc)
        )
        return {
            "symbol": symbol.upper(),
            "price": data.get("c"),
            "change": data.get("d"),
            "change_pct": data.get("dp"),
            "prev_close": data.get("pc"),
            "day_high": data.get("h"),
            "day_low": data.get("l"),
            "day_open": data.get("o"),
            "currency": None,  # /quote no lo incluye; el perfil sí
            "as_of": iso_utc(as_of),
            "freshness": "live",
        }

    def get_profile(self, symbol: str) -> dict:
        data = self._get("/stock/profile2", {"symbol": symbol})
        if not data:
            raise DataNotFoundError(f"finnhub: sin perfil para {symbol}")
        market_cap = data.get("marketCapitalization")
        return {
            "symbol": symbol.upper(),
            "name": data.get("name"),
            "exchange": data.get("exchange"),
            "sector": data.get("finnhubIndustry"),
            "industry": data.get("finnhubIndustry"),
            "market_cap": market_cap * 1e6 if market_cap else None,
            "currency": data.get("currency"),
            "country": data.get("country"),
            "ipo": data.get("ipo"),
            "website": data.get("weburl"),
            "as_of": iso_utc(),
        }

    def get_fundamentals(self, symbol: str) -> dict:
        data = self._get("/stock/metric", {"symbol": symbol, "metric": "all"})
        raw = data.get("metric") or {}
        if not raw:
            raise DataNotFoundError(f"finnhub: sin fundamentales para {symbol}")
        metrics: dict[str, float | None] = {k: None for k in BASIC_FUNDAMENTAL_KEYS}
        for finnhub_key, our_key in _METRIC_MAP.items():
            value = raw.get(finnhub_key)
            if value is None:
                continue
            if our_key == "market_cap":
                value = value * 1e6  # Finnhub la reporta en millones USD
            # Finnhub da márgenes/ROE/crecimientos en porcentaje; normalizamos
            # a fracción para que toda la app hable la misma unidad.
            if our_key in {
                "roe",
                "gross_margin",
                "operating_margin",
                "net_margin",
                "dividend_yield",
                "eps_growth_5y",
                "revenue_growth_5y",
            }:
                value = value / 100.0
            metrics[our_key] = value
        return {
            "symbol": symbol.upper(),
            "period": "ttm",
            "metrics": metrics,
            "as_of": iso_utc(),
        }

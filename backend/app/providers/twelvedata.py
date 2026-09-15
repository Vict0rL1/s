"""Proveedor Twelve Data (https://twelvedata.com/docs).

Tier gratuito verificado (2026): ~800 créditos/día y 8 llamadas/min. Fuente
primaria del histórico de precios (Finnhub ya no da velas gratis). Las
cotizaciones del tier gratuito llegan con retraso de ~15 min, por eso se
marcan como freshness="delayed".
"""

from __future__ import annotations

import httpx

from app.providers.base import (
    DataNotFoundError,
    DataProvider,
    ProviderError,
    RateLimitError,
    iso_utc,
)

BASE_URL = "https://api.twelvedata.com"


class TwelveDataProvider(DataProvider):
    name = "twelvedata"
    capabilities = frozenset({"quote", "price_history"})

    def __init__(self, api_key: str, timeout: float = 15.0):
        self.api_key = api_key
        self.timeout = timeout

    def _get(self, path: str, params: dict) -> dict:
        try:
            resp = httpx.get(
                f"{BASE_URL}{path}",
                params={**params, "apikey": self.api_key},
                timeout=self.timeout,
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"twelvedata: error de red: {exc}") from exc
        if resp.status_code == 429:
            raise RateLimitError("twelvedata: rate limit alcanzado")
        if resp.status_code != 200:
            raise ProviderError(f"twelvedata: HTTP {resp.status_code}")
        data = resp.json()
        # Twelve Data devuelve errores como 200 con status="error" en el body.
        if isinstance(data, dict) and data.get("status") == "error":
            code = data.get("code")
            message = data.get("message", "")
            if code == 429:
                raise RateLimitError(f"twelvedata: {message}")
            if code in (400, 404) and "not found" in message.lower():
                raise DataNotFoundError(f"twelvedata: {message}")
            raise ProviderError(f"twelvedata: {message or code}")
        return data

    def get_quote(self, symbol: str) -> dict:
        data = self._get("/quote", {"symbol": symbol})
        if not data.get("close"):
            raise DataNotFoundError(f"twelvedata: sin cotización para {symbol}")
        price = float(data["close"])
        prev = float(data["previous_close"]) if data.get("previous_close") else None
        return {
            "symbol": symbol.upper(),
            "price": price,
            "change": float(data["change"]) if data.get("change") else None,
            "change_pct": float(data["percent_change"]) if data.get("percent_change") else None,
            "prev_close": prev,
            "day_high": float(data["high"]) if data.get("high") else None,
            "day_low": float(data["low"]) if data.get("low") else None,
            "day_open": float(data["open"]) if data.get("open") else None,
            "currency": data.get("currency"),
            "as_of": iso_utc(),
            "freshness": "delayed",  # tier gratuito: ~15 min de retraso
        }

    def get_price_history(self, symbol: str, interval: str, outputsize: int) -> dict:
        data = self._get(
            "/time_series",
            {
                "symbol": symbol,
                "interval": interval,
                "outputsize": min(outputsize, 5000),
                "order": "ASC",
                "timezone": "UTC",
            },
        )
        values = data.get("values")
        if not values:
            raise DataNotFoundError(f"twelvedata: sin histórico para {symbol}")
        bars = [
            {
                "ts": row["datetime"],
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]) if row.get("volume") else None,
            }
            for row in values
        ]
        return {
            "symbol": symbol.upper(),
            "interval": interval,
            "currency": (data.get("meta") or {}).get("currency"),
            "bars": bars,
            "as_of": iso_utc(),
        }

"""Proveedor FRED — St. Louis Fed (https://fred.stlouisfed.org/docs/api/fred/).

Gratis con key, muy fiable. Fuente de todo lo macro: tasas, curva de
rendimientos, inflación, desempleo. TTL de 24 h: los datos macro se publican
a diario como mucho, refrescar más a menudo solo quema llamadas.
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

BASE_URL = "https://api.stlouisfed.org/fred/series/observations"


class FredProvider(DataProvider):
    name = "fred"
    capabilities = frozenset({"macro"})

    def __init__(self, api_key: str, timeout: float = 15.0):
        self.api_key = api_key
        self.timeout = timeout

    def get_macro(self, series_id: str, start: str) -> dict:
        try:
            resp = httpx.get(
                BASE_URL,
                params={
                    "series_id": series_id,
                    "api_key": self.api_key,
                    "file_type": "json",
                    "observation_start": start,
                },
                timeout=self.timeout,
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"fred: error de red: {exc}") from exc
        if resp.status_code == 429:
            raise RateLimitError("fred: rate limit alcanzado")
        if resp.status_code == 400:
            raise DataNotFoundError(f"fred: serie desconocida {series_id}")
        if resp.status_code != 200:
            raise ProviderError(f"fred: HTTP {resp.status_code}")
        observations = resp.json().get("observations") or []
        if not observations:
            raise DataNotFoundError(f"fred: sin observaciones para {series_id}")
        points = [
            {
                "ts": obs["date"],
                # FRED marca los huecos con "."; se conservan como None.
                "value": float(obs["value"]) if obs.get("value") not in (".", None) else None,
            }
            for obs in observations
        ]
        return {"series_id": series_id, "points": points, "as_of": iso_utc()}

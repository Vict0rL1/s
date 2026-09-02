"""Contrato común de todos los proveedores de datos externos.

Cada API (Finnhub, Twelve Data, yfinance, EDGAR, FRED...) se implementa como
una subclase de `DataProvider`. Si una API cambia o muere, solo se reemplaza
esa clase; el resto de la app no se entera.

Los métodos devuelven dicts normalizados y JSON-serializables (fechas en ISO
8601 UTC) para que la capa de caché pueda persistirlos tal cual. El router de
fuentes (`router.py`) es quien añade `source` y decide el orden y el fallback.
"""

from __future__ import annotations

from abc import ABC
from datetime import datetime, timezone


class ProviderError(Exception):
    """Fallo genérico de un proveedor (red, respuesta inválida...)."""


class RateLimitError(ProviderError):
    """El proveedor devolvió un rate limit; el router debe pasar al siguiente."""


class DataNotFoundError(ProviderError):
    """El símbolo o dato pedido no existe en este proveedor."""


class NotSupportedError(ProviderError):
    """El proveedor no ofrece este tipo de dato."""


def iso_utc(dt: datetime | None = None) -> str:
    return (dt or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()


# Claves normalizadas de fundamentales básicos (Fase 1). Cada proveedor mapea
# sus nombres propios a estas claves; un valor ausente se reporta como None,
# nunca se inventa.
BASIC_FUNDAMENTAL_KEYS = [
    "market_cap",
    "pe_ttm",
    "pb",
    "ps_ttm",
    "roe",
    "gross_margin",
    "operating_margin",
    "net_margin",
    "debt_to_equity",
    "current_ratio",
    "dividend_yield",
    "eps_growth_5y",
    "revenue_growth_5y",
    "beta",
    "week52_high",
    "week52_low",
]


class DataProvider(ABC):
    """Interfaz base. `capabilities` declara qué tipos de dato ofrece."""

    name: str = "base"
    capabilities: frozenset[str] = frozenset()

    def get_quote(self, symbol: str) -> dict:
        """-> {symbol, price, change, change_pct, prev_close, currency,
        as_of, freshness('live'|'delayed'|'prev_close')}"""
        raise NotSupportedError(f"{self.name} no ofrece cotizaciones")

    def get_price_history(self, symbol: str, interval: str, outputsize: int) -> dict:
        """-> {symbol, interval, bars: [{ts, open, high, low, close, volume}]}
        con las barras en orden cronológico ascendente."""
        raise NotSupportedError(f"{self.name} no ofrece histórico de precios")

    def get_profile(self, symbol: str) -> dict:
        """-> {symbol, name, exchange, sector, industry, market_cap, currency}"""
        raise NotSupportedError(f"{self.name} no ofrece perfil de empresa")

    def get_fundamentals(self, symbol: str) -> dict:
        """-> {symbol, period, metrics: {clave normalizada: valor|None}}"""
        raise NotSupportedError(f"{self.name} no ofrece fundamentales")

    def get_financials(self, symbol: str) -> dict:
        """Estados financieros anuales -> {symbol, periods: [{fiscal_year,
        end_date, revenue, net_income, ...}]} en orden cronológico."""
        raise NotSupportedError(f"{self.name} no ofrece estados financieros")

    def get_filings(self, symbol: str) -> dict:
        """-> {symbol, filings: [{type, filed_at, accession_no, url}]}"""
        raise NotSupportedError(f"{self.name} no ofrece filings")

    def get_filing_document(self, url: str) -> dict:
        """El texto de UN filing concreto -> {url, html}.

        `get_filings` da la lista y sus URLs; esto trae el documento en sí.
        """
        raise NotSupportedError(f"{self.name} no descarga documentos de filings")

    def get_macro(self, series_id: str, start: str) -> dict:
        """-> {series_id, points: [{ts, value|None}]}"""
        raise NotSupportedError(f"{self.name} no ofrece series macro")

    def get_news(self, symbol: str | None, days: int) -> dict:
        """-> {items: [{headline, summary, url, published_at, source, related}]}"""
        raise NotSupportedError(f"{self.name} no ofrece noticias")

    def get_earnings_calendar(self, start: str, end: str) -> dict:
        """-> {events: [{symbol, date, hour, eps_estimate, ...}]}"""
        raise NotSupportedError(f"{self.name} no ofrece calendario de resultados")

    def get_peers(self, symbol: str) -> dict:
        """-> {symbol, peers: [str]}"""
        raise NotSupportedError(f"{self.name} no ofrece pares del sector")

    def get_etf_data(self, symbol: str) -> dict:
        """-> {symbol, holdings, sector_weights, expense_ratio, aum, ...}"""
        raise NotSupportedError(f"{self.name} no ofrece datos de ETFs")

    def get_bulk_momentum(self, symbols: list[str]) -> dict:
        """Momentum 12-1 de varios símbolos de una vez -> {momentum: {sym: v}}"""
        raise NotSupportedError(f"{self.name} no ofrece momentum masivo")

    def fetch(self, data_type: str, **kwargs) -> dict:
        dispatch = {
            "quote": self.get_quote,
            "price_history": self.get_price_history,
            "profile": self.get_profile,
            "fundamentals": self.get_fundamentals,
            "financials": self.get_financials,
            "filings": self.get_filings,
            "filing_document": self.get_filing_document,
            "macro": self.get_macro,
            "news": self.get_news,
            "earnings_calendar": self.get_earnings_calendar,
            "peers": self.get_peers,
            "etf_data": self.get_etf_data,
            "bulk_momentum": self.get_bulk_momentum,
        }
        if data_type not in dispatch:
            raise NotSupportedError(f"Tipo de dato desconocido: {data_type}")
        return dispatch[data_type](**kwargs)

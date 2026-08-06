"""Ensamblaje de la aplicación: proveedores, router de fuentes, caché.

Un solo lugar construye el grafo de objetos; los endpoints lo reciben por
inyección de dependencias de FastAPI.
"""

from __future__ import annotations

from functools import lru_cache

from app.cache.cache import CacheStore, MarketDataService
from app.config import settings
from app.db.engine import SessionLocal
from app.providers.base import DataProvider
from app.providers.edgar import EdgarProvider
from app.providers.finnhub import FinnhubProvider
from app.providers.fred import FredProvider
from app.providers.router import DataRouter, RateLimiter
from app.providers.twelvedata import TwelveDataProvider
from app.providers.yfinance_provider import YFinanceProvider


def build_providers() -> dict[str, DataProvider]:
    providers: dict[str, DataProvider] = {}
    if settings.finnhub_api_key:
        providers["finnhub"] = FinnhubProvider(settings.finnhub_api_key)
    if settings.twelvedata_api_key:
        providers["twelvedata"] = TwelveDataProvider(settings.twelvedata_api_key)
    if settings.edgar_user_agent:
        providers["edgar"] = EdgarProvider(settings.edgar_user_agent)
    if settings.fred_api_key:
        providers["fred"] = FredProvider(settings.fred_api_key)
    # yfinance no necesita key; siempre disponible como respaldo.
    providers["yfinance"] = YFinanceProvider()
    return providers


@lru_cache(maxsize=1)
def get_service() -> MarketDataService:
    limiter = RateLimiter(SessionLocal)
    router = DataRouter(build_providers(), limiter)
    cache = CacheStore(SessionLocal)
    return MarketDataService(router, cache)


@lru_cache(maxsize=1)
def get_limiter() -> RateLimiter:
    return get_service().router.limiter


@lru_cache(maxsize=1)
def _build_llm():
    if not settings.anthropic_api_key:
        return None
    from app.llm.anthropic_provider import AnthropicProvider  # import perezoso

    return AnthropicProvider(settings.anthropic_api_key, settings.anthropic_model)


def get_llm():
    """Proveedor LLM o None si no hay ANTHROPIC_API_KEY (la app funciona igual)."""
    return _build_llm()

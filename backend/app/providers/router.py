"""Router de fuentes: orden de proveedores por tipo de dato, rate limits,
backoff exponencial y fallback.

Los routers HTTP nunca llaman a un proveedor directamente: siempre pasan por
aquí (envuelto además por la capa de caché). Así, agotar el tier gratuito de
una API degrada el servicio a la siguiente fuente en vez de romper la app.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.config import PROVIDER_RATE_LIMITS
from app.db.models import ApiCallLog
from app.providers.base import (
    DataNotFoundError,
    DataProvider,
    NotSupportedError,
    ProviderError,
    RateLimitError,
)

# Orden de fuentes por tipo de dato. Finnhub no aparece en price_history
# porque su endpoint de velas dejó de ser gratuito en 2024.
DEFAULT_SOURCE_ORDER: dict[str, list[str]] = {
    "quote": ["finnhub", "twelvedata", "yfinance"],
    "price_history": ["twelvedata", "yfinance"],
    "profile": ["finnhub", "yfinance"],
    "fundamentals": ["finnhub", "yfinance"],
}

RETRY_ATTEMPTS = 2       # reintentos ante error transitorio, por proveedor
RETRY_BASE_DELAY = 1.0   # segundos; crece exponencialmente (1s, 2s)


class AllProvidersFailedError(Exception):
    def __init__(self, data_type: str, reasons: dict[str, str]):
        self.data_type = data_type
        self.reasons = reasons
        detail = "; ".join(f"{name}: {why}" for name, why in reasons.items())
        super().__init__(f"Todas las fuentes fallaron para '{data_type}' ({detail})")


class RateLimiter:
    """Controla cuántas llamadas quedan por proveedor según api_call_log."""

    def __init__(self, session_factory, limits: dict[str, tuple[int, int]] | None = None):
        self.session_factory = session_factory
        self.limits = limits or PROVIDER_RATE_LIMITS

    def usage(self, provider: str) -> dict:
        limit, window = self.limits.get(provider, (10_000, 60))
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window)
        with self.session_factory() as session:
            used = session.execute(
                select(func.count())
                .select_from(ApiCallLog)
                .where(ApiCallLog.provider == provider, ApiCallLog.called_at >= cutoff)
            ).scalar_one()
        return {
            "provider": provider,
            "limit": limit,
            "window_seconds": window,
            "used": used,
            "remaining": max(limit - used, 0),
        }

    def allow(self, provider: str) -> bool:
        return self.usage(provider)["remaining"] > 0

    def record(self, provider: str, endpoint: str, status: str = "ok") -> None:
        with self.session_factory() as session:
            session.add(ApiCallLog(provider=provider, endpoint=endpoint, status=status))
            session.commit()


class DataRouter:
    def __init__(
        self,
        providers: dict[str, DataProvider],
        limiter: RateLimiter,
        source_order: dict[str, list[str]] | None = None,
        sleep=time.sleep,
    ):
        self.providers = providers
        self.limiter = limiter
        self.source_order = source_order or DEFAULT_SOURCE_ORDER
        self._sleep = sleep  # inyectable para tests

    def fetch(self, data_type: str, **kwargs) -> dict:
        """Intenta cada fuente en orden; devuelve el payload con `source`.

        - Proveedor no configurado (sin API key) → se salta.
        - Sin llamadas restantes en la ventana → se salta sin gastar la llamada.
        - RateLimitError del propio API → se registra y se pasa a la siguiente.
        - Error transitorio → backoff exponencial y reintento acotado.
        - DataNotFoundError → se propaga: el dato no existe, no es un fallo.
        """
        reasons: dict[str, str] = {}
        for name in self.source_order.get(data_type, []):
            provider = self.providers.get(name)
            if provider is None:
                reasons[name] = "no configurado (falta API key)"
                continue
            if data_type not in provider.capabilities:
                reasons[name] = "no soporta este tipo de dato"
                continue
            if not self.limiter.allow(name):
                reasons[name] = "límite de llamadas agotado en esta ventana"
                continue

            last_error: str | None = None
            for attempt in range(RETRY_ATTEMPTS + 1):
                try:
                    payload = provider.fetch(data_type, **kwargs)
                    self.limiter.record(name, data_type, "ok")
                    payload["source"] = name
                    return payload
                except RateLimitError as exc:
                    self.limiter.record(name, data_type, "rate_limited")
                    last_error = str(exc)
                    break  # no reintentar contra un rate limit: siguiente fuente
                except DataNotFoundError:
                    self.limiter.record(name, data_type, "ok")
                    raise
                except (NotSupportedError, ProviderError) as exc:
                    self.limiter.record(name, data_type, "error")
                    last_error = str(exc)
                    if isinstance(exc, NotSupportedError) or attempt == RETRY_ATTEMPTS:
                        break
                    self._sleep(RETRY_BASE_DELAY * (2**attempt))
            reasons[name] = last_error or "error desconocido"
        raise AllProvidersFailedError(data_type, reasons)

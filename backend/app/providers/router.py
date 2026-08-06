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
# porque su endpoint de velas dejó de ser gratuito en 2024. EDGAR y FRED son
# gratuitos e ilimitados en la práctica: por eso los datos que pueden salir
# de ellos NO tienen alternativa de pago en la lista (minimizar créditos).
DEFAULT_SOURCE_ORDER: dict[str, list[str]] = {
    "quote": ["finnhub", "twelvedata", "yfinance"],
    "price_history": ["twelvedata", "yfinance"],
    "profile": ["finnhub", "yfinance"],
    "fundamentals": ["finnhub", "yfinance"],
    "financials": ["edgar"],
    "filings": ["edgar"],
    "macro": ["fred"],
    "news": ["finnhub"],
    "earnings_calendar": ["finnhub"],
    "peers": ["finnhub"],
    "etf_data": ["yfinance"],
    "bulk_momentum": ["yfinance"],
}

RETRY_ATTEMPTS = 2       # reintentos ante error transitorio, por proveedor
RETRY_BASE_DELAY = 1.0   # segundos; crece exponencialmente (1s, 2s)


class AllProvidersFailedError(Exception):
    def __init__(self, data_type: str, reasons: dict[str, str]):
        self.data_type = data_type
        self.reasons = reasons
        detail = "; ".join(f"{name}: {why}" for name, why in reasons.items())
        super().__init__(f"Todas las fuentes fallaron para '{data_type}' ({detail})")


def _normalize_windows(value) -> tuple[tuple[int, int], ...]:
    """Acepta (max, ventana) o ((max, v1), (max, v2), ...) — un proveedor
    puede tener límite por minuto Y por día a la vez (p. ej. Twelve Data)."""
    if isinstance(value[0], int):
        return (value,)
    return tuple(value)


class RateLimiter:
    """Controla cuántas llamadas quedan por proveedor según api_call_log."""

    def __init__(self, session_factory, limits: dict | None = None):
        self.session_factory = session_factory
        self.limits = {
            name: _normalize_windows(windows)
            for name, windows in (limits or PROVIDER_RATE_LIMITS).items()
        }

    def usage(self, provider: str) -> dict:
        """Uso en la ventana MÁS restrictiva ahora mismo (mínimo restante)."""
        windows = self.limits.get(provider, ((10_000, 60),))
        binding: dict | None = None
        with self.session_factory() as session:
            for limit, window in windows:
                cutoff = datetime.now(timezone.utc) - timedelta(seconds=window)
                used = session.execute(
                    select(func.count())
                    .select_from(ApiCallLog)
                    .where(
                        ApiCallLog.provider == provider,
                        ApiCallLog.called_at >= cutoff,
                    )
                ).scalar_one()
                candidate = {
                    "provider": provider,
                    "limit": limit,
                    "window_seconds": window,
                    "used": used,
                    "remaining": max(limit - used, 0),
                }
                if binding is None or candidate["remaining"] < binding["remaining"]:
                    binding = candidate
        return binding  # type: ignore[return-value]

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
        # _order permite forzar fuentes para casos especiales (p. ej. índices
        # tipo ^VIX que solo cubre yfinance) sin tocar el orden global.
        order = kwargs.pop("_order", None) or self.source_order.get(data_type, [])
        for name in order:
            provider = self.providers.get(name)
            if provider is None:
                reasons[name] = "no configurado (falta API key o credencial en .env)"
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

"""Capa de caché SQLite con TTL por tipo de dato.

Parte del diseño central: los tiers gratuitos no sobreviven sin caché. Todo
lo descargado se guarda con timestamp; una respuesta servida desde caché
conserva el `source` original y añade `cached: true` + `fetched_at` para que
la UI muestre frescura real, nunca aparente.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.config import CACHE_TTL_SECONDS
from app.db.models import ApiCache


def params_hash(params: dict) -> str:
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


def _as_utc(dt: datetime) -> datetime:
    # SQLite guarda datetimes naive; los tratamos siempre como UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class CacheStore:
    def __init__(self, session_factory, ttls: dict[str, int] | None = None, now=None):
        self.session_factory = session_factory
        self.ttls = ttls or CACHE_TTL_SECONDS
        self._now = now or (lambda: datetime.now(timezone.utc))

    def get(self, data_type: str, params: dict) -> dict | None:
        """Devuelve el payload cacheado y vigente, o None si expiró/no existe."""
        key = params_hash(params)
        with self.session_factory() as session:
            row = session.execute(
                select(ApiCache).where(
                    ApiCache.provider == "router",
                    ApiCache.endpoint == data_type,
                    ApiCache.params_hash == key,
                )
            ).scalar_one_or_none()
            if row is None:
                return None
            if _as_utc(row.expires_at) <= self._now():
                return None
            payload = dict(row.payload)
            payload["cached"] = True
            payload["fetched_at"] = _as_utc(row.fetched_at).isoformat()
            return payload

    def set(self, data_type: str, params: dict, payload: dict) -> None:
        ttl = self.ttls.get(data_type, 300)
        now = self._now()
        key = params_hash(params)
        with self.session_factory() as session:
            row = session.execute(
                select(ApiCache).where(
                    ApiCache.provider == "router",
                    ApiCache.endpoint == data_type,
                    ApiCache.params_hash == key,
                )
            ).scalar_one_or_none()
            if row is None:
                row = ApiCache(
                    provider="router",
                    endpoint=data_type,
                    params_hash=key,
                    payload=payload,
                    fetched_at=now,
                    expires_at=now + timedelta(seconds=ttl),
                )
                session.add(row)
            else:
                row.payload = payload
                row.fetched_at = now
                row.expires_at = now + timedelta(seconds=ttl)
            session.commit()


class MarketDataService:
    """Fachada que usan los endpoints: caché primero, router de fuentes después."""

    def __init__(self, router, cache: CacheStore):
        self.router = router
        self.cache = cache

    def get(self, data_type: str, **kwargs) -> dict:
        # Los kwargs con "_" son directivas para el router (p. ej. _order),
        # no parámetros del dato: quedan fuera de la clave de caché.
        cache_params = {k: v for k, v in kwargs.items() if not k.startswith("_")}
        cached = self.cache.get(data_type, cache_params)
        if cached is not None:
            return cached
        payload = self.router.fetch(data_type, **kwargs)
        self.cache.set(data_type, cache_params, payload)
        result = dict(payload)
        result["cached"] = False
        result["fetched_at"] = self.cache._now().isoformat()
        return result

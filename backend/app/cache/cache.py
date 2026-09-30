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
from app.datos import Estado
from app.db.models import ApiCache
from app.providers.router import AllProvidersFailedError
from app.registro import log

# Cuánto después de caducar se puede rescatar un dato si todas las fuentes
# fallan: un múltiplo de su propio TTL, con techo absoluto. Una cotización (TTL
# 60 s) se rescata durante 30 minutos; unos fundamentales, hasta el techo.
FACTOR_RESCATE = 30
TECHO_RESCATE_SEGUNDOS = 7 * 24 * 3600


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

    def get_vencido(self, data_type: str, params: dict) -> dict | None:
        """Una entrada CADUCADA pero aún dentro del margen de rescate.

        Existe para un caso concreto: todas las fuentes han fallado y hay un
        dato de hace unos minutos. Servirlo marcado como viejo es mejor que un
        apagón — pero solo marcado, y solo si «unos minutos» sigue siendo
        cierto. Un precio de hace tres días es peor que un error honesto,
        porque el error se ve y el precio viejo no.

        El margen escala con el TTL del propio dato, que ya codifica cuánto de
        rápido se mueve: una cotización caduca en un minuto y se rescata durante
        media hora; unos fundamentales caducan en días y aguantan semanas.
        """
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
            ahora = self._now()
            antiguedad = (ahora - _as_utc(row.fetched_at)).total_seconds()
            if antiguedad > self.margen_de_rescate(data_type):
                return None
            payload = dict(row.payload)
            payload["cached"] = True
            payload["fetched_at"] = _as_utc(row.fetched_at).isoformat()
            payload["antiguedad_segundos"] = int(antiguedad)
            return payload

    def margen_de_rescate(self, data_type: str) -> float:
        ttl = self.ttls.get(data_type, 300)
        return min(ttl * FACTOR_RESCATE, TECHO_RESCATE_SEGUNDOS)

    def limpiar(self, ahora: datetime | None = None) -> int:
        """Borra lo caducado que ya ni siquiera sirve como rescate.

        No se borra en cuanto caduca: lo recién caducado es justamente lo que
        sostiene la caída a dato viejo cuando las fuentes fallan. Se borra lo
        que ya no puede servir para nada, que es lo único que solo ocupa sitio.
        """
        ahora = ahora or self._now()
        borradas = 0
        with self.session_factory() as session:
            filas = session.execute(
                select(ApiCache).where(ApiCache.provider == "router")
            ).scalars().all()
            for row in filas:
                antiguedad = (ahora - _as_utc(row.fetched_at)).total_seconds()
                if antiguedad > self.margen_de_rescate(row.endpoint):
                    session.delete(row)
                    borradas += 1
            if borradas:
                session.commit()
        log("cache").info("limpieza: %d entrada(s) caducada(s) borradas", borradas)
        return borradas

    def invalidate(self, data_type: str, params: dict) -> bool:
        """Borra una entrada concreta. Devuelve si había algo que borrar.

        Existe para un caso muy concreto: una actualización de la app cambia la
        forma de un payload y lo ya cacheado con la forma vieja sigue vigente
        durante horas. Servirlo deja la pantalla a medias sin explicación, así
        que quien detecta la forma vieja puede tirarla y volver a pedirla.
        """
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
                return False
            session.delete(row)
            session.commit()
            return True

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
            cached["estado"] = Estado.VALIDO.value
            return cached
        try:
            payload = self.router.fetch(data_type, **kwargs)
        except AllProvidersFailedError as exc:
            # Todas las fuentes han fallado. Si hay un dato reciente caducado,
            # se sirve MARCADO: `estado: viejo`, su antigüedad y un aviso. Lo
            # que no se hace es servirlo como si fuera de ahora, ni inventarlo.
            # `DataNotFoundError` no entra aquí a propósito: «no existe» es una
            # respuesta, y taparla con caché vieja la contradiría.
            rescate = self.cache.get_vencido(data_type, cache_params)
            if rescate is None:
                raise
            minutos = rescate["antiguedad_segundos"] // 60
            log("cache").warning(
                "rescate de dato viejo: %s %s (hace %d min) porque %s",
                data_type, cache_params, minutos, exc,
            )
            rescate["estado"] = Estado.VIEJO.value
            rescate["aviso"] = (
                f"Dato viejo: todas las fuentes han fallado y se sirve la última "
                f"copia, de hace {minutos} min. Motivo del fallo: {exc}"
            )
            return rescate
        # Solo llega aquí un payload que pasó `validacion.validar` dentro del
        # router: lo inválido nunca se cachea.
        self.cache.set(data_type, cache_params, payload)
        result = dict(payload)
        result["cached"] = False
        result["fetched_at"] = self.cache._now().isoformat()
        result["estado"] = Estado.VALIDO.value
        return result

"""Limpieza de caché y del registro de llamadas. Automática y a prueba de fallos.

Se ejecuta en dos momentos: al arrancar el servidor y en cada pasada del
comando de alertas (`scripts/revisar_alertas.py`). El segundo es el que la hace
automática de verdad: el servidor de una app local se arranca a ratos, pero el
cron corre cada quince minutos esté o no abierta la app.

**Nunca lanza.** Una limpieza que falla no puede impedir que la app arranque ni
que las alertas se revisen: sería cambiar un problema de espacio en disco por
uno de disponibilidad, que es mucho peor. Si falla, se registra en `app.db` y
la próxima pasada lo vuelve a intentar.
"""

from __future__ import annotations

from sqlalchemy.exc import SQLAlchemyError

from app.cache.cache import CacheStore
from app.providers.router import RateLimiter
from app.registro import log


def mantener(session_factory) -> dict:
    """Borra lo que ya no sirve. Devuelve qué hizo, o por qué no pudo."""
    salida: dict = {"cache_borradas": None, "llamadas_borradas": None, "errores": []}
    try:
        salida["cache_borradas"] = CacheStore(session_factory).limpiar()
    except SQLAlchemyError as exc:
        salida["errores"].append(f"caché: {exc}")
        log("db").error("limpieza de caché falló: %s", exc)
    try:
        salida["llamadas_borradas"] = RateLimiter(session_factory).limpiar()
    except SQLAlchemyError as exc:
        salida["errores"].append(f"registro de llamadas: {exc}")
        log("db").error("limpieza del registro de llamadas falló: %s", exc)
    return salida

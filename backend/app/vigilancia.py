"""Evaluar una alerta de verdad: conseguir el precio, juzgar, dejar registro.

`analysis/alertas.py` decide si una condición se cumple con un precio dado, y
nada más: es puro a propósito. Esto es lo que va alrededor, y lo comparten el
endpoint (`GET /api/portfolio/alerts`) y el comando del cron, para que la
pestaña y el aviso no puedan contar historias distintas.

Tres responsabilidades, cada una con su porqué:

**Categorizar el fallo.** «No hay cotización para este símbolo» (sin datos) y
«los proveedores están caídos o algo reventó» (error) son cosas distintas que
se estaban contando igual. La primera es un dato; la segunda, un problema.

**Aislar el fallo.** Una excepción inesperada con UNA alerta abortaba la pasada
entera del cron, y con ella la marca de vigilancia: la pestaña acababa diciendo
que el cron no corría cuando lo que pasaba era que una alerta estaba rota.
Aquí cada alerta se evalúa dentro de su propio `try`.

**Dejar registro y avisar de lo atascado, una vez.** Cada evaluación escribe
cuándo, con qué resultado y con qué error. Y una alerta que lleva varias
pasadas sin poder comprobarse genera UN aviso — la alerta que no se puede
comprobar es la más peligrosa, porque en pantalla parece tranquila — con
enfriamiento para no repetirlo cada quince minutos.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Callable

from app import datos
from app.analysis import alertas
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError
from app.registro import log

# Un reintento dentro de la pasada ante proveedores caídos. El router ya
# reintenta cada proveedor; esto cubre el caso de que TODOS fallen a la vez por
# un corte breve. Más reintentos alargarían una pasada que se repite en 15 min.
REINTENTOS = 1
PAUSA_REINTENTO_S = 2.0

# Tres pasadas seguidas sin poder comprobar (45 min con el cron recomendado)
# antes de avisar: un corte de cinco minutos no merece una notificación.
UMBRAL_ERRORES_AVISO = 3
# Y no se vuelve a avisar del MISMO atasco hasta pasado un día.
ENFRIAMIENTO_AVISO_ERROR = timedelta(hours=24)

SIN_DATOS = "sin_datos"
ERROR = "error"
# Hay precio, pero rescatado de caché porque todas las fuentes fallaron.
VIEJO = "viejo"


def obtener_precio(
    fetch: Callable[[str], float | None],
    symbol: str,
    *,
    reintentos: int | None = None,
    dormir: Callable[[float], None] = time.sleep,
) -> tuple[float | None, str | None, str | None]:
    """(precio, tipo de fallo, detalle). Nunca lanza.

    El tipo de fallo es None si hay precio, `sin_datos` si el símbolo no tiene
    cotización (o la que hay es inutilizable), y `error` si algo se rompió.
    """
    reintentos = REINTENTOS if reintentos is None else reintentos
    for intento in range(reintentos + 1):
        try:
            crudo = fetch(symbol)
        except DataNotFoundError as exc:
            return None, SIN_DATOS, str(exc)
        except AllProvidersFailedError as exc:
            if intento < reintentos:
                log("alertas").info("%s: proveedores caídos, reintento %d", symbol, intento + 1)
                dormir(PAUSA_REINTENTO_S)
                continue
            return None, ERROR, str(exc)[:300]
        except Exception as exc:  # noqa: BLE001 — se aísla por alerta, no se traga
            log("alertas").exception("%s: fallo inesperado al pedir el precio", symbol)
            return None, ERROR, f"{type(exc).__name__}: {exc}"[:300]
        # El buscador puede devolver el precio suelto o la respuesta entera del
        # servicio de datos; en el segundo caso trae su `estado`.
        viejo_seg = None
        if isinstance(crudo, dict):
            if crudo.get("estado") == "viejo":
                viejo_seg = datos.numero(crudo.get("antiguedad_segundos")) or 0
            crudo = crudo.get("price")
        precio = datos.precio(crudo)
        if precio is None:
            return None, SIN_DATOS, f"precio inutilizable ({crudo!r})"
        if viejo_seg is not None:
            return precio, VIEJO, f"de hace {round(viejo_seg / 60)} min"
        return precio, None, None
    return None, ERROR, "sin respuesta tras reintentar"  # inalcanzable, por completitud


def evaluar_y_registrar(alerta, symbol: str, precio, fallo, detalle, ahora: datetime) -> dict:
    """Juzga la alerta y escribe el resultado EN la fila. No hace commit."""
    entrada = {
        "id": alerta.id,
        "symbol": symbol,
        "condition": alerta.condition or {},
        "active": alerta.active,
        "triggered_at": alerta.triggered_at,
    }
    veredicto = alertas.evaluar(
        entrada, precio, ahora, error=detalle if fallo == ERROR else None
    )
    if fallo == VIEJO and veredicto.get("evaluable"):
        # Con un precio viejo se puede afirmar que la condición SE CUMPLIÓ —el
        # cruce ocurrió—, pero no que no se cumple ahora: en esos minutos el
        # precio pudo cruzar. Visto en el navegador: una alerta salía «no
        # cumplida» contra un precio rescatado de hace once minutos.
        if veredicto["cumple"]:
            veredicto = {**veredicto, "motivo": f"{veredicto['motivo']} (precio {detalle})"}
        else:
            veredicto = {
                "evaluable": False,
                "cumple": False,
                "estado": alertas.SIN_PRECIO,
                "motivo": (
                    f"solo hay un precio viejo para {symbol} ({detalle}: las fuentes "
                    "fallaron). Con él no se puede afirmar que no salte: en esos "
                    "minutos pudo cruzar el umbral."
                ),
            }
    nueva = alertas.es_nueva(entrada, veredicto)

    if alerta.active:
        estado = veredicto["estado"]
        alerta.last_evaluated_at = ahora
        if estado == "ok":
            alerta.last_result = "cumplida" if veredicto["cumple"] else "no_cumplida"
            alerta.last_error = None
            alerta.consecutive_errors = 0
            # Recuperada: el próximo atasco vuelve a merecer aviso.
            alerta.error_notified_at = None
        else:
            alerta.last_result = estado
            alerta.last_error = detalle or veredicto["motivo"]
            if estado in (alertas.SIN_PRECIO, alertas.ERROR):
                # «Sin datos» también cuenta: para quien espera el aviso, una
                # alerta que no se puede comprobar no le protege, sea cual sea
                # la causa. El mensaje distingue una de otra.
                alerta.consecutive_errors = (alerta.consecutive_errors or 0) + 1
    if nueva:
        alerta.triggered_at = ahora
        log("alertas").info("%s: alerta #%s cumplida (%s)", symbol, alerta.id, veredicto["motivo"])
    elif veredicto["estado"] == alertas.ERROR:
        log("alertas").warning("%s: alerta #%s no evaluable: %s", symbol, alerta.id, detalle)

    return {"symbol": symbol, "veredicto": veredicto, "nueva": nueva}


def necesita_aviso_de_error(alerta, ahora: datetime) -> bool:
    if (alerta.consecutive_errors or 0) < UMBRAL_ERRORES_AVISO:
        return False
    ultimo = alertas.como_utc(alerta.error_notified_at)
    return ultimo is None or ahora - ultimo >= ENFRIAMIENTO_AVISO_ERROR


def texto_de_aviso_de_error(atascadas: list[tuple[str, int, str | None]]) -> tuple[str, str]:
    """Título y cuerpo para las alertas que no se pueden comprobar."""
    if len(atascadas) == 1:
        sym, n, detalle = atascadas[0]
        return (
            f"Alerta de {sym}: no se puede comprobar",
            f"{n} revisiones seguidas sin poder mirarla. Última causa: {detalle or 'desconocida'}"[:240],
        )
    nombres = ", ".join(s for s, _, _ in atascadas[:4])
    return (
        f"{len(atascadas)} alertas no se pueden comprobar",
        f"{nombres}{'…' if len(atascadas) > 4 else ''}: llevan varias revisiones sin poder mirarse.",
    )

"""Revisa las alertas y avisa de las que acaban de saltar. Para `cron`.

    python scripts/revisar_alertas.py

Por qué un comando y no un hilo dentro del servidor: esta es una app local que
arrancas cuando la usas. Un planificador dentro de un proceso que puede estar
apagado no vigila nada, y además mentiría — la pestaña diría «vigilando» con el
servidor parado. Lo honesto es dejarle el calendario al sistema operativo, que
para eso está siempre encendido.

Programarlo cada quince minutos en horario de mercado (lunes a viernes,
9:30-16:00 hora de Nueva York):

    */15 13-21 * * 1-5  cd /ruta/al/repo/backend && \\
        /usr/bin/python3 scripts/revisar_alertas.py >> ~/.alertas.log 2>&1

(Las horas del cron van en la hora de tu máquina; 13-21 UTC cubre la sesión
estadounidense. Ajusta si tu reloj no está en UTC.)

En macOS, `launchd` es más fiable que `cron` para tareas de usuario, y en
Windows el Programador de tareas hace lo mismo.

## Lo que este comando NO hace

No descarga nada que no esté ya en caché si le pasas `--solo-cache`. Sin esa
opción gasta una cotización por símbolo con alerta activa, que es el coste real
de vigilar: si tienes ocho alertas y lo corras cada quince minutos, son ~256
llamadas al día. Con el tier gratuito de Finnhub (60/min) cabe de sobra, pero
conviene saberlo antes de ponerlo cada minuto.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app import vigilancia  # noqa: E402
from app.analysis import alertas as al  # noqa: E402
from app.config import settings  # noqa: E402
from app.db.engine import SessionLocal, init_db  # noqa: E402
from app.db.models import Alert, Instrument  # noqa: E402
from app.deps import get_service  # noqa: E402
from app.mantenimiento import mantener  # noqa: E402
from app.notify import notificar  # noqa: E402
from app.registro import configurar as configurar_registro  # noqa: E402
from app.registro import log  # noqa: E402


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _buscador_de_precio(service, solo_cache: bool):
    """Cómo conseguir el precio: de la red, o solo de lo ya guardado."""
    if solo_cache:
        cache = getattr(service, "cache", None)
        return lambda symbol: ((cache.get("quote", {"symbol": symbol}) if cache else None) or {}).get("price")
    # La respuesta entera, no solo el precio: trae su `estado`, y un precio
    # rescatado de caché no basta para afirmar que una alerta no salta.
    return lambda symbol: service.get("quote", symbol=symbol)


def revisar(solo_cache: bool = False, avisar: bool = True) -> dict:
    configurar_registro()
    init_db()
    # La limpieza vive aquí además de al arrancar el servidor: el cron corre
    # cada quince minutos esté o no abierta la app, y es lo que la hace
    # automática de verdad. `mantener` no lanza.
    mantener(SessionLocal)
    service = get_service()
    ahora = _ahora()
    buscar = _buscador_de_precio(service, solo_cache)

    with SessionLocal() as session:
        filas = session.execute(
            select(Alert, Instrument).join(Instrument, Alert.instrument_id == Instrument.id)
        ).all()

        resultados, atascadas = [], []
        for alerta, instrumento in filas:
            # Cada alerta, en su propio perímetro. Antes, una excepción
            # inesperada con UNA abortaba la pasada entera —y con ella la marca
            # de vigilancia, así que la pestaña decía que el cron no corría—.
            # `obtener_precio` no lanza; lo que pudiera reventar al juzgar se
            # captura aquí y la alerta queda en estado de error.
            if alerta.active:
                precio, fallo, detalle = vigilancia.obtener_precio(buscar, instrumento.symbol)
            else:
                precio, fallo, detalle = None, None, None
            try:
                r = vigilancia.evaluar_y_registrar(
                    alerta, instrumento.symbol, precio, fallo, detalle, ahora
                )
            except Exception as exc:  # noqa: BLE001 — se aísla por alerta, no se traga
                log("alertas").exception("alerta #%s de %s: fallo al evaluar", alerta.id, instrumento.symbol)
                r = vigilancia.evaluar_y_registrar(
                    alerta, instrumento.symbol, None, vigilancia.ERROR,
                    f"{type(exc).__name__}: {exc}", ahora,
                )
            # Se marca ANTES de notificar (lo hace `evaluar_y_registrar`). Si el
            # aviso falla, la alerta queda igualmente registrada como saltada:
            # peor que un aviso perdido es uno repetido cada quince minutos.
            resultados.append(r)
            if alerta.active and vigilancia.necesita_aviso_de_error(alerta, ahora):
                alerta.error_notified_at = ahora  # también antes de avisar
                atascadas.append((instrumento.symbol, alerta.consecutive_errors, alerta.last_error))
        session.commit()

    salida = al.resumir(resultados)

    # La marca se deja SIEMPRE, también cuando no ha saltado nada: sirve para
    # que la pestaña pueda decir «alguien está mirando» en vez de suponerlo. Una
    # pasada tranquila es justamente la prueba de que la vigilancia funciona.
    al.anotar_pasada(Path(settings.database_path).parent, salida, ahora)

    if avisar and salida["nuevas"]:
        titulo, cuerpo = al.texto_de_aviso(salida["nuevas"])
        salida["notificacion"] = notificar(titulo, cuerpo)
    salida["atascadas"] = [s for s, _, _ in atascadas]
    if avisar and atascadas:
        titulo, cuerpo = vigilancia.texto_de_aviso_de_error(atascadas)
        salida["notificacion_de_errores"] = notificar(titulo, cuerpo)
    return salida


def main() -> int:
    p = argparse.ArgumentParser(description="Revisa las alertas y avisa de las nuevas.")
    p.add_argument(
        "--solo-cache",
        action="store_true",
        help="no descarga cotizaciones; usa solo lo ya guardado (gratis, pero puede estar viejo)",
    )
    p.add_argument("--sin-aviso", action="store_true", help="no manda notificación de escritorio")
    p.add_argument("--json", action="store_true", help="salida en JSON")
    args = p.parse_args()

    salida = revisar(solo_cache=args.solo_cache, avisar=not args.sin_aviso)

    if args.json:
        print(json.dumps(salida, indent=2, ensure_ascii=False, default=str))
    else:
        # SIEMPRE por salida estándar, además de la notificación: con cron esto
        # acaba en el log o en el correo del sistema, donde el aviso sigue
        # existiendo aunque el escritorio no se haya enterado.
        print(f"[{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC] {salida['resumen']}")
        aviso = salida.get("notificacion")
        if aviso and not aviso["enviado"]:
            print(f"  (no se pudo notificar al escritorio: {aviso['motivo']})")
        for rota in salida["no_evaluables"]:
            print(f"  ! {rota['veredicto']['motivo']}")

    # Código 0 siempre que la revisión se haya hecho: que una alerta salte no
    # es un fallo del comando, y devolver != 0 haría que cron lo tratara como
    # error y llenara el correo de falsos problemas.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

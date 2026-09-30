"""Avisar al escritorio, y no romperse cuando no se pueda.

Cada sistema tiene su propio mecanismo y ninguno está garantizado: en un
servidor sin sesión gráfica no hay a quién avisar, en Linux puede faltar
`notify-send`, y en macOS el usuario puede tener las notificaciones denegadas.

La regla de este módulo es una sola: **un aviso que falla no puede tumbar la
pasada**. El comando de alertas existe para enterarse de que algo cruzó un
umbral; si además el globo del escritorio no aparece, eso es un problema menor
comparado con que la revisión entera se caiga con una traza. Por eso todo está
envuelto y el resultado dice qué pasó, en vez de lanzar.

Y por eso el comando SIEMPRE escribe por salida estándar además de notificar:
con `cron` eso acaba en el correo del sistema o en el log, que es un sitio
donde el aviso sigue existiendo aunque el escritorio no se entere.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess

TIMEOUT = 5


def _mac(titulo: str, cuerpo: str) -> tuple[bool, str]:
    if not shutil.which("osascript"):
        return False, "no hay osascript"
    # Las comillas dobles se escapan: un nombre de empresa con comillas
    # rompería el AppleScript, y el título lo compone la app, no el usuario,
    # pero el símbolo sí puede venir de fuera.
    t = titulo.replace('"', '\\"')
    c = cuerpo.replace('"', '\\"')
    return _correr(
        ["osascript", "-e", f'display notification "{c}" with title "{t}"'],
        "osascript",
    )


def _linux(titulo: str, cuerpo: str) -> tuple[bool, str]:
    if not shutil.which("notify-send"):
        return False, "no hay notify-send (instala libnotify-bin)"
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        # Sin sesión gráfica no hay escritorio al que avisar. Decirlo es mejor
        # que dejar que notify-send falle con un error críptico.
        return False, "sin sesión gráfica (ni DISPLAY ni WAYLAND_DISPLAY)"
    return _correr(["notify-send", titulo, cuerpo], "notify-send")


def _windows(titulo: str, cuerpo: str) -> tuple[bool, str]:
    if not shutil.which("powershell"):
        return False, "no hay powershell"
    guion = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications,"
        " ContentType=WindowsRuntime] | Out-Null; "
        f"Write-Output '{titulo}: {cuerpo}'"
    )
    return _correr(["powershell", "-NoProfile", "-Command", guion], "powershell")


def _correr(cmd: list[str], nombre: str) -> tuple[bool, str]:
    try:
        completado = subprocess.run(
            cmd, capture_output=True, timeout=TIMEOUT, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"{nombre} falló: {exc}"
    if completado.returncode != 0:
        detalle = (completado.stderr or b"").decode(errors="replace").strip()[:160]
        return False, f"{nombre} salió con código {completado.returncode}: {detalle}"
    return True, nombre


def notificar(titulo: str, cuerpo: str) -> dict:
    """Manda un aviso al escritorio. NUNCA lanza.

    Devuelve qué pasó para que quien llame pueda decirlo en voz alta: un aviso
    que se cree enviado y no lo está es peor que uno que no se intentó.
    """
    if not titulo:
        return {"enviado": False, "motivo": "no hay nada que notificar"}

    sistema = platform.system()
    manejador = {"Darwin": _mac, "Linux": _linux, "Windows": _windows}.get(sistema)
    if manejador is None:
        return {"enviado": False, "motivo": f"sistema no soportado: {sistema}"}

    ok, detalle = manejador(titulo, cuerpo)
    return {
        "enviado": ok,
        "via": detalle if ok else None,
        "motivo": None if ok else detalle,
        "sistema": sistema,
    }

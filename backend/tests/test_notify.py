"""El notificador de escritorio, y sobre todo sus formas de fallar.

No se puede comprobar aquí que aparezca un globo en la pantalla — en un
contenedor sin sesión gráfica no hay pantalla. Lo que sí se puede comprobar, y
es lo que de verdad importa, es lo otro: que cuando NO se pueda avisar el
resultado lo diga en vez de romperse, y que no diga «enviado» sin haberlo
enviado. Un aviso que se cree entregado y no lo está es peor que uno que ni se
intentó, porque el segundo se ve en el log.
"""

from __future__ import annotations

import subprocess

from app import notify


def test_sin_titulo_no_se_notifica_nada():
    r = notify.notificar("", "cuerpo")
    assert not r["enviado"]


def test_sistema_desconocido_lo_dice(monkeypatch):
    monkeypatch.setattr(notify.platform, "system", lambda: "Plan9")
    r = notify.notificar("Alerta", "AAPL a 140")
    assert not r["enviado"]
    assert "Plan9" in r["motivo"]


def test_linux_sin_notify_send_lo_dice(monkeypatch):
    monkeypatch.setattr(notify.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify.shutil, "which", lambda _: None)
    r = notify.notificar("Alerta", "AAPL a 140")
    assert not r["enviado"]
    assert "notify-send" in r["motivo"]


def test_linux_sin_sesion_grafica_lo_dice(monkeypatch):
    monkeypatch.setattr(notify.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify.shutil, "which", lambda _: "/usr/bin/notify-send")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    r = notify.notificar("Alerta", "AAPL a 140")
    assert not r["enviado"]
    # Este es el caso de este contenedor, y el de un servidor: hay que decirlo,
    # no dejar que notify-send falle con un error críptico.
    assert "gráfica" in r["motivo"]


def test_linux_con_sesion_grafica_llama_a_notify_send(monkeypatch):
    llamadas = []
    monkeypatch.setattr(notify.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify.shutil, "which", lambda _: "/usr/bin/notify-send")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setattr(
        notify.subprocess,
        "run",
        lambda cmd, **kw: llamadas.append(cmd)
        or subprocess.CompletedProcess(cmd, 0, b"", b""),
    )
    r = notify.notificar("Alerta: AAPL", "AAPL a 140,00, por debajo de 150,00")
    assert r["enviado"] and r["via"] == "notify-send"
    assert llamadas[0][0] == "notify-send"
    assert "AAPL a 140,00, por debajo de 150,00" in llamadas[0]


def test_un_codigo_de_salida_malo_no_se_cuenta_como_enviado(monkeypatch):
    monkeypatch.setattr(notify.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify.shutil, "which", lambda _: "/usr/bin/notify-send")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setattr(
        notify.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, b"", b"no such bus"),
    )
    r = notify.notificar("Alerta", "AAPL a 140")
    assert not r["enviado"]
    assert "no such bus" in r["motivo"]


def test_un_cuelgue_no_tumba_la_pasada(monkeypatch):
    """Lo más importante del módulo: nunca lanza."""
    monkeypatch.setattr(notify.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify.shutil, "which", lambda _: "/usr/bin/notify-send")
    monkeypatch.setenv("DISPLAY", ":0")

    def cuelga(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, notify.TIMEOUT)

    monkeypatch.setattr(notify.subprocess, "run", cuelga)
    r = notify.notificar("Alerta", "AAPL a 140")
    assert not r["enviado"] and r["motivo"]


def test_un_error_del_sistema_operativo_tampoco(monkeypatch):
    monkeypatch.setattr(notify.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify.shutil, "which", lambda _: "/usr/bin/notify-send")
    monkeypatch.setenv("DISPLAY", ":0")

    def revienta(cmd, **kw):
        raise OSError("Permission denied")

    monkeypatch.setattr(notify.subprocess, "run", revienta)
    r = notify.notificar("Alerta", "AAPL a 140")
    assert not r["enviado"]
    assert "Permission denied" in r["motivo"]


def test_las_comillas_del_texto_no_rompen_el_applescript(monkeypatch):
    """En macOS el aviso se compone dentro de una cadena de AppleScript."""
    guiones = []
    monkeypatch.setattr(notify.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(notify.shutil, "which", lambda _: "/usr/bin/osascript")
    monkeypatch.setattr(
        notify.subprocess,
        "run",
        lambda cmd, **kw: guiones.append(cmd[-1])
        or subprocess.CompletedProcess(cmd, 0, b"", b""),
    )
    r = notify.notificar('Alerta: "BRK.B"', 'a 340 "aprox"')
    assert r["enviado"]
    # Las comillas del texto van escapadas; las que delimitan, no.
    assert '\\"BRK.B\\"' in guiones[0]
    assert guiones[0].count('"') - guiones[0].count('\\"') == 4


def test_hay_un_timeout(monkeypatch):
    """Sin timeout, un notificador colgado deja el cron colgado con él."""
    vistos = {}
    monkeypatch.setattr(notify.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify.shutil, "which", lambda _: "/usr/bin/notify-send")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setattr(
        notify.subprocess,
        "run",
        lambda cmd, **kw: vistos.update(kw)
        or subprocess.CompletedProcess(cmd, 0, b"", b""),
    )
    notify.notificar("Alerta", "AAPL a 140")
    assert vistos["timeout"] == notify.TIMEOUT

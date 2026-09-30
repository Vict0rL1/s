"""Logos: descargarlos sin convertir el backend en una herramienta de intrusión.

La URL del logo sale de la respuesta de una API externa, así que es entrada no
confiable, y quien la descarga es un proceso dentro de tu red. La mitad de estos
tests son de seguridad, no de formato: comprueban que este endpoint no se puede
usar para leer cosas que están del lado de dentro.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.analysis import logos


class _RespuestaFalsa:
    def __init__(self, datos: bytes, status: int = 200, headers: dict | None = None):
        self._datos = datos
        self.status_code = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def iter_bytes(self, n: int = 65536):
        for i in range(0, len(self._datos), n):
            yield self._datos[i : i + n]


class _ClienteFalso:
    """Sustituye a httpx.Client sin tocar la red."""

    def __init__(self, respuesta: _RespuestaFalsa):
        self.respuesta = respuesta
        self.pedidas: list[str] = []

    def stream(self, metodo: str, url: str):
        self.pedidas.append(url)
        return self.respuesta

    def close(self):
        pass


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


# --- Defensas contra SSRF -----------------------------------------------------


@pytest.mark.parametrize(
    "url,motivo",
    [
        ("http://static.ejemplo.com/a.png", "solo se descargan logos por https"),
        ("file:///etc/passwd", "solo se descargan logos por https"),
        ("gopher://ejemplo.com/x", "solo se descargan logos por https"),
        ("ftp://ejemplo.com/a.png", "solo se descargan logos por https"),
        ("", "no hay URL"),
    ],
)
def test_solo_se_descarga_por_https(url, motivo):
    """`file://` sería leer ficheros del servidor; http en claro es manipulable."""
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.validar_url(url)
    assert motivo in str(exc.value)


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",        # tu propio backend
        "169.254.169.254",  # metadatos de la nube: el clásico
        "10.0.0.1",         # red privada
        "192.168.1.1",      # tu router
        "172.16.0.1",       # privada
        "0.0.0.0",          # sin especificar
    ],
)
def test_no_se_descarga_de_direcciones_no_publicas(host):
    """Sin esto, un `logo` manipulado convierte el endpoint en una forma de
    leer desde dentro de tu red — incluido el servicio de metadatos."""
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.validar_url(f"https://{host}/logo.png")
    assert "no pública" in str(exc.value)


def test_una_direccion_publica_pasa():
    assert logos.validar_url("https://8.8.8.8/logo.png") == "https://8.8.8.8/logo.png"


def test_un_host_que_no_resuelve_se_rechaza():
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.validar_url("https://este-host-no-existe-jamas-12345.invalid/a.png")
    assert "no se pudo resolver" in str(exc.value)


def test_no_se_siguen_redirecciones():
    """El destino de un 302 no pasa por ninguna de las comprobaciones de arriba,
    así que seguirlo reabriría todo lo que se acaba de cerrar."""
    cliente = _ClienteFalso(_RespuestaFalsa(b"", status=302, headers={"location": "http://10.0.0.1/x"}))
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.descargar("https://8.8.8.8/logo.png", cliente)
    assert "redirige" in str(exc.value)


# --- Límites de tamaño y de tipo ----------------------------------------------


def test_se_rechaza_un_logo_gigante_aunque_mienta_el_content_length():
    """Se comprueba lo que LLEGA: declarar un tamaño pequeño es gratis."""
    enorme = b"\x89PNG\r\n\x1a\n" + b"\x00" * (logos.MAX_BYTES + 1000)
    cliente = _ClienteFalso(_RespuestaFalsa(enorme, headers={"content-length": "10"}))
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.descargar("https://8.8.8.8/logo.png", cliente)
    assert "mientras se descargaba" in str(exc.value)


def test_un_content_length_declarado_enorme_se_corta_antes_de_bajar_nada():
    cliente = _ClienteFalso(
        _RespuestaFalsa(PNG, headers={"content-length": str(logos.MAX_BYTES * 3)})
    )
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.descargar("https://8.8.8.8/logo.png", cliente)
    assert "dice pesar" in str(exc.value)


def test_el_tipo_sale_de_los_bytes_y_no_del_content_type():
    """Un Content-Type lo escribe quien sirve el fichero: no es comprobación."""
    disfrazado = b"<html><script>alert(1)</script></html>"
    cliente = _ClienteFalso(_RespuestaFalsa(disfrazado, headers={"content-type": "image/png"}))
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.descargar("https://8.8.8.8/logo.png", cliente)
    assert "no es una imagen" in str(exc.value)


@pytest.mark.parametrize(
    "datos,mime",
    [
        (PNG, "image/png"),
        (b"\xff\xd8\xff" + b"\x00" * 40, "image/jpeg"),
        (b"GIF89a" + b"\x00" * 40, "image/gif"),
        (b"RIFF" + b"\x00" * 4 + b"WEBP" + b"\x00" * 40, "image/webp"),
        (b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/svg+xml"),
    ],
)
def test_se_reconocen_los_formatos_de_imagen_reales(datos, mime):
    cliente = _ClienteFalso(_RespuestaFalsa(datos))
    _, detectado, _ = logos.descargar("https://8.8.8.8/logo.png", cliente)
    assert detectado == mime


def test_un_riff_que_no_es_webp_no_cuela():
    """RIFF también es WAV y AVI: hay que mirar el byte 8."""
    wav = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * 40
    cliente = _ClienteFalso(_RespuestaFalsa(wav))
    with pytest.raises(logos.LogoRechazado):
        logos.descargar("https://8.8.8.8/logo.png", cliente)


def test_un_logo_vacio_se_rechaza():
    cliente = _ClienteFalso(_RespuestaFalsa(b""))
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.descargar("https://8.8.8.8/logo.png", cliente)
    assert "vacío" in str(exc.value)


def test_un_error_http_se_reporta_con_su_codigo():
    cliente = _ClienteFalso(_RespuestaFalsa(b"", status=403))
    with pytest.raises(logos.LogoRechazado) as exc:
        logos.descargar("https://8.8.8.8/logo.png", cliente)
    assert "403" in str(exc.value)


# --- Almacén en disco ---------------------------------------------------------


def test_el_nombre_de_fichero_no_permite_salirse_del_directorio(tmp_path: Path):
    """El símbolo ya viene validado, pero el nombre no se construye confiando.

    Lo que de verdad importa es la contención: el resultado es UN componente
    dentro del directorio, pase lo que pase. Que además no empiece por punto
    es higiene —nada de ficheros ocultos—, no seguridad.
    """
    for hostil in ("../../etc/passwd", "..", ".", "///", "....", "-"):
        ruta = logos.ruta_de(tmp_path, hostil, ".png")
        assert ruta.parent == tmp_path
        assert "/" not in ruta.name
        assert not ruta.name.startswith(".")
        assert ruta.resolve().is_relative_to(tmp_path.resolve())


def test_los_tickers_con_punto_conservan_el_punto(tmp_path: Path):
    """BRK.B y AAPL.MX son nombres legítimos; limpiar de más los desfiguraría."""
    assert "BRK.B" in logos.ruta_de(tmp_path, "BRK.B", ".png").name


def test_dos_simbolos_distintos_no_comparten_fichero(tmp_path: Path):
    a = logos.ruta_de(tmp_path, "AAPL", ".png")
    b = logos.ruta_de(tmp_path, "AAPL.MX", ".png")
    assert a != b


def test_guardar_y_encontrar_van_juntos(tmp_path: Path):
    logos.guardar(tmp_path, "AAPL", PNG, ".png")
    encontrado = logos.buscar_en_disco(tmp_path, "AAPL")
    assert encontrado is not None
    ruta, mime = encontrado
    assert ruta.read_bytes() == PNG
    assert mime == "image/png"


def test_no_queda_ningun_fichero_parcial(tmp_path: Path):
    """Media imagen en disco se serviría rota para siempre: el propio fichero
    cuenta como «ya descargado»."""
    logos.guardar(tmp_path, "AAPL", PNG, ".png")
    assert not list(tmp_path.glob("*.parcial"))


def test_sin_logo_en_disco_no_se_inventa_nada(tmp_path: Path):
    assert logos.buscar_en_disco(tmp_path, "NADA") is None


def test_un_fichero_vacio_no_cuenta_como_logo(tmp_path: Path):
    logos.ruta_de(tmp_path, "AAPL", ".png").write_bytes(b"")
    assert logos.buscar_en_disco(tmp_path, "AAPL") is None


# --- El monograma -------------------------------------------------------------


def test_las_iniciales_siempre_dan_algo():
    """Un hueco en blanco en una tabla se lee como error, no como «sin logo»."""
    assert logos.iniciales("AAPL") == "AA"
    assert logos.iniciales("F") == "F"
    assert logos.iniciales("") == "?"
    assert logos.iniciales("brk.b") == "BR"


# --- El endpoint --------------------------------------------------------------


def _cliente(tmp_path, perfil: dict | None, monkeypatch):
    """App real, con el directorio de logos apuntando a un tmp_path."""
    from fastapi.testclient import TestClient

    from app.deps import get_service
    from app.main import app
    from app.providers.base import DataNotFoundError
    from app.routers import stocks

    class _Servicio:
        def get(self, tipo, **kw):
            if tipo == "profile":
                if perfil is None:
                    raise DataNotFoundError("sin perfil")
                return perfil
            raise AssertionError(tipo)

    monkeypatch.setattr(stocks, "_directorio_de_logos", lambda: tmp_path)
    app.dependency_overrides[get_service] = lambda: _Servicio()
    cliente = TestClient(app, raise_server_exceptions=False)
    yield cliente
    app.dependency_overrides.clear()


def test_el_endpoint_sirve_el_logo_que_ya_esta_en_disco(tmp_path, monkeypatch):
    """Un logo no cambia: una vez descargado no se vuelve a pedir jamás."""
    logos.guardar(tmp_path, "AAPL", PNG, ".png")
    for c in _cliente(tmp_path, None, monkeypatch):  # sin perfil a propósito
        r = c.get("/api/stocks/AAPL/logo")
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/png"
        assert r.content == PNG
        assert "max-age" in r.headers.get("cache-control", "")


def test_sin_logo_en_el_perfil_se_devuelve_404_explicado(tmp_path, monkeypatch):
    """Un 404 aquí es lo NORMAL: la mayoría de las empresas no tienen logo."""
    for c in _cliente(tmp_path, {"symbol": "XYZ", "logo_url": None}, monkeypatch):
        r = c.get("/api/stocks/XYZ/logo")
        assert r.status_code == 404
        assert "no tiene logo" in r.json()["detail"]
        assert "iniciales" in r.json()["detail"]


def test_una_url_de_logo_hacia_dentro_de_la_red_se_rechaza(tmp_path, monkeypatch):
    """La defensa de verdad: el perfil viene de un tercero y podría apuntar
    al servicio de metadatos de la nube o al propio backend."""
    perfil = {"symbol": "MAL", "logo_url": "https://169.254.169.254/latest/meta-data/"}
    for c in _cliente(tmp_path, perfil, monkeypatch):
        r = c.get("/api/stocks/MAL/logo")
        assert r.status_code == 404
        assert "no pública" in r.json()["detail"]
        # Y no ha quedado nada escrito en disco.
        assert not list(tmp_path.glob("*"))


def test_un_simbolo_invalido_no_llega_ni_a_mirar_el_disco(tmp_path, monkeypatch):
    for c in _cliente(tmp_path, None, monkeypatch):
        assert c.get("/api/stocks/no-es-un-simbolo-larguisimo/logo").status_code == 422

"""Logos de empresa, descargados por el backend y servidos desde tu máquina.

## Por qué pasa por aquí y no va directo al navegador

Poner `<img src="https://cdn-de-un-tercero/AAPL.png">` habría sido una línea.
El precio de esa línea es que **tu navegador** pasa a pedirle una imagen a un
tercero cada vez que abres un valor, con tu IP y tu referer, y ese tercero
acaba con la lista de qué acciones miras y cuándo. Toda esta app está montada
sobre lo contrario —el navegador solo habla con tu backend— y un adorno no es
razón para romperlo.

Así que el backend descarga el logo una vez, lo guarda en disco y lo sirve. La
red externa la toca el servidor, no tú.

## Descargar una URL que te da un tercero es SSRF si no se acota

La URL sale de la respuesta de una API externa, así que es entrada no
confiable, y quien la descarga es un proceso dentro de tu red. Sin límites, un
`logo` manipulado apuntando a `http://169.254.169.254/` o a `http://localhost:8000/`
convertiría este endpoint en una forma de leer cosas desde dentro. Las cuatro
defensas, todas aquí y ninguna opcional:

1. **Solo https.** Nada de `file://`, `gopher://` ni http en claro.
2. **Nada de direcciones privadas.** Se resuelve el nombre y se rechaza
   loopback, enlace local, privadas y reservadas — que es lo que protege de
   los metadatos de una nube y de tu propia red.
3. **Tamaño acotado**, leyendo por trozos y abortando al pasarse: un
   `Content-Length` mentido no sirve de nada si no se comprueba lo que llega.
4. **Tiene que ser una imagen de verdad**, comprobada por los bytes de cabecera
   y no por lo que diga el `Content-Type`.
"""

from __future__ import annotations

import hashlib
import ipaddress
import socket
from pathlib import Path
from urllib.parse import urlparse

import httpx

# Un logo son unos pocos KB. 2 MB es holgado y sigue siendo un techo.
MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 8.0
TROZO = 64 * 1024

# Firmas por bytes de cabecera. El `Content-Type` lo escribe quien sirve el
# fichero, así que no es una comprobación: es una declaración de intenciones.
FIRMAS: list[tuple[bytes, str, str]] = [
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"GIF87a", "image/gif", ".gif"),
    (b"GIF89a", "image/gif", ".gif"),
    (b"RIFF", "image/webp", ".webp"),  # se confirma con 'WEBP' en el byte 8
]


class LogoRechazado(Exception):
    """La URL o el contenido no pasan los filtros. El motivo va en el mensaje."""


def _es_publica(host: str) -> bool:
    """¿El nombre resuelve a una dirección pública?

    Se resuelven TODAS las direcciones del nombre y se exige que todas sean
    públicas. Quedarse con la primera dejaría pasar un nombre que devuelve una
    pública y una privada según a quién pregunte.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise LogoRechazado(f"no se pudo resolver {host}: {exc}") from exc
    if not infos:
        raise LogoRechazado(f"{host} no resuelve a ninguna dirección")

    for info in infos:
        direccion = info[4][0]
        try:
            ip = ipaddress.ip_address(direccion)
        except ValueError:
            raise LogoRechazado(f"dirección ilegible para {host}: {direccion}") from None
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise LogoRechazado(
                f"{host} apunta a una dirección no pública ({ip}): el backend no "
                "descarga de su propia red."
            )
    return True


def validar_url(url: str) -> str:
    """Deja pasar solo https hacia un host público. Devuelve la URL normalizada."""
    if not url or not isinstance(url, str):
        raise LogoRechazado("no hay URL de logo")
    partes = urlparse(url.strip())
    if partes.scheme != "https":
        raise LogoRechazado(
            f"solo se descargan logos por https, y esta URL usa «{partes.scheme or 'nada'}»"
        )
    if not partes.hostname:
        raise LogoRechazado("la URL no tiene host")
    _es_publica(partes.hostname)
    return url.strip()


def _tipo_de_imagen(cabecera: bytes) -> tuple[str, str]:
    """Mime y extensión a partir de los BYTES. Lanza si no es una imagen."""
    for firma, mime, ext in FIRMAS:
        if cabecera.startswith(firma):
            if firma == b"RIFF" and cabecera[8:12] != b"WEBP":
                continue
            return mime, ext
    # SVG es texto: se acepta solo si empieza como XML/SVG, y aun así la UI lo
    # pinta dentro de un <img>, que no ejecuta el script que pueda llevar dentro.
    cabeza = cabecera[:256].lstrip().lower()
    if cabeza.startswith(b"<?xml") or cabeza.startswith(b"<svg"):
        return "image/svg+xml", ".svg"
    raise LogoRechazado(
        "lo descargado no es una imagen: los bytes de cabecera no corresponden a "
        "PNG, JPEG, GIF, WebP ni SVG, diga lo que diga el Content-Type."
    )


def descargar(url: str, cliente: httpx.Client | None = None) -> tuple[bytes, str, str]:
    """Descarga el logo con todos los límites puestos -> (bytes, mime, extensión)."""
    url = validar_url(url)
    propio = cliente is None
    cliente = cliente or httpx.Client(timeout=TIMEOUT, follow_redirects=False)
    try:
        with cliente.stream("GET", url) as resp:
            # Sin redirecciones: seguirlas reabriría todo lo que valida `validar_url`,
            # porque el destino de un 302 no pasa por ninguna de las comprobaciones.
            if resp.status_code in (301, 302, 303, 307, 308):
                raise LogoRechazado(
                    "la URL redirige, y el destino de una redirección no pasa por las "
                    "comprobaciones de arriba: no se sigue."
                )
            if resp.status_code != 200:
                raise LogoRechazado(f"el servidor respondió {resp.status_code}")

            declarado = resp.headers.get("content-length")
            if declarado and declarado.isdigit() and int(declarado) > MAX_BYTES:
                raise LogoRechazado(
                    f"el logo dice pesar {int(declarado) // 1024} KB y el techo son "
                    f"{MAX_BYTES // 1024} KB"
                )

            datos = bytearray()
            for trozo in resp.iter_bytes(TROZO):
                datos.extend(trozo)
                # Se comprueba lo que LLEGA, no lo que se anunció: un
                # Content-Length mentido es gratis para quien sirve el fichero.
                if len(datos) > MAX_BYTES:
                    raise LogoRechazado(
                        f"el logo supera los {MAX_BYTES // 1024} KB mientras se descargaba"
                    )
    except httpx.HTTPError as exc:
        raise LogoRechazado(f"fallo de red al descargar el logo: {exc}") from exc
    finally:
        if propio:
            cliente.close()

    if not datos:
        raise LogoRechazado("el logo llegó vacío")
    mime, ext = _tipo_de_imagen(bytes(datos[:512]))
    return bytes(datos), mime, ext


# --- Almacén en disco ---------------------------------------------------------


def ruta_de(directorio: Path, symbol: str, ext: str) -> Path:
    """Un fichero por símbolo, con el nombre saneado.

    El símbolo ya viene validado por el router, pero el nombre de fichero se
    construye a partir de un hash además del texto: así ningún símbolo raro
    puede escaparse del directorio por mucho que se cuele un `../`.
    """
    limpio = "".join(c for c in symbol.upper() if c.isalnum() or c in "-.")
    # Los puntos se conservan porque hay tíckers con punto (BRK.B, AAPL.MX),
    # pero no en racimo ni al principio: `..` no puede escapar del directorio
    # —el hash del final impide que el nombre sea nunca exactamente «..»— pero
    # sí deja ficheros ocultos y nombres ilegibles en el disco de alguien.
    while ".." in limpio:
        limpio = limpio.replace("..", ".")
    limpio = limpio.lstrip(".-") or "X"
    firma = hashlib.sha256(symbol.upper().encode()).hexdigest()[:8]
    return directorio / f"{limpio}-{firma}{ext}"


def buscar_en_disco(directorio: Path, symbol: str) -> tuple[Path, str] | None:
    """El logo ya descargado, si está. Devuelve (ruta, mime)."""
    for _, mime, ext in FIRMAS + [(b"", "image/svg+xml", ".svg")]:
        ruta = ruta_de(directorio, symbol, ext)
        if ruta.exists() and ruta.stat().st_size > 0:
            return ruta, mime
    return None


def guardar(directorio: Path, symbol: str, datos: bytes, ext: str) -> Path:
    directorio.mkdir(parents=True, exist_ok=True)
    ruta = ruta_de(directorio, symbol, ext)
    # Escritura atómica: media imagen en disco se serviría rota para siempre,
    # porque el propio fichero cuenta como «ya descargado».
    temporal = ruta.with_suffix(ruta.suffix + ".parcial")
    temporal.write_bytes(datos)
    temporal.replace(ruta)
    return ruta


def iniciales(symbol: str, nombre: str | None = None) -> str:
    """El monograma que se pinta cuando no hay logo.

    Existe porque la mayoría de las empresas pequeñas no tienen logo en ninguna
    fuente gratuita, y un hueco en blanco en una tabla se lee como «error» en
    vez de como «esta empresa no tiene logo». Dos letras siempre caben.
    """
    base = (symbol or "").strip().upper()
    return base[:2] if base else "?"

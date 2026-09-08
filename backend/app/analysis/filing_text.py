"""De un filing de la SEC a las secciones que se pueden leer.

Un 10-Q son entre 300 KB y 1 MB de HTML: tablas XBRL, hojas de estilo en línea,
etiquetas de inline-XBRL alrededor de cada cifra y, en medio, unas pocas páginas
que un humano leería. Mandar el documento entero a un modelo costaría entre diez
y treinta veces más que mandar las secciones que importan, y además diluiría lo
que se busca entre miles de líneas de tabla.

Así que aquí se hacen dos cosas: convertir el HTML a texto plano legible, y
localizar las secciones por su rótulo oficial. Los rótulos («Item 2.
Management's Discussion and Analysis») están fijados por la SEC en el formulario,
así que buscarlos es robusto de una forma que un heurístico sobre el contenido
nunca sería.

Lo que NO hace este módulo, a propósito:

- **No trunca en silencio.** Si una sección no cabe en el presupuesto, se dice
  cuánto sobra y quien llama decide. Cortar un MD&A por la mitad y analizarlo
  como si estuviera entero produce un análisis que parece completo y no lo está.
- **No adivina secciones.** Si el rótulo no aparece, la sección se marca como no
  encontrada. Devolver «lo que había alrededor de donde debería estar» sería
  inventar la estructura del documento.
"""

from __future__ import annotations

import html
import re
import unicodedata

# Secciones que interesan, por formulario. Los rótulos son los de la SEC.
#
# El 8-K es el caso raro y el más valioso: el comunicado de resultados viaja
# como anexo (EX-99.1) y suele traer el guidance explícito, con cifras, que en
# el 10-Q solo aparece en prosa. No tiene «Items» que localizar — se toma entero
# porque ya es corto.
SECCIONES = {
    "10-Q": [
        (
            "mdna",
            "Discusión y análisis de la dirección (MD&A)",
            r"item\s*2\.?\s*[—–\-]?\s*management.s\s+discussion",
            r"item\s*3\.?\s*[—–\-]?\s*quantitative",
        ),
        (
            "riesgos",
            "Factores de riesgo",
            r"item\s*1a\.?\s*[—–\-]?\s*risk\s+factors",
            r"item\s*2\.?\s*[—–\-]?\s*unregistered",
        ),
    ],
    "10-K": [
        (
            "mdna",
            "Discusión y análisis de la dirección (MD&A)",
            r"item\s*7\.?\s*[—–\-]?\s*management.s\s+discussion",
            r"item\s*7a\.?\s*[—–\-]?\s*quantitative",
        ),
        (
            "riesgos",
            "Factores de riesgo",
            r"item\s*1a\.?\s*[—–\-]?\s*risk\s+factors",
            r"item\s*1b\.?\s*[—–\-]?\s*unresolved",
        ),
    ],
    "8-K": [("completo", "Comunicado de resultados", None, None)],
}

# Un índice al principio del documento repite todos los rótulos, así que la
# PRIMERA aparición de «Item 2» casi siempre es la línea del índice, no la
# sección. Una sección real tiene cuerpo detrás; una entrada de índice, no.
MIN_LARGO_SECCION = 2000

# Lo que distingue un encabezado de verdad de una fila del índice o de una
# referencia cruzada es la MAQUETACIÓN, no el contenido ni la densidad:
#
#   índice:      «Item 2. Management's Discussion and Analysis      14»
#   referencia:  «...should be read together with Item 1A. Risk Factors.»
#   encabezado:  «Item 2. Management's Discussion and Analysis of Financial…»
#
# El encabezado ocupa su propia línea y no termina en un número de página. La
# referencia va a mitad de frase. La fila del índice arrastra su paginación.
# Probé antes con el largo de la sección (la fila del índice se tragaba entera
# la sección de riesgos y encima superaba el mínimo, así que el filtro la
# aprobaba) y con la densidad de rótulos cercanos (descartaba encabezados buenos,
# porque un MD&A real cita «see Item 1A» en su primer párrafo). Los dos miraban
# la señal equivocada.
_NUMERO_DE_PAGINA = re.compile(r"^\s*\d{1,3}\s*$")


def html_a_texto(bruto: str) -> str:
    """HTML de la SEC a texto plano, conservando la estructura de párrafos.

    Sin dependencias nuevas: los filings de EDGAR son HTML generado por unas
    pocas herramientas de reporting, no la web abierta, y una limpieza por
    expresiones regulares es suficiente y no añade una dependencia que haya que
    mantener por dos funciones.
    """
    texto = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", bruto)
    # Los saltos estructurales se conservan como saltos de línea: sin esto, el
    # texto queda como un único párrafo de 200 KB y los rótulos de sección
    # dejan de ser localizables por línea.
    texto = re.sub(r"(?i)<\s*(br|/p|/div|/tr|/h[1-6])\s*/?>", "\n", texto)
    texto = re.sub(r"(?i)<\s*/?\s*(td|th)\s*[^>]*>", " ", texto)
    texto = re.sub(r"(?s)<[^>]+>", "", texto)
    texto = html.unescape(texto)
    # Los filings vienen llenos de espacios duros y guiones tipográficos; se
    # normalizan para que las búsquedas por rótulo no dependan del carácter
    # exacto que usó la herramienta que generó el documento.
    texto = texto.replace("\xa0", " ")
    texto = unicodedata.normalize("NFKC", texto)
    texto = re.sub(r"[ \t]+", " ", texto)
    texto = re.sub(r"\n\s*\n\s*\n+", "\n\n", texto)
    return "\n".join(linea.strip() for linea in texto.split("\n")).strip()


def es_encabezado_real(texto: str, pos: int) -> bool:
    """¿El rótulo en `pos` abre la sección, o es índice / referencia cruzada?

    Tres condiciones, cada una descarta un caso concreto:

    1. **Empieza la línea.** Descarta «...as described in Item 1A. Risk Factors»,
       que va a mitad de frase.
    2. **Su línea no acaba en número de página.** Descarta «Item 2. MD&A … 14».
    3. **La línea siguiente no es un número suelto.** Descarta los índices que
       maquetan la paginación en su propia celda.
    """
    inicio_linea = texto.rfind("\n", 0, pos) + 1
    if texto[inicio_linea:pos].strip():
        return False  # hay texto delante: es una referencia dentro de una frase

    fin_linea = texto.find("\n", pos)
    linea = texto[pos:] if fin_linea == -1 else texto[pos:fin_linea]
    if re.search(r"\s\d{1,3}\s*$", linea):
        return False  # arrastra su número de página: es el índice

    siguiente = texto[fin_linea + 1 :].split("\n", 1)[0] if fin_linea != -1 else ""
    return not _NUMERO_DE_PAGINA.match(siguiente)


def _buscar_seccion(texto: str, inicio: str, fin: str | None) -> str | None:
    """La sección entre dos rótulos, saltándose índice y referencias cruzadas."""
    for m in re.finditer(inicio, texto, re.IGNORECASE):
        if not es_encabezado_real(texto, m.start()):
            continue
        resto = texto[m.start() :]
        if fin:
            f = re.search(fin, resto[100:], re.IGNORECASE)
            trozo = resto[: f.start() + 100] if f else resto
        else:
            trozo = resto
        # Segundo filtro: una sección de verdad tiene cuerpo. Los dos juntos —qué
        # viene detrás del rótulo y cuánto texto hay— cubren los dos casos que se
        # dan en filings reales: el índice del principio y las referencias
        # cruzadas («ver Item 1A») que aparecen sueltas dentro del texto.
        if len(trozo) >= MIN_LARGO_SECCION:
            return trozo.strip()
    return None


def extraer_secciones(html_bruto: str, tipo: str) -> dict:
    """Las secciones relevantes de un filing, con su tamaño y qué faltó.

    Devuelve siempre la misma forma para que quien llama pueda decidir con
    datos: qué se encontró, cuánto ocupa y qué no estaba. Una sección ausente se
    reporta como ausente — no se rellena con el texto de al lado.
    """
    texto = html_a_texto(html_bruto)
    definiciones = SECCIONES.get(tipo.upper(), [])
    secciones: dict[str, dict] = {}
    faltan: list[str] = []

    for clave, etiqueta, inicio, fin in definiciones:
        if inicio is None:
            contenido = texto
        else:
            contenido = _buscar_seccion(texto, inicio, fin)
        if contenido:
            secciones[clave] = {
                "etiqueta": etiqueta,
                "texto": contenido,
                "caracteres": len(contenido),
            }
        else:
            faltan.append(etiqueta)

    return {
        "tipo": tipo.upper(),
        "secciones": secciones,
        "faltan": faltan,
        "caracteres_totales": sum(s["caracteres"] for s in secciones.values()),
        "caracteres_documento": len(texto),
        "texto_completo": texto,
        "nota": (
            f"Localizadas {len(secciones)} de {len(definiciones)} secciones por su "
            "rótulo oficial de la SEC. Las que no aparecen se declaran ausentes en "
            "vez de rellenarse con el texto de alrededor."
            if definiciones
            else f"El formulario {tipo.upper()} no tiene secciones definidas aquí."
        ),
    }


# --- Presupuesto de texto -----------------------------------------------------
#
# ~3,7 caracteres por token es la relación típica del inglés financiero. Sirve
# para AVISAR antes de llamar al API, no para decidir por el usuario: la cuenta
# exacta la da `count_tokens` y es la que se enseña.

CARACTERES_POR_TOKEN = 3.7
LIMITE_CARACTERES = 400_000  # ~110k tokens: holgado dentro de la ventana


def cabe_en_presupuesto(caracteres: int, limite: int = LIMITE_CARACTERES) -> dict:
    """¿Cabe esto en una llamada, y si no, cuánto sobra?

    Existe para que la decisión de recortar sea explícita y del usuario. La
    alternativa —cortar por lo sano hasta que quepa— produce un análisis que
    parece completo, no lo está, y no lo dice en ninguna parte.
    """
    tokens = int(caracteres / CARACTERES_POR_TOKEN)
    return {
        "cabe": caracteres <= limite,
        "caracteres": caracteres,
        "tokens_estimados": tokens,
        "limite_caracteres": limite,
        "exceso_caracteres": max(0, caracteres - limite),
        "nota": (
            None
            if caracteres <= limite
            else (
                f"El texto ocupa {caracteres:,} caracteres (~{tokens:,} tokens) y el "
                f"tope es {limite:,}. No se recorta automáticamente: un análisis "
                "sobre media sección parece completo y no lo es."
            )
        ),
    }

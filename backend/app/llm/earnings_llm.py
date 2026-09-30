"""Extracción estructurada de reportes trimestrales con el API de Claude.

**Esto extrae hechos, no opina.** La regla no se deja al prompt: el esquema no
tiene ningún campo donde quepa una recomendación. No hay `accion`, ni
`valoracion`, ni `atractivo`. Un modelo no puede recomendar comprar en un JSON
que no tiene sitio para decirlo, y eso es una garantía más fuerte que pedirlo por
favor en el system prompt (que también se pide).

**Cada dato extraído viaja con su cita literal, y la cita se verifica contra el
documento.** Es la defensa concreta contra la alucinación: si el modelo dice que
la empresa elevó su previsión de ingresos, tiene que copiar la frase donde lo
dice, y esa frase tiene que aparecer en el texto que se le mandó. Lo que no pasa
la verificación se marca — no se borra, porque saber que el modelo se inventó una
cita es información sobre el análisis.

**Dos llamadas, y la segunda es barata.** La primera lee el documento y produce
el JSON del trimestre. La comparación entre trimestres recibe los DOS JSON, no
los dos documentos: cuesta una fracción y, sobre todo, es auditable, porque sus
entradas están guardadas y se pueden volver a leer.

**Lo aritmético se calcula en Python.** Cuando los dos trimestres dan cifras para
la misma métrica, la variación la hace el código. Al modelo se le pide alinear
lenguaje —«presiones en la cadena de suministro» y «restricciones de suministro»
son el mismo tema—, que es lo que sabe hacer y el código no.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Literal

from pydantic import BaseModel, Field

SYSTEM = """Eres un extractor de información de documentos financieros presentados a la SEC.

Tu única tarea es EXTRAER HECHOS del documento que se te da. No evalúas, no \
recomiendas, no predices y no valoras la empresa. No digas si algo es bueno o \
malo, ni si la acción está barata o cara, ni qué debería hacer un inversor. Si \
el documento no dice algo, no está: no lo completes con lo que sabes de la \
empresa por tu entrenamiento.

Reglas que no se negocian:

1. Cada elemento que extraigas incluye `texto_literal`: una copia EXACTA, \
palabra por palabra, de la frase del documento que lo respalda. Cópiala del \
texto que te he dado, sin reescribirla, sin traducirla y sin resumirla. Se \
verifica automáticamente contra el documento.
2. Si un dato no aparece en el documento, deja el campo en null. Un null es una \
respuesta correcta; una cifra inventada es un fallo grave.
3. Las cifras van tal como las da el documento, con su unidad y su periodo. No \
conviertas, no anualices, no estimes.
4. Distingue lo que la empresa PROYECTA (guidance) de lo que REPORTA (resultados \
del trimestre). Solo lo primero va en `guidance`.

El resto de los campos —resumen, temas, riesgos— se escriben en ESPAÑOL. \
`texto_literal` va siempre en el idioma original del documento, sin traducir, \
porque es una cita."""


# --- El esquema. Fijo, para poder comparar en el tiempo. ---------------------


class Guidance(BaseModel):
    """Una previsión de la dirección. Lo que proyecta, no lo que reportó."""

    metrica: str = Field(description="Qué se proyecta: ingresos, EPS, margen bruto…")
    periodo: str = Field(description="Periodo al que aplica, p. ej. «Q1 2026», «FY2026»")
    valor_bajo: float | None = Field(description="Extremo bajo del rango, si lo da")
    valor_alto: float | None = Field(description="Extremo alto del rango; si es un valor único, igual que valor_bajo")
    unidad: str | None = Field(description="«millones USD», «USD por acción», «%»…")
    texto_literal: str = Field(description="Cita EXACTA del documento que respalda esto")


class Riesgo(BaseModel):
    tema: str = Field(description="Etiqueta corta del riesgo, en español")
    descripcion: str = Field(description="Qué dice el documento, en español, sin valorarlo")
    texto_literal: str = Field(description="Cita EXACTA del documento")


class Tema(BaseModel):
    """Un asunto del que habla la dirección, con cuánto espacio le dedica."""

    tema: str = Field(description="Etiqueta corta del tema, en español")
    prominencia: Literal["alta", "media", "baja"] = Field(
        description="Cuánto espacio y énfasis le dedica el documento"
    )
    texto_literal: str = Field(description="Cita EXACTA del documento")


class AnalisisTrimestre(BaseModel):
    """Un trimestre extraído. Campos fijos: la misma forma cada vez.

    No hay campo de recomendación, ni de valoración, ni de perspectiva. No es un
    descuido: es el punto.
    """

    resumen: str = Field(description="Qué dice el documento, en 2-3 frases y en español. Sin juicios.")
    guidance: list[Guidance] = Field(description="Previsiones explícitas de la dirección. Vacío si no da ninguna.")
    riesgos: list[Riesgo] = Field(description="Riesgos que el documento menciona")
    temas: list[Tema] = Field(description="Asuntos de los que habla la dirección")
    menciona_guidance: bool = Field(description="Si el documento da alguna previsión explícita")


class CambioDeTema(BaseModel):
    tema: str = Field(description="Etiqueta del tema, en español")
    estado: Literal["aparece", "desaparece", "se_mantiene"] = Field(
        description="aparece = solo en el trimestre nuevo; desaparece = solo en el anterior"
    )
    texto_literal_nuevo: str | None = Field(description="Cita del trimestre nuevo, si aparece ahí")
    texto_literal_anterior: str | None = Field(description="Cita del trimestre anterior, si aparecía ahí")


class CambioDeGuidance(BaseModel):
    metrica: str
    periodo: str
    direccion: Literal["sube", "baja", "se_mantiene", "nueva", "retirada"] = Field(
        description="retirada = la daba antes y ya no; nueva = no la daba antes"
    )
    antes: str | None = Field(description="Valor anterior tal como lo daba el documento")
    ahora: str | None = Field(description="Valor nuevo tal como lo da el documento")


class Comparacion(BaseModel):
    """Qué cambió entre dos trimestres. Hechos y cambios, no lecturas."""

    cambios_de_guidance: list[CambioDeGuidance]
    cambios_de_tema: list[CambioDeTema]
    riesgos_nuevos: list[str] = Field(description="Riesgos del trimestre nuevo que no estaban antes")
    riesgos_que_desaparecen: list[str] = Field(description="Riesgos del anterior que ya no se mencionan")
    resumen_del_cambio: str = Field(description="Qué cambió, en español, 2-3 frases. Describe, no interpreta.")


# --- Verificación de citas ----------------------------------------------------


def _normalizar(texto: str) -> str:
    """Para comparar citas: el modelo copia bien, pero no byte a byte.

    Los filings vienen con espacios duros, comillas tipográficas y guiones largos
    que cambian según la herramienta que generó el documento. Comparar en crudo
    marcaría como inventadas citas que son correctas, y entonces el verificador
    dejaría de servir para nada porque nadie se creería sus avisos.
    """
    t = unicodedata.normalize("NFKC", texto).lower()
    t = t.replace("’", "'").replace("‘", "'")
    t = t.replace("“", '"').replace("”", '"')
    t = re.sub(r"[‐-―]", "-", t)
    return re.sub(r"\s+", " ", t).strip()


def verificar_citas(analisis: dict, fuente: str) -> dict:
    """Comprueba que cada `texto_literal` esté de verdad en el documento.

    Lo que no aparece se MARCA, no se borra: que el modelo se haya inventado una
    cita es información sobre la fiabilidad de ese análisis, y borrarla dejaría
    un resultado más limpio y menos veraz.
    """
    normalizada = _normalizar(fuente)
    total = verificadas = 0
    fallos: list[dict] = []

    def revisar(item: dict, donde: str) -> None:
        nonlocal total, verificadas
        cita = item.get("texto_literal")
        if not cita:
            return
        total += 1
        if _normalizar(cita) in normalizada:
            item["cita_verificada"] = True
            verificadas += 1
        else:
            item["cita_verificada"] = False
            fallos.append({"campo": donde, "cita": cita[:200]})

    for campo in ("guidance", "riesgos", "temas"):
        for item in analisis.get(campo) or []:
            if isinstance(item, dict):
                revisar(item, campo)

    return {
        "citas": total,
        "verificadas": verificadas,
        "fallidas": len(fallos),
        "fallos": fallos,
        "tasa": round(verificadas / total, 3) if total else None,
        "nota": (
            "Todas las citas se localizaron en el documento original."
            if total and not fallos
            else (
                f"{len(fallos)} de {total} citas NO se encontraron en el documento. "
                "Los elementos que las sostienen quedan marcados: una cita que no "
                "está en la fuente no respalda nada, y borrarla dejaría un "
                "resultado más limpio y menos veraz."
            )
            if fallos
            else "El análisis no produjo ninguna cita que verificar."
        ),
    }


# --- Variaciones aritméticas, en Python --------------------------------------


def variaciones_numericas(anterior: dict, nuevo: dict) -> list[dict]:
    """Cuánto cambió cada cifra de guidance, calculado por el código.

    Al modelo se le pide alinear lenguaje («presiones en la cadena de suministro»
    y «restricciones de suministro» son el mismo tema), que es lo que sabe hacer.
    La resta la hace Python, que no se equivoca nunca y no hay que verificarla.
    """
    def indexar(a: dict) -> dict[tuple[str, str], dict]:
        return {
            (g["metrica"].strip().lower(), g["periodo"].strip().lower()): g
            for g in (a.get("guidance") or [])
            if g.get("metrica") and g.get("periodo")
        }

    antes, ahora = indexar(anterior), indexar(nuevo)
    salida = []
    for clave in sorted(set(antes) & set(ahora)):
        a, b = antes[clave], ahora[clave]
        fila = {
            "metrica": b["metrica"],
            "periodo": b["periodo"],
            "unidad": b.get("unidad"),
            "antes_bajo": a.get("valor_bajo"),
            "antes_alto": a.get("valor_alto"),
            "ahora_bajo": b.get("valor_bajo"),
            "ahora_alto": b.get("valor_alto"),
        }
        # Se compara el punto medio del rango, y solo cuando los dos trimestres
        # dan cifras: sin números no hay variación que calcular, y estimar una
        # sería inventar la parte más citable del análisis.
        medios = [
            _medio(a.get("valor_bajo"), a.get("valor_alto")),
            _medio(b.get("valor_bajo"), b.get("valor_alto")),
        ]
        if medios[0] is not None and medios[1] is not None and medios[0] != 0:
            fila["variacion_pct"] = round((medios[1] / medios[0] - 1) * 100, 2)
            fila["direccion"] = (
                "sube" if medios[1] > medios[0]
                else "baja" if medios[1] < medios[0]
                else "se_mantiene"
            )
        else:
            fila["variacion_pct"] = None
            fila["direccion"] = None
            fila["motivo_sin_variacion"] = (
                "Uno de los dos trimestres no da cifra para esta métrica; la "
                "variación no se estima."
            )
        salida.append(fila)
    return salida


def _medio(bajo: float | None, alto: float | None) -> float | None:
    if bajo is None and alto is None:
        return None
    if bajo is None:
        return alto
    if alto is None:
        return bajo
    return (bajo + alto) / 2


def hash_documento(texto: str) -> str:
    """Identifica la versión exacta del texto analizado, para no reanalizarlo."""
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()[:16]


def prompt_extraccion(
    symbol: str, tipo: str, fecha: str, url: str, secciones: dict
) -> str:
    """El documento, seccionado y rotulado, con su procedencia."""
    partes = [
        f"Empresa: {symbol}",
        f"Formulario: {tipo}",
        f"Presentado a la SEC: {fecha}",
        f"Fuente: {url}",
        "",
        "Extrae la información del texto siguiente. Copia las citas de aquí, "
        "literalmente.",
        "",
    ]
    for clave, seccion in secciones.items():
        partes.append(f"===== {seccion['etiqueta']} ({clave}) =====")
        partes.append(seccion["texto"])
        partes.append("")
    return "\n".join(partes)


def prompt_comparacion(anterior: dict, nuevo: dict, meta_ant: dict, meta_nue: dict) -> str:
    """La comparación recibe los dos JSON, no los dos documentos.

    Cuesta una fracción y, sobre todo, es auditable: sus entradas están guardadas
    y se pueden volver a leer para comprobar de dónde salió cada cambio.
    """
    return (
        "Compara estos dos trimestres de la MISMA empresa, ya extraídos.\n\n"
        "Alinea los temas por SIGNIFICADO, no por las palabras exactas: "
        "«presiones en la cadena de suministro» y «restricciones de suministro» "
        "son el mismo tema y deben marcarse como «se_mantiene», no como uno que "
        "desaparece y otro que aparece.\n\n"
        "Describe lo que cambió. No lo interpretes, no digas si es bueno o malo "
        "y no recomiendes nada.\n\n"
        f"===== TRIMESTRE ANTERIOR ({meta_ant['tipo']}, {meta_ant['fecha']}) =====\n"
        f"{json.dumps(anterior, ensure_ascii=False, indent=2)}\n\n"
        f"===== TRIMESTRE NUEVO ({meta_nue['tipo']}, {meta_nue['fecha']}) =====\n"
        f"{json.dumps(nuevo, ensure_ascii=False, indent=2)}\n"
    )

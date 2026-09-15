"""Vigilancia de tesis: comprobar los puntos que TÚ escribiste.

Escribir «qué me haría cambiar de opinión» es la mitad fácil. La difícil es
acordarse de mirarlo dentro de ocho meses, cuando la empresa lleva subiendo un
año y la tesis se ha convertido en identidad. Este módulo hace esa mitad: cada
vez que hay datos nuevos comprueba los umbrales que escribiste y avisa cuando se
cruzan.

**Un disparador que salta NO es una señal de venta.** Es un recordatorio de que
tú, en un momento en que pensabas con más calma que ahora, dijiste que esto
importaba. Lo que hay que hacer al verlo es releer la tesis, no vender. La app
no opina sobre qué hacer: solo se acuerda de mirar.

Tres tipos, y el tercero es mucho peor que los otros dos:

- **`metrica`** — un ratio del último ejercicio contra un umbral. Sólido: sale de
  los estados financieros presentados a la SEC.
- **`crecimiento`** — un CAGR contra un umbral. Igual de sólido, más lento en
  reaccionar porque necesita ejercicios completos.
- **`noticia`** — palabras clave en titulares. **Esto es buscar palabras, no
  entender.** Dará falsos positivos («recall» en una noticia sobre otra empresa
  del titular) y se perderá lo que venga dicho de otra forma («revisión
  voluntaria del producto» no contiene «recall»). Sirve como red de arrastre
  gruesa, no como vigilancia. Va escrito en la salida para que nadie lo confunda
  con lo otro.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone

OPERADORES = {
    "lt": ("cae por debajo de", lambda v, u: v < u),
    "lte": ("baja hasta o por debajo de", lambda v, u: v <= u),
    "gt": ("sube por encima de", lambda v, u: v > u),
    "gte": ("sube hasta o por encima de", lambda v, u: v >= u),
}

# Métricas vigilables y cómo se leen. Solo las que salen de estados financieros:
# vigilar un múltiplo sería vigilar el precio, y para eso están las alertas.
METRICAS = {
    "operating_margin": ("Margen operativo", True),
    "net_margin": ("Margen neto", True),
    "gross_margin": ("Margen bruto", True),
    "fcf_margin": ("Margen de flujo de caja libre", True),
    "roe": ("ROE", True),
    "roic": ("ROIC", True),
    "debt_to_equity": ("Deuda / capital", False),
    "current_ratio": ("Ratio corriente", False),
    "interest_coverage": ("Cobertura de intereses", False),
}

CRECIMIENTOS = {
    "revenue_cagr": "Crecimiento de ingresos (CAGR)",
    "eps_cagr": "Crecimiento del beneficio por acción (CAGR)",
    "fcf_cagr": "Crecimiento del flujo de caja libre (CAGR)",
}

# Ventana de noticias que se mira. Más atrás sería repetir avisos ya vistos.
DIAS_NOTICIAS = 14
# Un titular tiene que traer la palabra entera, no como parte de otra: buscar
# «cae» dentro de «cadena» convertiría el vigilante en un generador de ruido.
_NO_PALABRA = r"(?:^|[^0-9a-záéíóúüñ])"


def _normalizar(texto: str) -> str:
    """Minúsculas y sin tildes, para que «investigación» case con «investigacion»."""
    t = unicodedata.normalize("NFD", texto.lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def _comprobar_umbral(valor: float | None, config: dict, etiqueta: str) -> dict | None:
    op = config.get("op")
    umbral = config.get("umbral")
    if op not in OPERADORES or umbral is None:
        return {
            "salta": False,
            "medible": False,
            "motivo": f"Disparador mal configurado: operador «{op}» o umbral ausente.",
        }
    if valor is None:
        return {
            "salta": False,
            "medible": False,
            "motivo": (
                f"{etiqueta} no se pudo calcular en el último ejercicio. No saber "
                "el dato no es lo mismo que estar por encima del umbral, así que "
                "el disparador queda sin comprobar en vez de darse por bueno."
            ),
        }
    texto_op, prueba = OPERADORES[op]
    salta = prueba(valor, umbral)
    return {
        "salta": salta,
        "medible": True,
        "valor": round(valor, 4),
        "umbral": umbral,
        "detalle": (
            f"{etiqueta} = {valor:.3f} y el umbral era {texto_op} {umbral:.3f}."
            + ("" if salta else " Todavía no lo cruza.")
        ),
    }


def evaluar_metrica(config: dict, ratios: list[dict]) -> dict:
    """Un ratio del último ejercicio contra su umbral."""
    clave = config.get("metrica")
    etiqueta = METRICAS.get(clave, (clave, True))[0]
    if not ratios:
        return {"salta": False, "medible": False,
                "motivo": "Sin estados financieros con los que comprobarlo."}
    resultado = _comprobar_umbral(ratios[-1].get(clave), config, etiqueta)
    resultado["ejercicio"] = ratios[-1].get("fiscal_year")
    # La tendencia acompaña al veredicto: cruzar el umbral bajando de tres años
    # de caídas no es lo mismo que cruzarlo tras un año malo aislado.
    serie = [r.get(clave) for r in ratios[-4:] if r.get(clave) is not None]
    if len(serie) >= 3:
        resultado["serie"] = [round(v, 4) for v in serie]
        resultado["tendencia"] = (
            "bajando" if serie[-1] < serie[0] else "subiendo" if serie[-1] > serie[0] else "plana"
        )
    return resultado


def evaluar_crecimiento(config: dict, crecimiento: dict) -> dict:
    clave = config.get("metrica")
    etiqueta = CRECIMIENTOS.get(clave, clave)
    return _comprobar_umbral(crecimiento.get(clave), config, etiqueta)


def evaluar_noticia(config: dict, noticias: list[dict], dias: int = DIAS_NOTICIAS) -> dict:
    """Palabras clave en titulares. Búsqueda de palabras, no comprensión.

    Se declara en cada resultado, porque la diferencia con los otros dos tipos es
    grande y no se ve: un disparador de margen que salta es un hecho de los
    estados financieros; este es una coincidencia de texto que puede ser
    cualquier cosa.
    """
    palabras = [p for p in (config.get("palabras") or []) if p.strip()]
    if not palabras:
        return {"salta": False, "medible": False,
                "motivo": "El disparador de noticias no tiene palabras que buscar."}

    corte = datetime.now(timezone.utc) - timedelta(days=dias)
    coincidencias = []
    revisados = 0
    for n in noticias:
        publicado = n.get("published_at")
        if publicado:
            try:
                fecha = datetime.fromisoformat(str(publicado).replace("Z", "+00:00"))
                if fecha.tzinfo is None:
                    fecha = fecha.replace(tzinfo=timezone.utc)
                if fecha < corte:
                    continue
            except ValueError:
                pass  # sin fecha legible se revisa igual: mejor mirarlo que saltárselo
        revisados += 1
        texto = _normalizar(f"{n.get('headline') or ''} {n.get('summary') or ''}")
        casadas = [
            p for p in palabras
            if re.search(_NO_PALABRA + re.escape(_normalizar(p)), texto)
        ]
        if casadas:
            coincidencias.append(
                {
                    "headline": n.get("headline"),
                    "url": n.get("url"),
                    "published_at": publicado,
                    "source": n.get("source"),
                    "palabras": casadas,
                }
            )

    return {
        "salta": bool(coincidencias),
        "medible": True,
        "coincidencias": coincidencias[:5],
        "titulares_revisados": revisados,
        "palabras": palabras,
        "detalle": (
            f"{len(coincidencias)} titular(es) de los últimos {dias} días contienen "
            f"{', '.join(sorted({p for c in coincidencias for p in c['palabras']}))}."
            if coincidencias
            else f"Ninguno de los {revisados} titulares de los últimos {dias} días "
            "contiene esas palabras."
        ),
        "aviso": (
            "Esto BUSCA PALABRAS, no entiende. Da falsos positivos (la palabra "
            "puede referirse a otra empresa del titular) y se pierde lo que venga "
            "dicho de otra forma («revisión voluntaria» no contiene «recall»). Es "
            "una red de arrastre gruesa, no vigilancia."
        ),
    }


def evaluar(disparador: dict, datos: dict) -> dict:
    """Un disparador contra los datos disponibles. -> el disparador con su veredicto."""
    kind = disparador.get("kind")
    config = disparador.get("config") or {}
    if kind == "metrica":
        r = evaluar_metrica(config, datos.get("ratios") or [])
    elif kind == "crecimiento":
        r = evaluar_crecimiento(config, datos.get("crecimiento") or {})
    elif kind == "noticia":
        r = evaluar_noticia(config, datos.get("noticias") or [])
    else:
        r = {"salta": False, "medible": False, "motivo": f"Tipo desconocido: {kind}"}
    return {**disparador, **r}


def vigilar(disparadores: list[dict], datos: dict) -> dict:
    """Todos los disparadores de una tesis, con el recuento de lo no medible.

    Lo que no se pudo comprobar se cuenta aparte y se dice. Meterlo en el mismo
    saco que «no salta» convertiría un fallo de datos en una tranquilidad: son
    cosas distintas y la diferencia importa justo cuando falta información.
    """
    resultados = [evaluar(d, datos) for d in disparadores if d.get("activo", True)]
    saltan = [r for r in resultados if r.get("salta")]
    sin_medir = [r for r in resultados if not r.get("medible")]

    return {
        "disparadores": resultados,
        "saltan": len(saltan),
        "sin_medir": len(sin_medir),
        "total": len(resultados),
        "nota": _resumen(len(saltan), len(sin_medir), len(resultados)),
    }


def _resumen(saltan: int, sin_medir: int, total: int) -> str:
    if total == 0:
        return (
            "Esta tesis no tiene ningún punto de invalidación vigilable. El texto "
            "libre sirve para pensar, pero nadie lo mira solo: añade al menos un "
            "umbral para que la app pueda avisarte."
        )
    partes = []
    if saltan:
        partes.append(
            f"{saltan} de {total} puntos de invalidación se han cruzado. Eso no es "
            "una señal de venta: es que tú, cuando pensabas con más calma, dijiste "
            "que esto importaba. Toca releer la tesis."
        )
    else:
        partes.append(f"Ninguno de los {total} puntos de invalidación se ha cruzado.")
    if sin_medir:
        partes.append(
            f"{sin_medir} no se pudieron comprobar por falta de datos — que no es "
            "lo mismo que estar bien."
        )
    return " ".join(partes)


# --- El registro de decisiones -------------------------------------------------


def instantanea(
    precio: float | None, vigilancia: dict, tesis: dict | None
) -> dict:
    """Lo que la app enseñaba en el momento de decidir.

    Es la parte que hace útil el registro. Reconstruir seis meses después qué
    sabías es imposible: la memoria reescribe el pasado para que encaje con lo
    que pasó, y uno acaba recordando dudas que no tuvo. Esto congela lo que
    había delante.
    """
    return {
        "precio": precio,
        "tesis": (
            {"id": tesis.get("id"), "titulo": tesis.get("title"),
             "creada": tesis.get("created_at")}
            if tesis
            else None
        ),
        "disparadores_saltando": [
            {"descripcion": d.get("descripcion"), "detalle": d.get("detalle")}
            for d in vigilancia.get("disparadores", [])
            if d.get("salta")
        ],
        "disparadores_totales": vigilancia.get("total", 0),
        "capturado_en": datetime.now(timezone.utc).isoformat(),
    }


def coherencia(decisiones: list[dict]) -> dict:
    """Lo que el propio registro dice de quien lo escribe.

    No juzga aciertos —para eso está `track_record`— sino disciplina: si la mitad
    de las compras no tienen tesis detrás, eso es un patrón que conviene ver
    escrito. Es incómodo y por eso vale.
    """
    if not decisiones:
        return {"decisiones": 0, "nota": "Todavía no hay ninguna decisión registrada."}

    sin_tesis = [d for d in decisiones if not d.get("thesis_id")]
    compras = [d for d in decisiones if d.get("accion") in ("comprar", "reforzar")]
    con_disparadores = [
        d for d in decisiones
        if (d.get("contexto") or {}).get("disparadores_saltando")
    ]
    avisos = []
    if sin_tesis:
        avisos.append(
            f"{len(sin_tesis)} de {len(decisiones)} decisiones no tienen una tesis "
            "enlazada. Una decisión sin tesis escrita es una que no se puede "
            "revisar después: dentro de un año no vas a recordar el porqué, vas a "
            "recordar el resultado."
        )
    compras_con_disparadores = [
        d for d in con_disparadores if d.get("accion") in ("comprar", "reforzar")
    ]
    if compras_con_disparadores:
        avisos.append(
            f"{len(compras_con_disparadores)} compra(s) se hicieron con puntos de "
            "invalidación ya saltando. Puede estar perfectamente justificado —los "
            "escribiste tú y puedes haber cambiado de opinión— pero conviene que "
            "el porqué esté escrito, porque es justo el caso que después cuesta "
            "explicar."
        )
    return {
        "decisiones": len(decisiones),
        "sin_tesis": len(sin_tesis),
        "compras": len(compras),
        "con_disparadores_activos": len(con_disparadores),
        "avisos": avisos,
        "nota": " ".join(avisos)
        or "Todas las decisiones registradas tienen su tesis y su razonamiento.",
    }

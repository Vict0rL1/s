"""Los dos papeles legítimos del LLM en el motor de señales.

1. **Extraer eventos** de noticias a estructura (un factor más del modelo).
2. **Explicar** una señal ya calculada, en lenguaje natural.

Lo que el LLM NUNCA hace aquí: producir la puntuación, la dirección o la
probabilidad. Esos números salen del motor estadístico; el LLM los lee, no
los inventa. Un modelo de lenguaje no tiene capacidad predictiva sobre
precios, y dejarle emitir la señal convertiría el motor en teatro.
"""

from __future__ import annotations

import json

from app.llm.base import LLMProvider, LLMUnavailableError

# Categorías de evento con su signo. El LLM clasifica; el peso numérico lo
# fija esta tabla, no el modelo — así el factor es auditable y estable.
EVENT_WEIGHTS = {
    "guidance_al_alza": 1.0,
    "guidance_a_la_baja": -1.0,
    "resultados_mejor_de_lo_esperado": 0.6,
    "resultados_peor_de_lo_esperado": -0.6,
    "riesgo_regulatorio_o_legal": -0.8,
    "cambio_en_la_direccion": -0.2,
    "operacion_corporativa": 0.3,
    "recompra_o_dividendo_al_alza": 0.4,
    "dilucion_o_ampliacion_de_capital": -0.4,
    "irrelevante_para_la_tesis": 0.0,
}

EXTRACTION_SYSTEM = f"""Clasificas noticias financieras en eventos estructurados \
para alimentar un modelo cuantitativo. NO predices precios ni recomiendas operar.

Para cada noticia devuelve un objeto JSON con:
- "category": exactamente una de {list(EVENT_WEIGHTS)}
- "confidence": "alta" | "media" | "baja" — cuánta certeza da el titular sobre \
la categoría. Si el titular es ambiguo o especulativo, usa "baja".
- "rationale": máximo 20 palabras explicando la clasificación.

Reglas:
- Un rumor o especulación NO es un hecho: baja confianza.
- Si la noticia no afecta a los fundamentales, usa "irrelevante_para_la_tesis".
- Devuelve SOLO el JSON, sin texto alrededor.

Responde con un array JSON, un objeto por noticia, en el mismo orden."""

EXPLANATION_SYSTEM = """Explicas a un estudiante de finanzas por qué un modelo \
cuantitativo puntuó a una empresa como lo hizo. Recibes factores YA CALCULADOS.

Reglas estrictas:
- NUNCA inventes ni ajustes números: usa exactamente los que te doy.
- NUNCA recomiendes comprar o vender, ni des precio objetivo.
- Explica qué factor tira hacia arriba y cuál hacia abajo, y qué significa \
económicamente (no repitas el número: di qué implica).
- Señala explícitamente la principal debilidad del análisis: baja cobertura de \
datos, muestra pequeña, o un factor que domina al resto.
- Termina con qué habría que vigilar para invalidar esta lectura.
- Máximo 180 palabras, español, Markdown simple sin encabezados."""

CONFIDENCE_MULTIPLIER = {"alta": 1.0, "media": 0.6, "baja": 0.3}


def extract_events(llm: LLMProvider, items: list[dict]) -> list[dict]:
    """Clasifica noticias en eventos estructurados.

    Ante cualquier fallo devuelve lista vacía: el factor de sentimiento
    simplemente no estará disponible y el compuesto se renormaliza. Degradar
    es correcto; inventar un sentimiento neutro no lo es.
    """
    if not items:
        return []
    payload = "\n".join(
        f"{i + 1}. {item.get('headline', '')} — {(item.get('summary') or '')[:200]}"
        for i, item in enumerate(items[:15])  # tope: acota el coste por llamada
    )
    try:
        result = llm.interpret(EXTRACTION_SYSTEM, payload)
    except LLMUnavailableError:
        return []

    text = result["content"].strip()
    if text.startswith("```"):  # el modelo a veces envuelve en un bloque
        text = text.split("```")[1].removeprefix("json").strip()
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, IndexError):
        return []
    if not isinstance(parsed, list):
        return []

    events = []
    for i, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            continue
        category = entry.get("category")
        if category not in EVENT_WEIGHTS:
            continue
        events.append(
            {
                "headline": items[i].get("headline") if i < len(items) else None,
                "category": category,
                "confidence": entry.get("confidence", "baja"),
                "rationale": entry.get("rationale"),
                "weight": EVENT_WEIGHTS[category],
                "model": result["model"],
            }
        )
    return events


def sentiment_from_events(events: list[dict]) -> float | None:
    """Convierte eventos clasificados en un único factor de sentimiento.

    Media de pesos ajustada por confianza. Sin eventos con señal (todos
    irrelevantes o lista vacía) devuelve None, no 0: "sin noticias" y
    "noticias neutras" no son lo mismo para el modelo.
    """
    scored = [
        e["weight"] * CONFIDENCE_MULTIPLIER.get(e.get("confidence", "baja"), 0.3)
        for e in events
        if e.get("category") != "irrelevante_para_la_tesis"
    ]
    if not scored:
        return None
    return sum(scored) / len(scored)


def explain_signal(llm: LLMProvider, signal: dict, context: dict) -> dict:
    """Explicación en lenguaje natural de una señal ya calculada."""
    contributions = "\n".join(
        f"- {family}: contribución {value:+.2f}"
        for family, value in (signal.get("contributions") or {}).items()
    )
    prompt = f"""Empresa: {signal['symbol']} ({context.get('name') or 'sin nombre'})
Sector: {context.get('sector') or 'desconocido'}
Horizonte del modelo: {signal.get('horizon')}

Puntuación compuesta (z-score frente al universo): {signal.get('score'):+.2f}
Etiqueta del modelo: {signal.get('label')}
Cobertura de datos: {signal.get('coverage', 0) * 100:.0f} % de los factores
Probabilidad calibrada: {
    f"{signal['probability'] * 100:.0f} % (IC {signal['probability_ci'][0] * 100:.0f}–{signal['probability_ci'][1] * 100:.0f} %, n={signal['sample_size']})"
    if signal.get("probability") is not None
    else "NO DISPONIBLE — el modelo no está calibrado para este rango"
}

Contribución por familia de factores:
{contributions or "(sin desglose)"}

Explica esta lectura."""

    result = llm.interpret(EXPLANATION_SYSTEM, prompt)
    return {
        "generated_by": "llm",  # etiquetado obligatorio: esto SÍ es de IA
        "content_md": result["content"],
        "model": result["model"],
        "disclaimer": (
            "Explicación generada por IA de factores calculados por el modelo "
            "estadístico. La IA no produjo la puntuación ni la probabilidad, y "
            "puede malinterpretar el contexto."
        ),
    }

"""De puntuación compuesta a señal, con probabilidad calibrada o sin ella.

La regla que gobierna este módulo: **una probabilidad solo se muestra si
sale de un backtest con observaciones suficientes.** Sin calibración, la app
enseña la puntuación y dice explícitamente que no hay probabilidad estimada.
Inventar un "72 % de subida" a partir de un z-score sería exactamente la
falsa precisión que esta app existe para evitar.
"""

from __future__ import annotations

import math

# Etiquetas cualitativas. Deliberadamente NO son "comprar"/"vender": la señal
# describe cómo puntúa la empresa en el modelo, no qué debes hacer con tu
# dinero, que depende de tu cartera, tu horizonte y tu tolerancia al riesgo.
LABEL_THRESHOLDS = [
    (1.0, "muy favorable"),
    (0.35, "favorable"),
    (-0.35, "neutral"),
    (-1.0, "desfavorable"),
]

# Mínimo de observaciones en un bucket para publicar su tasa de acierto.
# Por debajo de esto el intervalo de confianza es tan ancho que el número
# no informa de nada.
MIN_OBSERVATIONS = 30


def label_for(score: float | None) -> str:
    if score is None:
        return "sin datos"
    for threshold, label in LABEL_THRESHOLDS:
        if score >= threshold:
            return label
    return "muy desfavorable"


def wilson_interval(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Intervalo de Wilson al 95 % para una proporción.

    Se usa en lugar de la aproximación normal porque con n pequeño o tasas
    cerca de 0/1 la normal produce intervalos que se salen de [0, 1] y
    subestima la incertidumbre — justo el régimen en el que va a operar
    este modelo durante mucho tiempo.
    """
    if n == 0:
        return (0.0, 1.0)
    p = hits / n
    denom = 1 + z**2 / n
    center = (p + z**2 / (2 * n)) / denom
    margin = z * math.sqrt(p * (1 - p) / n + z**2 / (4 * n**2)) / denom
    return (max(center - margin, 0.0), min(center + margin, 1.0))


def bucket_of(score: float) -> str:
    """Discretiza el compuesto en cubos para la calibración empírica."""
    if score >= 1.0:
        return "muy_alto"
    if score >= 0.35:
        return "alto"
    if score >= -0.35:
        return "medio"
    if score >= -1.0:
        return "bajo"
    return "muy_bajo"


def calibrate(observations: list[dict]) -> dict[str, dict]:
    """Tabla de calibración empírica a partir del backtest.

    `observations`: [{score, outperformed: bool}]. Devuelve, por cubo, la
    tasa de acierto histórica con su intervalo de Wilson.
    """
    buckets: dict[str, list[bool]] = {}
    for obs in observations:
        if obs.get("score") is None or obs.get("outperformed") is None:
            continue
        buckets.setdefault(bucket_of(obs["score"]), []).append(bool(obs["outperformed"]))

    table = {}
    for bucket, outcomes in buckets.items():
        n = len(outcomes)
        hits = sum(outcomes)
        low, high = wilson_interval(hits, n)
        table[bucket] = {
            "n": n,
            "hits": hits,
            "rate": hits / n if n else None,
            "ci_low": low,
            "ci_high": high,
            "reliable": n >= MIN_OBSERVATIONS,
        }
    return table


def build_signal(
    symbol: str,
    composite: dict,
    calibration: dict[str, dict] | None = None,
    horizon: str = "6-12 meses",
) -> dict:
    """Ensambla la señal final de un símbolo.

    `probability` solo aparece si hay calibración fiable para su cubo; en
    caso contrario es None y `probability_note` explica por qué.
    """
    score = composite.get("score")
    signal = {
        "symbol": symbol,
        "score": score,
        "label": label_for(score),
        "coverage": composite.get("coverage", 0.0),
        "contributions": composite.get("contributions", {}),
        "families": composite.get("families", {}),
        "horizon": horizon,
        "probability": None,
        "probability_ci": None,
        "probability_note": None,
        "sample_size": 0,
        "computed_by": "modelo cuantitativo",  # nunca "generado por IA"
    }

    if score is None:
        signal["probability_note"] = (
            "Sin datos suficientes para puntuar esta empresa contra el universo."
        )
        return signal

    bucket = bucket_of(score)
    entry = (calibration or {}).get(bucket)
    if entry is None or not entry.get("reliable"):
        n = entry["n"] if entry else 0
        signal["sample_size"] = n
        signal["probability_note"] = (
            f"Modelo sin calibrar para este rango ({n} observaciones históricas, "
            f"mínimo {MIN_OBSERVATIONS}). Se muestra la puntuación relativa, no "
            "una probabilidad: con esta muestra cualquier porcentaje sería ruido."
        )
        return signal

    signal["probability"] = entry["rate"]
    signal["probability_ci"] = [entry["ci_low"], entry["ci_high"]]
    signal["sample_size"] = entry["n"]
    signal["probability_note"] = (
        f"Frecuencia histórica con la que empresas en este rango superaron a la "
        f"mediana del universo a {horizon}, sobre {entry['n']} observaciones "
        "fuera de muestra. No es una predicción sobre esta empresa en concreto."
    )
    return signal


def rank_universe(signals: list[dict]) -> list[dict]:
    """Ordena señales por puntuación, dejando al final las no puntuables."""
    scored = [s for s in signals if s.get("score") is not None]
    unscored = [s for s in signals if s.get("score") is None]
    scored.sort(key=lambda s: s["score"], reverse=True)
    for i, signal in enumerate(scored, start=1):
        signal["rank"] = i
    return scored + unscored

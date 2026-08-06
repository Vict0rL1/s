"""Registro de aciertos: evalúa cómo envejecieron escenarios y tesis.

Este es el módulo que le pone honestidad a la app. Cada escenario se guardó
con su precio de creación; aquí se compara contra el precio actual y se
clasifica el resultado sin adornos. Si el modelo (o el usuario) falla
seguido, el resumen lo enseña.
"""

from __future__ import annotations

from datetime import datetime, timezone


def _as_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def days_elapsed(created_at: datetime, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    return max((now - _as_utc(created_at)).days, 0)


def classify_scenario(scenario: dict, current_price: float | None) -> dict:
    """Clasifica un escenario contra el precio actual.

    - `direction`: qué implicaba el escenario respecto al precio de creación
      (alcista si el valor estimado estaba por encima, bajista si por debajo).
    - `outcome`: si el precio se movió en esa dirección (`acertado`),
      en contra (`fallido`), o si no hay suficiente información.

    Sin precio actual o sin valor estimado, `outcome` es None — la app no
    inventa un veredicto.
    """
    anchor = scenario.get("price_at_creation")
    estimate = scenario.get("value_mid")
    if anchor is None or estimate is None or current_price is None:
        return {
            "direction": None,
            "outcome": None,
            "price_change_pct": (
                (current_price / anchor - 1) if anchor and current_price is not None else None
            ),
            "implied_upside_pct": (estimate / anchor - 1) if anchor and estimate is not None else None,
            "reason": "Faltan datos para evaluar (precio ancla, valor estimado o precio actual)",
        }

    implied = estimate / anchor - 1
    actual = current_price / anchor - 1
    direction = "alcista" if implied > 0 else "bajista" if implied < 0 else "neutral"

    if direction == "neutral":
        outcome = None
    elif direction == "alcista":
        outcome = "acertado" if actual > 0 else "fallido"
    else:
        outcome = "acertado" if actual < 0 else "fallido"

    return {
        "direction": direction,
        "outcome": outcome,
        "price_change_pct": actual,
        "implied_upside_pct": implied,
        # Error absoluto entre lo estimado y lo que hizo el precio: la magnitud
        # importa tanto como la dirección.
        "estimate_error_pct": abs(estimate - current_price) / current_price,
        "reason": None,
    }


def track_record_summary(evaluated: list[dict]) -> dict:
    """Resumen agregado del registro. Cuenta solo lo evaluable.

    `hit_rate` es None cuando no hay escenarios evaluables — un registro
    vacío no es un 0 % ni un 100 %.
    """
    scored = [e for e in evaluated if e.get("outcome") in {"acertado", "fallido"}]
    hits = sum(1 for e in scored if e["outcome"] == "acertado")
    errors = [
        e["estimate_error_pct"] for e in evaluated if e.get("estimate_error_pct") is not None
    ]
    return {
        "total": len(evaluated),
        "evaluable": len(scored),
        "hits": hits,
        "misses": len(scored) - hits,
        "hit_rate": (hits / len(scored)) if scored else None,
        "median_estimate_error_pct": _median(errors),
        "note": (
            "Acertar la dirección no valida el razonamiento: con pocas "
            "observaciones, el azar explica buena parte del resultado."
        ),
    }


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2

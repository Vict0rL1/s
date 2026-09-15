"""Lógica del screener: filtros combinables sobre métricas fundamentales.

Filtros = {clave_métrica: {"op": "gte"|"lte", "value": float}}. Un dato
ausente NUNCA pasa el filtro que lo requiere — no filtrar por lo que no se
sabe — y el resultado detalla qué filtro falló para que la decisión sea
auditable.
"""

from __future__ import annotations

VALID_OPS = {"gte", "lte"}


def evaluate_filters(metrics: dict, filters: dict[str, dict]) -> dict:
    """-> {passes: bool, checks: [{metric, op, value, actual, passed}]}"""
    checks = []
    for metric, spec in filters.items():
        op = spec.get("op")
        if op not in VALID_OPS:
            raise ValueError(f"Operador inválido para {metric}: {op}")
        threshold = float(spec["value"])
        actual = metrics.get(metric)
        if actual is None:
            passed = False  # sin dato no hay veredicto favorable
        elif op == "gte":
            passed = actual >= threshold
        else:
            passed = actual <= threshold
        checks.append(
            {"metric": metric, "op": op, "value": threshold, "actual": actual, "passed": passed}
        )
    return {"passes": all(c["passed"] for c in checks) if checks else True, "checks": checks}


# Presets iniciales. Cada uno documenta su lógica (requisito de la app):
# el screener no es una caja negra, la racionalidad viaja con el preset.
DEFAULT_PRESETS = [
    {
        "name": "Value con balance sólido",
        "logic_md": (
            "Busca empresas baratas por beneficios (P/E ≤ 18) que no dependan de "
            "deuda (deuda/capital ≤ 1) y con liquidez de corto plazo sana (ratio "
            "corriente ≥ 1.2) y rentabilidad real (ROE ≥ 10 %). La trampa clásica "
            "del value es comprar barato lo que está barato por algo: el balance "
            "filtra parte de esas trampas."
        ),
        "filters": {
            "pe_ttm": {"op": "lte", "value": 18},
            "debt_to_equity": {"op": "lte", "value": 1.0},
            "current_ratio": {"op": "gte", "value": 1.2},
            "roe": {"op": "gte", "value": 0.10},
        },
    },
    {
        "name": "Crecimiento a precio razonable (GARP)",
        "logic_md": (
            "Crecimiento de ingresos ≥ 8 % anual (5A) con ROE ≥ 12 %, pero sin "
            "pagar cualquier múltiplo: P/E ≤ 25. La idea de Lynch: crecimiento sí, "
            "pero comprado con disciplina de precio."
        ),
        "filters": {
            "revenue_growth_5y": {"op": "gte", "value": 0.08},
            "roe": {"op": "gte", "value": 0.12},
            "pe_ttm": {"op": "lte", "value": 25},
        },
    },
    {
        "name": "Dividendos sostenibles",
        "logic_md": (
            "Rentabilidad por dividendo ≥ 2.5 % respaldada por margen neto ≥ 8 % y "
            "deuda contenida (deuda/capital ≤ 1.5). Un dividendo alto sin margen ni "
            "balance detrás es un recorte anunciado."
        ),
        "filters": {
            "dividend_yield": {"op": "gte", "value": 0.025},
            "net_margin": {"op": "gte", "value": 0.08},
            "debt_to_equity": {"op": "lte", "value": 1.5},
        },
    },
]

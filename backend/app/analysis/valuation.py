"""Valoración por DCF con supuestos explícitos y análisis de sensibilidad.

Principio rector de la app aplicado al código: el DCF nunca devuelve "el
precio objetivo"; devuelve un valor por escenario con TODOS los supuestos de
entrada visibles, más una matriz de sensibilidad que enseña cuánto se mueve
el resultado al tocar cada supuesto. La falsa precisión es el enemigo.
"""

from __future__ import annotations


def dcf(
    base_fcf: float,
    growth_rate: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
    shares_outstanding: float | None = None,
) -> dict:
    """DCF de dos etapas: crecimiento constante `years` años + valor terminal
    (Gordon). Devuelve el detalle completo de la proyección.

    Restricciones: discount_rate > terminal_growth (si no, el valor terminal
    diverge — error clásico) y years >= 1.
    """
    if years < 1:
        raise ValueError("years debe ser >= 1")
    if discount_rate <= terminal_growth:
        raise ValueError(
            "La tasa de descuento debe ser mayor que el crecimiento terminal "
            "(si no, el valor terminal es infinito)"
        )

    projections = []
    pv_sum = 0.0
    fcf = base_fcf
    for year in range(1, years + 1):
        fcf = fcf * (1 + growth_rate)
        pv = fcf / (1 + discount_rate) ** year
        pv_sum += pv
        projections.append({"year": year, "fcf": fcf, "present_value": pv})

    terminal_fcf = fcf * (1 + terminal_growth)
    terminal_value = terminal_fcf / (discount_rate - terminal_growth)
    pv_terminal = terminal_value / (1 + discount_rate) ** years

    enterprise_value = pv_sum + pv_terminal
    equity_value = enterprise_value - net_debt
    per_share = (
        equity_value / shares_outstanding
        if shares_outstanding and shares_outstanding > 0
        else None
    )
    return {
        "assumptions": {
            "base_fcf": base_fcf,
            "growth_rate": growth_rate,
            "discount_rate": discount_rate,
            "terminal_growth": terminal_growth,
            "years": years,
            "net_debt": net_debt,
            "shares_outstanding": shares_outstanding,
        },
        "projections": projections,
        "terminal_value": terminal_value,
        "pv_terminal": pv_terminal,
        "pv_explicit": pv_sum,
        "terminal_weight": pv_terminal / enterprise_value if enterprise_value else None,
        "enterprise_value": enterprise_value,
        "equity_value": equity_value,
        "value_per_share": per_share,
    }


def sensitivity_grid(
    base_fcf: float,
    growth_rate: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
    shares_outstanding: float | None = None,
    step: float = 0.01,
) -> dict:
    """Matriz de valor/acción variando WACC (filas) y crecimiento (columnas)
    en ±2 puntos. Enseña qué tan sensible es el resultado a cada supuesto —
    si la matriz se mueve mucho, el número central vale poco."""
    rates = [round(discount_rate + i * step, 6) for i in range(-2, 3)]
    growths = [round(growth_rate + i * step, 6) for i in range(-2, 3)]
    rows = []
    for r in rates:
        cells: list[float | None] = []
        for g in growths:
            if r <= terminal_growth:
                cells.append(None)  # combinación inválida: terminal diverge
                continue
            result = dcf(
                base_fcf, g, r, terminal_growth, years, net_debt, shares_outstanding
            )
            cells.append(result["value_per_share"] or result["equity_value"])
        rows.append({"discount_rate": r, "values": cells})
    return {"growth_rates": growths, "rows": rows}


def scenario_set(
    scenarios: dict[str, dict],
    base_fcf: float,
    years: int,
    net_debt: float,
    shares_outstanding: float | None,
) -> dict:
    """Evalúa bajista/base/alcista con un DCF por escenario. `scenarios` mapea
    nombre -> {growth_rate, discount_rate, terminal_growth}."""
    out = {}
    for name, assumptions in scenarios.items():
        result = dcf(
            base_fcf=base_fcf,
            growth_rate=assumptions["growth_rate"],
            discount_rate=assumptions["discount_rate"],
            terminal_growth=assumptions["terminal_growth"],
            years=years,
            net_debt=net_debt,
            shares_outstanding=shares_outstanding,
        )
        out[name] = {
            "assumptions": result["assumptions"],
            "value_per_share": result["value_per_share"],
            "equity_value": result["equity_value"],
            "terminal_weight": result["terminal_weight"],
        }
    return out

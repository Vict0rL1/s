"""Salud financiera: Altman Z-score, Piotroski F-score, cobertura de intereses.

Cada score devuelve sus componentes y señales una a una: el número final sin
el desglose invita a confiar a ciegas, que es justo lo que esta app evita.
"""

from __future__ import annotations

from app.analysis.fundamentals import _div, free_cash_flow, total_debt


def altman_z(period: dict, market_cap: float | None) -> dict:
    """Altman Z-score (fórmula original de 1968, para empresas industriales
    cotizadas). Zonas: > 2.99 segura, 1.81–2.99 gris, < 1.81 riesgo.

    Devuelve los cinco componentes; si falta algún insumo, el score es None y
    el desglose muestra cuál faltó. Para financieras/bancos el Z-score no es
    aplicable y la UI debe decirlo.
    """
    ta = period.get("total_assets")
    tl = period.get("total_liabilities")
    wc = None
    if period.get("current_assets") is not None and period.get("current_liabilities") is not None:
        wc = period["current_assets"] - period["current_liabilities"]

    components = {
        "x1_working_capital_over_assets": _div(wc, ta),
        "x2_retained_earnings_over_assets": _div(period.get("retained_earnings"), ta),
        "x3_ebit_over_assets": _div(period.get("operating_income"), ta),
        "x4_market_cap_over_liabilities": _div(market_cap, tl),
        "x5_sales_over_assets": _div(period.get("revenue"), ta),
    }
    weights = [1.2, 1.4, 3.3, 0.6, 1.0]
    values = list(components.values())
    score = None
    if all(v is not None for v in values):
        score = sum(w * v for w, v in zip(weights, values))

    zone = None
    if score is not None:
        zone = "segura" if score > 2.99 else "gris" if score >= 1.81 else "riesgo"
    return {
        "score": score,
        "zone": zone,
        "components": components,
        "note": "Fórmula original (1968) para industriales cotizadas; no aplicable a bancos/financieras.",
    }


def piotroski_f(periods: list[dict]) -> dict:
    """Piotroski F-score (0–9) sobre los dos últimos ejercicios anuales.

    Cada señal se reporta con su resultado (True/False/None si no evaluable);
    el score cuenta solo señales evaluables y `max_possible` dice cuántas
    fueron, para no disfrazar datos incompletos de mala salud.
    """
    if len(periods) < 2:
        return {"score": None, "max_possible": 0, "signals": [], "note": "Se necesitan dos ejercicios anuales."}
    prev, curr = periods[-2], periods[-1]

    def roa(p):
        return _div(p.get("net_income"), p.get("total_assets"))

    def leverage(p):
        return _div(p.get("long_term_debt"), p.get("total_assets"))

    def current_ratio(p):
        return _div(p.get("current_assets"), p.get("current_liabilities"))

    def gross_margin(p):
        return _div(p.get("gross_profit"), p.get("revenue"))

    def asset_turnover(p):
        return _div(p.get("revenue"), p.get("total_assets"))

    def compare(name, a, b, op, detail):
        if a is None or b is None:
            return {"name": name, "passed": None, "detail": f"{detail}: sin datos"}
        passed = a > b if op == "gt" else a < b
        return {"name": name, "passed": passed, "detail": detail}

    roa_curr, roa_prev = roa(curr), roa(prev)
    cfo = curr.get("cfo")
    ni = curr.get("net_income")

    signals = [
        compare("Rentabilidad: ROA positivo", roa_curr, 0.0, "gt", "ROA del último ejercicio > 0"),
        compare("Rentabilidad: CFO positivo", cfo, 0.0, "gt", "Flujo de caja operativo > 0"),
        compare("Rentabilidad: ROA en mejora", roa_curr, roa_prev, "gt", "ROA sube vs. ejercicio anterior"),
        compare("Calidad: CFO > beneficio neto", cfo, ni, "gt", "Caja operativa mayor que beneficio (menos devengos)"),
        compare("Apalancamiento: deuda LP baja", leverage(curr), leverage(prev), "lt", "Deuda a largo plazo / activos baja"),
        compare("Liquidez: ratio corriente sube", current_ratio(curr), current_ratio(prev), "gt", "Ratio corriente mejora"),
        compare(
            "Dilución: sin nuevas acciones",
            prev.get("shares_outstanding"),
            curr.get("shares_outstanding") - 1 if curr.get("shares_outstanding") is not None else None,
            "gt",
            "Acciones en circulación no aumentan",
        ),
        compare("Eficiencia: margen bruto sube", gross_margin(curr), gross_margin(prev), "gt", "Margen bruto mejora"),
        compare("Eficiencia: rotación de activos sube", asset_turnover(curr), asset_turnover(prev), "gt", "Ingresos/activos mejora"),
    ]
    evaluable = [s for s in signals if s["passed"] is not None]
    return {
        "score": sum(1 for s in evaluable if s["passed"]),
        "max_possible": len(evaluable),
        "signals": signals,
        "fiscal_years": [prev["fiscal_year"], curr["fiscal_year"]],
    }


def health_snapshot(periods: list[dict], market_cap: float | None) -> dict:
    latest = periods[-1] if periods else {}
    return {
        "altman_z": altman_z(latest, market_cap),
        "piotroski_f": piotroski_f(periods),
        "interest_coverage": _div(latest.get("operating_income"), latest.get("interest_expense")),
        "net_debt": (
            (total_debt(latest) - (latest.get("cash") or 0.0))
            if total_debt(latest) is not None
            else None
        ),
        "fcf": free_cash_flow(latest),
        "fiscal_year": latest.get("fiscal_year"),
    }

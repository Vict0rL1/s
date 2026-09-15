"""Ratios fundamentales derivados de estados financieros anuales (EDGAR).

Funciones puras sobre los periodos normalizados que produce
`providers/edgar.parse_companyfacts`. Un dato de entrada ausente produce un
ratio None — nunca un cero inventado. Los supuestos (como la tasa impositiva
del ROIC) viajan en el resultado para que la UI los muestre.
"""

from __future__ import annotations

ROIC_TAX_RATE = 0.21  # supuesto visible: NOPAT = EBIT × (1 − 21 %)


def _div(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or b == 0:
        return None
    return a / b


def _sub(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    return a - b


def total_debt(period: dict) -> float | None:
    lt = period.get("long_term_debt")
    st = period.get("short_term_debt")
    if lt is None and st is None:
        return None
    return (lt or 0.0) + (st or 0.0)


def free_cash_flow(period: dict) -> float | None:
    """FCF = flujo de caja operativo − capex (capex llega como pago positivo)."""
    cfo = period.get("cfo")
    capex = period.get("capex")
    if cfo is None:
        return None
    return cfo - (capex or 0.0)


def derive_ratio_series(periods: list[dict]) -> list[dict]:
    """Serie anual de ratios; cada elemento conserva el año y el fin de periodo."""
    out = []
    for p in periods:
        revenue = p.get("revenue")
        assets = p.get("total_assets")
        equity = p.get("equity")
        ebit = p.get("operating_income")
        debt = total_debt(p)
        fcf = free_cash_flow(p)
        invested = None
        if equity is not None and debt is not None:
            invested = equity + debt - (p.get("cash") or 0.0)
        out.append(
            {
                "fiscal_year": p["fiscal_year"],
                "end_date": p.get("end_date"),
                "revenue": revenue,
                "net_income": p.get("net_income"),
                "eps_diluted": p.get("eps_diluted"),
                "fcf": fcf,
                "gross_margin": _div(p.get("gross_profit"), revenue),
                "operating_margin": _div(ebit, revenue),
                "net_margin": _div(p.get("net_income"), revenue),
                "fcf_margin": _div(fcf, revenue),
                "roa": _div(p.get("net_income"), assets),
                "roe": _div(p.get("net_income"), equity),
                "roic": _div(
                    ebit * (1 - ROIC_TAX_RATE) if ebit is not None else None, invested
                ),
                "current_ratio": _div(p.get("current_assets"), p.get("current_liabilities")),
                "debt_to_equity": _div(debt, equity),
                "interest_coverage": _div(ebit, p.get("interest_expense")),
                "asset_turnover": _div(revenue, assets),
            }
        )
    return out


def cagr(first: float | None, last: float | None, years: int) -> float | None:
    """Tasa de crecimiento anual compuesta. None si no es calculable de forma
    significativa (signos negativos o cero en los extremos)."""
    if first is None or last is None or years <= 0:
        return None
    if first <= 0 or last <= 0:
        return None
    return (last / first) ** (1 / years) - 1


def growth_summary(periods: list[dict]) -> dict:
    """CAGR de ingresos, EPS y FCF sobre hasta 5 ejercicios, calculado desde
    los estados financieros reales (no desde el TTM de un agregador)."""
    usable = [p for p in periods if p.get("revenue") is not None]
    span = min(len(usable) - 1, 5)
    if span < 1:
        return {"years": 0, "revenue_cagr": None, "eps_cagr": None, "fcf_cagr": None}
    first, last = usable[-span - 1], usable[-1]
    return {
        "years": span,
        "revenue_cagr": cagr(first.get("revenue"), last.get("revenue"), span),
        "eps_cagr": cagr(first.get("eps_diluted"), last.get("eps_diluted"), span),
        "fcf_cagr": cagr(free_cash_flow(first), free_cash_flow(last), span),
    }

"""Ensamblado del informe de analista: todas las piezas en una estructura.

Función pura sobre datos ya descargados — sin llamadas a red, así que es
testeable de principio a fin. El router se encarga de traer los datos; este
módulo decide qué significan.

Cada sección incluye su propia lectura en texto derivada de los números, no
del LLM. La capa de IA (opcional) escribe encima la narrativa, pero el
informe es completo y honesto sin ella.
"""

from __future__ import annotations

from app.analysis.fundamentals import (
    cagr,
    derive_ratio_series,
    free_cash_flow,
    growth_summary,
    total_debt,
)
from app.analysis.health import health_snapshot


def _trend(values: list[float | None]) -> str | None:
    """Dirección de una serie: compara la media de la primera mitad con la
    de la segunda. Robusto a un solo año raro."""
    clean = [v for v in values if v is not None]
    if len(clean) < 4:
        return None
    half = len(clean) // 2
    first = sum(clean[:half]) / half
    second = sum(clean[half:]) / len(clean[half:])
    if first == 0:
        return None
    change = (second - first) / abs(first)
    if change > 0.10:
        return "mejorando"
    if change < -0.10:
        return "deteriorándose"
    return "estable"


def _fmt_pct(value: float | None) -> str:
    return f"{value * 100:.1f} %" if value is not None else "—"


def business_section(periods: list[dict], profile: dict) -> dict:
    """Escala y trayectoria del negocio. No hay desglose por segmento: EDGAR
    no lo expone de forma estructurada en companyfacts."""
    revenues = [p.get("revenue") for p in periods]
    latest = periods[-1] if periods else {}
    years = len([r for r in revenues if r is not None])
    return {
        "name": profile.get("name"),
        "sector": profile.get("sector"),
        "country": profile.get("country"),
        "website": profile.get("website"),
        "market_cap": profile.get("market_cap"),
        "latest_revenue": latest.get("revenue"),
        "latest_fiscal_year": latest.get("fiscal_year"),
        "revenue_by_year": [
            {"year": p.get("fiscal_year"), "revenue": p.get("revenue")} for p in periods
        ],
        "years_of_history": years,
        "note": (
            "El desglose por segmento y la concentración de clientes no salen de "
            "companyfacts de EDGAR: para eso hay que leer el 10-K (enlace en la "
            "pestaña Filings)."
        ),
    }


def growth_section(periods: list[dict]) -> dict:
    """Crecimiento a 3 y 5 años, y si se está acelerando o frenando."""
    summary = growth_summary(periods)
    usable = [p for p in periods if p.get("revenue") is not None]

    three_year = None
    if len(usable) >= 4:
        three_year = cagr(usable[-4].get("revenue"), usable[-1].get("revenue"), 3)

    yoy = []
    for prev, curr in zip(usable, usable[1:]):
        prev_rev, curr_rev = prev.get("revenue"), curr.get("revenue")
        yoy.append(
            {
                "year": curr.get("fiscal_year"),
                "growth": (curr_rev / prev_rev - 1) if prev_rev else None,
            }
        )

    acceleration = None
    if three_year is not None and summary.get("revenue_cagr") is not None:
        diff = three_year - summary["revenue_cagr"]
        acceleration = "acelerando" if diff > 0.02 else "frenando" if diff < -0.02 else "estable"

    return {
        **summary,
        "revenue_cagr_3y": three_year,
        "yoy": yoy,
        "acceleration": acceleration,
        "reading": _growth_reading(summary.get("revenue_cagr"), acceleration),
    }


def _growth_reading(cagr_5y: float | None, acceleration: str | None) -> str:
    if cagr_5y is None:
        return "Sin histórico suficiente para medir el crecimiento."
    pace = (
        "crecimiento fuerte" if cagr_5y > 0.15
        else "crecimiento moderado" if cagr_5y > 0.05
        else "crecimiento plano" if cagr_5y > 0
        else "ingresos en contracción"
    )
    tail = f", y a 3 años viene {acceleration}" if acceleration else ""
    return f"Ingresos con {pace} ({_fmt_pct(cagr_5y)} anual a 5 años){tail}."


def margins_section(ratios: list[dict]) -> dict:
    """Márgenes por año y su dirección — más informativo que el nivel actual."""
    gross = [r.get("gross_margin") for r in ratios]
    operating = [r.get("operating_margin") for r in ratios]
    net = [r.get("net_margin") for r in ratios]
    latest = ratios[-1] if ratios else {}

    trends = {
        "gross_margin": _trend(gross),
        "operating_margin": _trend(operating),
        "net_margin": _trend(net),
    }
    return {
        "by_year": [
            {
                "year": r.get("fiscal_year"),
                "gross_margin": r.get("gross_margin"),
                "operating_margin": r.get("operating_margin"),
                "net_margin": r.get("net_margin"),
            }
            for r in ratios
        ],
        "current": {
            "gross_margin": latest.get("gross_margin"),
            "operating_margin": latest.get("operating_margin"),
            "net_margin": latest.get("net_margin"),
        },
        "trends": trends,
        "reading": _margins_reading(latest.get("operating_margin"), trends["operating_margin"]),
    }


def _margins_reading(operating: float | None, trend: str | None) -> str:
    if operating is None:
        return "Sin datos de márgenes."
    level = (
        "márgenes muy altos" if operating > 0.25
        else "márgenes sólidos" if operating > 0.15
        else "márgenes ajustados" if operating > 0.05
        else "márgenes muy finos o negativos"
    )
    tail = f" y la tendencia va {trend}" if trend else ""
    return f"Margen operativo del {_fmt_pct(operating)}: {level}{tail}."


def debt_section(periods: list[dict], ratios: list[dict], market_cap: float | None) -> dict:
    """Endeudamiento, cobertura y su evolución."""
    health = health_snapshot(periods, market_cap)
    latest = periods[-1] if periods else {}
    debt_series = [
        {"year": p.get("fiscal_year"), "total_debt": total_debt(p), "cash": p.get("cash")}
        for p in periods
    ]
    leverage_trend = _trend([r.get("debt_to_equity") for r in ratios])
    latest_ratio = ratios[-1] if ratios else {}

    return {
        "net_debt": health.get("net_debt"),
        "total_debt": total_debt(latest),
        "cash": latest.get("cash"),
        "debt_to_equity": latest_ratio.get("debt_to_equity"),
        "interest_coverage": health.get("interest_coverage"),
        "altman_z": health.get("altman_z"),
        "piotroski_f": health.get("piotroski_f"),
        "by_year": debt_series,
        "leverage_trend": leverage_trend,
        "reading": _debt_reading(
            latest_ratio.get("debt_to_equity"), health.get("interest_coverage"), leverage_trend
        ),
    }


def _debt_reading(d_e: float | None, coverage: float | None, trend: str | None) -> str:
    if d_e is None and coverage is None:
        return "Sin datos de endeudamiento."
    parts = []
    if d_e is not None:
        parts.append(
            f"Deuda/capital {d_e:.2f}"
            + (
                " (apalancamiento alto)" if d_e > 2
                else " (moderado)" if d_e > 1
                else " (bajo)"
            )
        )
    if coverage is not None:
        parts.append(
            f"cobertura de intereses {coverage:.1f}×"
            + (" — holgada" if coverage > 5 else " — ajustada" if coverage > 2 else " — frágil")
        )
    if trend:
        # El apalancamiento "mejorando" significa que la ratio sube, o sea peor.
        parts.append(
            "el apalancamiento viene subiendo" if trend == "mejorando"
            else "el apalancamiento viene bajando" if trend == "deteriorándose"
            else "estable en el tiempo"
        )
    return ". ".join(parts) + "."


def cash_flow_section(periods: list[dict], ratios: list[dict]) -> dict:
    """Caja: generación, intensidad de capital y calidad del beneficio."""
    rows = []
    for period, ratio in zip(periods, ratios):
        cfo = period.get("cfo")
        capex = period.get("capex")
        fcf = free_cash_flow(period)
        net_income = period.get("net_income")
        revenue = period.get("revenue")
        rows.append(
            {
                "year": period.get("fiscal_year"),
                "cfo": cfo,
                "capex": capex,
                "fcf": fcf,
                "fcf_margin": ratio.get("fcf_margin"),
                # Conversión: cuánto del beneficio contable llega a caja.
                "fcf_conversion": (fcf / net_income) if fcf is not None and net_income else None,
                "capex_intensity": (capex / revenue) if capex is not None and revenue else None,
            }
        )
    latest = rows[-1] if rows else {}
    return {
        "by_year": rows,
        "current": latest,
        "fcf_trend": _trend([r["fcf"] for r in rows]),
        "reading": _cash_reading(latest.get("fcf"), latest.get("fcf_conversion")),
    }


def _cash_reading(fcf: float | None, conversion: float | None) -> str:
    if fcf is None:
        return "Sin datos de flujo de caja."
    if fcf < 0:
        return "Flujo de caja libre negativo: el negocio consume caja."
    if conversion is None:
        return "Genera flujo de caja libre positivo."
    if conversion > 1.1:
        return (
            f"Convierte el {conversion * 100:.0f} % del beneficio en caja: el "
            "beneficio contable subestima la generación real."
        )
    if conversion < 0.6:
        return (
            f"Solo el {conversion * 100:.0f} % del beneficio llega a caja libre. "
            "Conviene mirar si es capex de crecimiento o deterioro de la calidad "
            "del beneficio."
        )
    return f"Conversión de beneficio a caja del {conversion * 100:.0f} %: saludable."


def risks_section(
    periods: list[dict], ratios: list[dict], risk: dict | None, valuation: dict
) -> list[dict]:
    """Riesgos derivados de los datos, cada uno con su evidencia."""
    risks = []
    latest_ratio = ratios[-1] if ratios else {}

    d_e = latest_ratio.get("debt_to_equity")
    if d_e is not None and d_e > 2:
        risks.append(
            {
                "type": "Apalancamiento",
                "severity": "alto" if d_e > 3 else "medio",
                "evidence": f"Deuda/capital de {d_e:.2f}",
                "why": "Una subida de tipos o una caída de resultados aprieta mucho más rápido.",
            }
        )

    coverage = latest_ratio.get("interest_coverage")
    if coverage is not None and coverage < 3:
        risks.append(
            {
                "type": "Cobertura de intereses",
                "severity": "alto" if coverage < 1.5 else "medio",
                "evidence": f"El EBIT cubre {coverage:.1f}× los intereses",
                "why": "Poco margen para absorber un año malo sin tensiones financieras.",
            }
        )

    margin_trend = _trend([r.get("operating_margin") for r in ratios])
    if margin_trend == "deteriorándose":
        risks.append(
            {
                "type": "Compresión de márgenes",
                "severity": "medio",
                "evidence": "El margen operativo viene cayendo en el periodo analizado",
                "why": "Suele indicar presión competitiva o pérdida de poder de fijación de precios.",
            }
        )

    growth = growth_summary(periods)
    if growth.get("revenue_cagr") is not None and growth["revenue_cagr"] < 0:
        risks.append(
            {
                "type": "Ingresos en contracción",
                "severity": "alto",
                "evidence": f"CAGR de ingresos {_fmt_pct(growth['revenue_cagr'])} a {growth['years']} años",
                "why": "Un múltiplo bajo sobre un negocio que encoge no es una ganga.",
            }
        )

    cheapness = valuation.get("cheapness_score")
    if cheapness is not None and cheapness < 0.25:
        risks.append(
            {
                "type": "Valoración exigente",
                "severity": "medio",
                "evidence": "Cotiza en la parte alta de su rango histórico de múltiplos",
                "why": "Deja poco margen de error: exige que se cumpla el escenario optimista.",
            }
        )

    if risk:
        drawdown = (risk.get("max_drawdown") or {}).get("max_drawdown")
        if drawdown is not None and drawdown < -0.35:
            risks.append(
                {
                    "type": "Volatilidad histórica",
                    "severity": "medio",
                    "evidence": f"Máxima caída del {_fmt_pct(drawdown)} en el último año",
                    "why": "Dimensiona la posición contando con que puede repetirse.",
                }
            )

    risks.sort(key=lambda r: 0 if r["severity"] == "alto" else 1)
    return risks


def catalysts_section(
    earnings: list[dict], filings: list[dict], events: list[dict]
) -> list[dict]:
    """Catalizadores identificables a 6-18 meses a partir de datos, no de opinión."""
    catalysts = []
    for event in earnings[:4]:
        catalysts.append(
            {
                "type": "Resultados",
                "when": event.get("date"),
                "detail": (
                    f"Publicación de resultados"
                    + (f" · EPS estimado {event['eps_estimate']}" if event.get("eps_estimate") else "")
                ),
                "source": "calendario",
            }
        )
    for filing in filings[:3]:
        catalysts.append(
            {
                "type": filing.get("type"),
                "when": filing.get("filed_at"),
                "detail": "Documento presentado ante la SEC",
                "source": "edgar",
                "url": filing.get("url"),
            }
        )
    for event in events[:5]:
        if event.get("category") == "irrelevante_para_la_tesis":
            continue
        catalysts.append(
            {
                "type": event.get("category", "").replace("_", " "),
                "when": None,
                "detail": event.get("headline"),
                "source": "noticias (clasificado por IA)",
            }
        )
    return catalysts


def build_verdict(
    signal: dict | None, valuation: dict, growth: dict, debt: dict, margins: dict
) -> dict:
    """Veredicto sintetizado: qué dicen los datos en conjunto.

    NO es una orden de compra. Es la lectura conjunta con sus condiciones y,
    sobre todo, con lo que la invalidaría — que es la parte que un informe de
    analista suele enterrar y aquí va explícita.
    """
    positives, negatives = [], []

    cheapness = valuation.get("cheapness_score")
    if cheapness is not None:
        if cheapness >= 0.65:
            positives.append("cotiza por debajo de su valoración histórica habitual")
        elif cheapness <= 0.35:
            negatives.append("cotiza por encima de su valoración histórica habitual")

    revenue_cagr = growth.get("revenue_cagr")
    if revenue_cagr is not None:
        if revenue_cagr > 0.08:
            positives.append(f"ingresos creciendo al {_fmt_pct(revenue_cagr)} anual")
        elif revenue_cagr < 0:
            negatives.append("ingresos en contracción")

    operating = (margins.get("current") or {}).get("operating_margin")
    if operating is not None and operating > 0.15:
        positives.append(f"margen operativo del {_fmt_pct(operating)}")
    if margins.get("trends", {}).get("operating_margin") == "deteriorándose":
        negatives.append("márgenes en deterioro")

    coverage = debt.get("interest_coverage")
    if coverage is not None:
        if coverage > 8:
            positives.append("balance sin tensión por intereses")
        elif coverage < 3:
            negatives.append(f"cobertura de intereses ajustada ({coverage:.1f}×)")

    zone = (debt.get("altman_z") or {}).get("zone")
    if zone == "riesgo":
        negatives.append("Altman Z en zona de riesgo")

    stance = (
        "constructiva" if len(positives) > len(negatives) + 1
        else "cautelosa" if len(negatives) > len(positives) + 1
        else "mixta"
    )

    return {
        "stance": stance,
        "positives": positives,
        "negatives": negatives,
        "quant_label": (signal or {}).get("label"),
        "quant_score": (signal or {}).get("score"),
        "summary": _verdict_summary(stance, positives, negatives),
        "what_would_change_it": _invalidators(positives, negatives),
        "disclaimer": (
            "Lectura conjunta de los datos, no una recomendación de compra o "
            "venta. Qué hacer depende de tu cartera, horizonte y tolerancia al "
            "riesgo, que el modelo no conoce. Un informe favorable sobre una "
            "empresa excelente sigue pudiendo ser una mala compra al precio "
            "equivocado."
        ),
    }


def _verdict_summary(stance: str, positives: list[str], negatives: list[str]) -> str:
    if not positives and not negatives:
        return "Datos insuficientes para una lectura conjunta."
    pos = "; ".join(positives) or "sin factores claramente favorables"
    neg = "; ".join(negatives) or "sin señales de alarma en los datos"
    frame = {
        "constructiva": "Los datos apuntan en dirección favorable",
        "cautelosa": "Los datos invitan a la cautela",
        "mixta": "Los datos dan una lectura mixta",
    }[stance]
    return f"{frame}. A favor: {pos}. En contra: {neg}."


def _invalidators(positives: list[str], negatives: list[str]) -> list[str]:
    """Qué observaciones futuras romperían esta lectura."""
    checks = [
        "Dos trimestres seguidos de caída del margen operativo.",
        "Que el crecimiento de ingresos se vuelva negativo de forma sostenida.",
        "Un salto del apalancamiento o una caída de la cobertura de intereses por debajo de 3×.",
        "Que el flujo de caja libre pase a negativo sin una explicación de inversión clara.",
    ]
    if any("valoración histórica habitual" in p for p in positives):
        checks.append(
            "Que el múltiplo bajo se explique por un deterioro estructural del "
            "negocio y no por pesimismo temporal — el clásico value trap."
        )
    return checks


def assemble(
    symbol: str,
    profile: dict,
    financials: dict,
    valuation: dict,
    quote: dict | None,
    risk: dict | None,
    signal: dict | None,
    earnings: list[dict],
    filings: list[dict],
    events: list[dict],
    dcf: dict | None,
) -> dict:
    """Informe completo. Función pura: nada aquí toca la red."""
    periods = financials.get("periods", [])
    ratios = financials.get("ratios") or derive_ratio_series(periods)

    business = business_section(periods, profile)
    growth = growth_section(periods)
    margins = margins_section(ratios)
    debt = debt_section(periods, ratios, profile.get("market_cap"))
    cash_flow = cash_flow_section(periods, ratios)

    return {
        "symbol": symbol,
        "generated_at": None,  # lo pone el router
        "price": (quote or {}).get("price"),
        "business": business,
        "growth": growth,
        "margins": margins,
        "debt": debt,
        "cash_flow": cash_flow,
        "valuation": valuation,
        "dcf": dcf,
        "quant_signal": signal,
        "risk_metrics": risk,
        "risks": risks_section(periods, ratios, risk, valuation),
        "catalysts": catalysts_section(earnings, filings, events),
        "verdict": build_verdict(signal, valuation, growth, debt, margins),
        "data_sources": {
            "financials": financials.get("source"),
            "quote": (quote or {}).get("source"),
            "as_of": financials.get("as_of"),
        },
        "computed_by": "app",  # todo lo anterior sale de cálculos, no del LLM
    }

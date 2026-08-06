"""Múltiplos históricos de la propia empresa y percentil actual.

Responde a "¿está cara o barata **frente a sí misma**?", que suele ser más
informativo que compararla con el mercado: cada negocio tiene su rango
natural de múltiplos según su calidad y crecimiento.

Disciplina point-in-time: el P/E de marzo de 2022 usa el EPS que **ya estaba
publicado** en marzo de 2022, no el del ejercicio 2022 que salió en 2023.
Sin eso, la serie histórica estaría contaminada por información futura.

Trampa que este módulo debe advertir, no esconder: una empresa en declive
estructural cotiza barata contra su historia **para siempre**, porque el
mercado ha revisado a la baja lo que vale. "Barato vs. su historia" es una
pregunta, no una respuesta.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.analysis.backtest import _to_date, point_in_time_period
from app.analysis.fundamentals import free_cash_flow

MIN_POINTS = 12  # menos de ~1 año de muestras mensuales no describe un rango


def _monthly_samples(bars: list[dict], years: int) -> list[tuple[date, float]]:
    """Una muestra de precio por mes, para no inflar la serie con 2.500 días."""
    parsed = sorted(
        (
            (d, bar["close"])
            for bar in bars
            if (d := _to_date(bar.get("ts"))) is not None and bar.get("close")
        ),
        key=lambda pair: pair[0],
    )
    if not parsed:
        return []
    cutoff = parsed[-1][0] - timedelta(days=365 * years)
    seen: set[tuple[int, int]] = set()
    samples = []
    for day, close in parsed:
        if day < cutoff:
            continue
        key = (day.year, day.month)
        if key in seen:
            continue
        seen.add(key)
        samples.append((day, close))
    return samples


def historical_multiples(
    periods: list[dict],
    filings: list[dict],
    bars: list[dict],
    years: int = 10,
) -> dict:
    """Series temporales de P/E, P/B y FCF yield, point-in-time.

    Cada punto usa el último ejercicio **publicado** en esa fecha. Los
    múltiplos sin sentido económico (EPS o patrimonio negativos) se omiten
    en lugar de producir valores absurdos.
    """
    series: dict[str, list[dict]] = {"pe": [], "pb": [], "fcf_yield": []}

    for day, price in _monthly_samples(bars, years):
        period = point_in_time_period(periods, filings, day)
        if period is None:
            continue
        shares = period.get("shares_outstanding")
        eps = period.get("eps_diluted")
        equity = period.get("equity")
        fcf = free_cash_flow(period)

        if eps and eps > 0:
            series["pe"].append({"ts": day.isoformat(), "value": price / eps})
        if shares and equity and equity > 0:
            book_per_share = equity / shares
            if book_per_share > 0:
                series["pb"].append({"ts": day.isoformat(), "value": price / book_per_share})
        if shares and fcf is not None:
            market_cap = price * shares
            if market_cap:
                series["fcf_yield"].append(
                    {"ts": day.isoformat(), "value": fcf / market_cap}
                )
    return series


def percentile_rank(values: list[float], current: float) -> float | None:
    """Percentil de `current` dentro de `values` (0 = el más bajo de la serie)."""
    if not values:
        return None
    below = sum(1 for v in values if v < current)
    ties = sum(1 for v in values if v == current)
    return (below + 0.5 * ties) / len(values)


def _stats(points: list[dict], current: float | None, higher_is_cheaper: bool) -> dict:
    """Resumen de una serie: rango, mediana y dónde cae el valor actual."""
    values = [p["value"] for p in points]
    if len(values) < MIN_POINTS:
        return {
            "available": False,
            "n": len(values),
            "reason": (
                f"Solo {len(values)} observaciones (mínimo {MIN_POINTS}): la serie "
                "no describe un rango histórico utilizable."
            ),
        }
    ordered = sorted(values)
    n = len(ordered)
    median = (
        ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2
    )
    pct = percentile_rank(values, current) if current is not None else None

    # "Barato" depende de la orientación: un P/E bajo es barato, un FCF yield
    # alto también. Se normaliza a un percentil de *baratura*.
    cheapness = None
    if pct is not None:
        cheapness = pct if higher_is_cheaper else 1 - pct

    return {
        "available": True,
        "n": n,
        "current": current,
        "median": median,
        "min": ordered[0],
        "max": ordered[-1],
        "p25": ordered[int(n * 0.25)],
        "p75": ordered[int(n * 0.75)],
        "percentile": pct,
        "cheapness_percentile": cheapness,
        "vs_median_pct": (current / median - 1) if current and median else None,
        "series": points,
    }


def valuation_vs_history(
    periods: list[dict],
    filings: list[dict],
    bars: list[dict],
    current_price: float | None,
    years: int = 10,
) -> dict:
    """Valoración actual frente al rango histórico de la propia empresa."""
    series = historical_multiples(periods, filings, bars, years)
    latest = periods[-1] if periods else {}
    shares = latest.get("shares_outstanding")
    eps = latest.get("eps_diluted")
    equity = latest.get("equity")
    fcf = free_cash_flow(latest)

    current_pe = (current_price / eps) if current_price and eps and eps > 0 else None
    current_pb = None
    current_fcf_yield = None
    if current_price and shares:
        market_cap = current_price * shares
        if equity and equity > 0:
            current_pb = market_cap / equity
        if fcf is not None and market_cap:
            current_fcf_yield = fcf / market_cap

    multiples = {
        "pe": _stats(series["pe"], current_pe, higher_is_cheaper=False),
        "pb": _stats(series["pb"], current_pb, higher_is_cheaper=False),
        "fcf_yield": _stats(series["fcf_yield"], current_fcf_yield, higher_is_cheaper=True),
    }

    available = [m for m in multiples.values() if m.get("available") and m.get("cheapness_percentile") is not None]
    overall = (
        sum(m["cheapness_percentile"] for m in available) / len(available)
        if available
        else None
    )

    return {
        "multiples": multiples,
        "cheapness_score": overall,
        "reading": _reading(overall),
        "years_covered": years,
        "caveats": [
            "Los múltiplos usan el EPS y el patrimonio del último ejercicio ANUAL "
            "publicado, no cifras TTM trimestrales: la serie es más rugosa que la "
            "de un terminal profesional.",
            "Cotizar barato frente a su propia historia NO implica que esté "
            "infravalorada: una empresa en declive estructural se abarata de forma "
            "permanente porque el mercado ha rebajado lo que cree que vale. Antes "
            "de leer esto como oportunidad, comprueba si márgenes, ingresos y ROIC "
            "siguen intactos.",
        ],
    }


def _reading(cheapness: float | None) -> str:
    if cheapness is None:
        return "Sin histórico suficiente para situar la valoración actual."
    if cheapness >= 0.8:
        return (
            "Cotiza en la parte baja de su rango histórico. Revisa si el negocio "
            "sigue siendo el mismo o si el mercado está descontando un deterioro."
        )
    if cheapness >= 0.6:
        return "Por debajo de su valoración típica, sin llegar a extremos."
    if cheapness >= 0.4:
        return "En línea con su valoración histórica habitual."
    if cheapness >= 0.2:
        return "Por encima de su valoración típica: el mercado paga una prima."
    return (
        "En la parte alta de su rango histórico. Exige un crecimiento o una mejora "
        "de márgenes que habría que justificar."
    )

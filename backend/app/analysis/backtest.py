"""Backtest walk-forward con disciplina point-in-time.

El error que arruina la mayoría de los backtests caseros es el **sesgo de
anticipación** (look-ahead): puntuar una empresa en enero de 2023 usando el
balance del ejercicio 2023, que no se publicó hasta 2024. Ese backtest da
tasas de acierto espectaculares que se evaporan en vivo.

Aquí, en cada fecha de rebalanceo solo se usan estados financieros cuya
**fecha de publicación** (`filed_at`) es anterior a esa fecha — no la fecha
de cierre del ejercicio. Y el resultado se mide hacia delante, nunca sobre
los mismos datos que generaron la señal.

Lo que este backtest NO puede validar, y por eso se excluye:
- **Sentimiento de noticias**: las APIs gratuitas solo dan semanas de
  histórico. Un factor sin histórico no se puede backtestear, y fingir que
  sí es peor que omitirlo.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from app.analysis.factors import (
    build_raw_factors,
    composite_score,
    family_scores,
    zscores,
)

# Familias validables con datos históricos disponibles. Sentimiento fuera.
BACKTESTABLE_WEIGHTS = {"value": 1 / 3, "quality": 1 / 3, "momentum": 1 / 3}

TRADING_DAYS_YEAR = 252


def _to_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        return None


def point_in_time_period(
    periods: list[dict], filings: list[dict], as_of: date
) -> dict | None:
    """El estado financiero anual más reciente **ya publicado** en `as_of`.

    Empareja cada periodo con la fecha real de publicación de su 10-K. Si no
    hay filing conocido para un periodo, se aplica un retardo conservador de
    90 días sobre el cierre del ejercicio — la ventana típica de publicación
    en EE. UU. Nunca se asume disponibilidad inmediata.
    """
    annual_filings = sorted(
        (
            f
            for f in filings
            if f.get("type", "").startswith("10-K") and _to_date(f.get("filed_at"))
        ),
        key=lambda f: _to_date(f["filed_at"]),
    )

    available = []
    for period in periods:
        end = _to_date(period.get("end_date"))
        if end is None:
            continue
        # Orden de preferencia para saber CUÁNDO se conoció este ejercicio:
        # 1) la fecha de publicación del propio dato, que EDGAR entrega por
        #    hecho y es la respuesta exacta;
        # 2) el primer 10-K presentado tras el cierre;
        # 3) un retardo conservador de 90 días.
        # Se degrada, nunca se adelanta: suponer disponibilidad antes de tiempo
        # es exactamente el sesgo que este módulo existe para evitar.
        published = _to_date(period.get("filed_at")) or next(
            (_to_date(f["filed_at"]) for f in annual_filings if _to_date(f["filed_at"]) > end),
            end + timedelta(days=90),
        )
        if published <= as_of:
            available.append((published, period))

    if not available:
        return None
    available.sort(key=lambda pair: pair[0])
    return available[-1][1]


def momentum_12_1(bars: list[dict], as_of: date) -> float | None:
    """Momentum académico 12-1: retorno de t-12m a t-1m.

    Se excluye el último mes porque a ese plazo domina la reversión de corto
    plazo, que va en dirección contraria al momentum de medio plazo.
    """
    history = [
        (d, bar)
        for bar in bars
        if (d := _to_date(bar.get("ts"))) is not None and d <= as_of
    ]
    if len(history) < 200:  # menos de ~10 meses de sesiones: no hay señal
        return None
    history.sort(key=lambda pair: pair[0])

    start_target = as_of - timedelta(days=365)
    end_target = as_of - timedelta(days=30)
    start = _closest_bar(history, start_target)
    end = _closest_bar(history, end_target)
    if start is None or end is None:
        return None
    start_price, end_price = start["close"], end["close"]
    if not start_price:
        return None
    return end_price / start_price - 1


def _closest_bar(history: list[tuple[date, dict]], target: date) -> dict | None:
    """Última barra en o antes de `target` (nunca una posterior)."""
    candidates = [bar for d, bar in history if d <= target]
    return candidates[-1] if candidates else None


def metrics_from_period(period: dict, price: float, shares: float | None) -> dict:
    """Métricas de valoración point-in-time a partir de un periodo anual.

    Los múltiplos se construyen con el precio de la fecha de rebalanceo y
    las cifras del último ejercicio publicado — no con el precio de hoy.
    """
    from app.analysis.fundamentals import free_cash_flow, total_debt

    eps = period.get("eps_diluted")
    equity = period.get("equity")
    revenue = period.get("revenue")
    net_income = period.get("net_income")
    ebit = period.get("operating_income")
    debt = total_debt(period)
    fcf = free_cash_flow(period)
    market_cap = price * shares if shares else None

    return {
        "pe_ttm": (price / eps) if eps and eps > 0 else None,
        "pb": (market_cap / equity) if market_cap and equity and equity > 0 else None,
        "fcf_yield": (fcf / market_cap) if fcf is not None and market_cap else None,
        "roe": (net_income / equity) if net_income is not None and equity else None,
        "operating_margin": (ebit / revenue) if ebit is not None and revenue else None,
        "interest_coverage": (
            ebit / period["interest_expense"]
            if ebit is not None and period.get("interest_expense")
            else None
        ),
        "debt_to_equity": (debt / equity) if debt is not None and equity else None,
    }


def forward_return(bars: list[dict], start: date, months: int) -> float | None:
    """Retorno realizado desde `start` hasta `start + months`.

    Devuelve None si el histórico no llega hasta el final del horizonte: un
    periodo incompleto no se puede evaluar, y rellenarlo con el último precio
    disponible introduciría sesgo de supervivencia.
    """
    history = sorted(
        (
            (d, bar)
            for bar in bars
            if (d := _to_date(bar.get("ts"))) is not None
        ),
        key=lambda pair: pair[0],
    )
    if not history:
        return None
    end_target = start + timedelta(days=int(months * 30.44))
    if history[-1][0] < end_target:
        return None  # el horizonte todavía no se ha cumplido

    start_bar = _closest_bar(history, start)
    end_bar = _closest_bar(history, end_target)
    if start_bar is None or end_bar is None or not start_bar["close"]:
        return None
    return end_bar["close"] / start_bar["close"] - 1


def run_walk_forward(
    universe: dict[str, dict],
    rebalance_dates: list[date],
    horizon_months: int = 12,
) -> dict:
    """Ejecuta el backtest transversal.

    `universe`: {símbolo: {periods, filings, bars, shares}}.

    En cada fecha se puntúa a todas las empresas con datos disponibles EN ESE
    MOMENTO, y se mide si cada una superó a la **mediana del universo** en el
    horizonte. Usar la mediana como referencia convierte esto en una prueba
    limpia de si el score ordena bien, sin necesitar datos de un índice.
    """
    observations = []
    skipped = {"sin_fundamentales": 0, "sin_momentum": 0, "horizonte_incompleto": 0}

    for as_of in rebalance_dates:
        snapshot: dict[str, dict] = {}
        for symbol, data in universe.items():
            period = point_in_time_period(
                data.get("periods", []), data.get("filings", []), as_of
            )
            if period is None:
                skipped["sin_fundamentales"] += 1
                continue
            price_bar = _closest_bar(
                sorted(
                    (
                        (d, b)
                        for b in data.get("bars", [])
                        if (d := _to_date(b.get("ts"))) is not None
                    ),
                    key=lambda pair: pair[0],
                ),
                as_of,
            )
            if price_bar is None:
                continue
            momentum = momentum_12_1(data.get("bars", []), as_of)
            if momentum is None:
                skipped["sin_momentum"] += 1
            metrics = metrics_from_period(
                period, price_bar["close"], period.get("shares_outstanding")
            )
            snapshot[symbol] = {
                "raw": build_raw_factors(metrics, momentum=momentum, sentiment=None),
                "forward": forward_return(data.get("bars", []), as_of, horizon_months),
            }

        if len(snapshot) < 3:
            continue  # sin corte transversal no hay z-scores

        # z-scores por factor dentro de esta fecha
        factor_names = set()
        for entry in snapshot.values():
            factor_names.update(entry["raw"])
        factor_z = {
            factor: zscores({s: e["raw"].get(factor) for s, e in snapshot.items()})
            for factor in factor_names
        }
        families = family_scores(factor_z)

        forwards = {
            s: e["forward"] for s, e in snapshot.items() if e["forward"] is not None
        }
        if len(forwards) < 3:
            skipped["horizonte_incompleto"] += len(snapshot)
            continue
        median_forward = sorted(forwards.values())[len(forwards) // 2]

        for symbol in snapshot:
            if symbol not in forwards:
                continue
            composite = composite_score(
                {f: families[f].get(symbol) for f in families}, BACKTESTABLE_WEIGHTS
            )
            if composite["score"] is None:
                continue
            observations.append(
                {
                    "symbol": symbol,
                    "as_of": as_of.isoformat(),
                    "score": composite["score"],
                    "coverage": composite["coverage"],
                    "forward_return": forwards[symbol],
                    "median_return": median_forward,
                    "outperformed": forwards[symbol] > median_forward,
                }
            )

    return {
        "observations": observations,
        "n_observations": len(observations),
        "n_rebalances": len(rebalance_dates),
        "horizon_months": horizon_months,
        "skipped": skipped,
        "excluded_factors": ["sentiment"],
        "methodology": (
            "Walk-forward transversal. En cada fecha se usan solo estados "
            "financieros ya publicados (fecha de filing, no de cierre de "
            "ejercicio) y precios hasta esa fecha. El resultado mide si la "
            "empresa superó la mediana del universo en el horizonte. El factor "
            "de sentimiento queda excluido por falta de histórico."
        ),
    }


def monthly_rebalance_dates(start: date, end: date, step_months: int = 3) -> list[date]:
    """Fechas de rebalanceo trimestrales entre dos fechas."""
    dates, current = [], start
    while current <= end:
        dates.append(current)
        month = current.month + step_months
        year = current.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        day = min(current.day, 28)
        current = date(year, month, day)
    return dates

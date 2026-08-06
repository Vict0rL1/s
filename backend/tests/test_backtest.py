"""Tests del backtest — sobre todo la ausencia de sesgo de anticipación.

Si estos tests pasan pero el modelo mira el futuro, el backtest daría tasas
de acierto altísimas y falsas. Es el fallo más caro posible en esta app.
"""

from datetime import date, timedelta

import pytest

from app.analysis.backtest import (
    forward_return,
    momentum_12_1,
    monthly_rebalance_dates,
    point_in_time_period,
    run_walk_forward,
)


def _bars(start: date, days: int, start_price: float, daily_drift: float = 0.0):
    """Serie diaria sintética con deriva constante."""
    return [
        {
            "ts": (start + timedelta(days=i)).isoformat(),
            "close": start_price * (1 + daily_drift) ** i,
        }
        for i in range(days)
    ]


# ---------------------------------------------------------------------------
# Point-in-time: el corazón de la honestidad del backtest
# ---------------------------------------------------------------------------


def test_no_usa_un_ejercicio_antes_de_su_publicacion():
    # El 10-K del ejercicio 2023 se presenta en febrero de 2024. Puntuar en
    # enero de 2024 NO puede usarlo — ese es el sesgo de anticipación.
    periods = [
        {"fiscal_year": "2022", "end_date": "2022-12-31", "revenue": 900},
        {"fiscal_year": "2023", "end_date": "2023-12-31", "revenue": 1000},
    ]
    filings = [
        {"type": "10-K", "filed_at": "2023-02-15"},
        {"type": "10-K", "filed_at": "2024-02-20"},
    ]

    en_enero = point_in_time_period(periods, filings, date(2024, 1, 15))
    assert en_enero["fiscal_year"] == "2022"  # el de 2023 aún no existía

    en_marzo = point_in_time_period(periods, filings, date(2024, 3, 1))
    assert en_marzo["fiscal_year"] == "2023"  # ya publicado


def test_sin_filing_conocido_aplica_retardo_conservador():
    # Sin fecha de publicación se asumen 90 días tras el cierre, nunca
    # disponibilidad inmediata.
    periods = [{"fiscal_year": "2023", "end_date": "2023-12-31", "revenue": 1000}]

    assert point_in_time_period(periods, [], date(2024, 1, 5)) is None  # +5 días
    assert point_in_time_period(periods, [], date(2024, 4, 15)) is not None  # +105 días


def test_sin_periodos_publicados_devuelve_none():
    periods = [{"fiscal_year": "2024", "end_date": "2024-12-31"}]
    assert point_in_time_period(periods, [], date(2020, 1, 1)) is None


# ---------------------------------------------------------------------------
# Momentum
# ---------------------------------------------------------------------------


def test_momentum_excluye_el_ultimo_mes():
    start = date(2022, 1, 1)
    bars = _bars(start, 800, 100.0, daily_drift=0.001)
    as_of = start + timedelta(days=799)
    result = momentum_12_1(bars, as_of)
    assert result is not None
    assert result > 0  # serie alcista → momentum positivo

    # Con deriva negativa el signo se invierte.
    bajista = momentum_12_1(_bars(start, 800, 100.0, daily_drift=-0.001), as_of)
    assert bajista < 0


def test_momentum_nunca_mira_barras_futuras():
    start = date(2022, 1, 1)
    # Serie plana hasta el día 500, luego un salto enorme.
    bars = _bars(start, 500, 100.0)
    bars += [
        {"ts": (start + timedelta(days=500 + i)).isoformat(), "close": 10_000.0}
        for i in range(100)
    ]
    # Al puntuar en el día 480, el salto posterior no debe afectar.
    result = momentum_12_1(bars, start + timedelta(days=480))
    assert result == pytest.approx(0.0)


def test_momentum_sin_historico_suficiente():
    assert momentum_12_1(_bars(date(2023, 1, 1), 50, 100.0), date(2023, 2, 1)) is None


# ---------------------------------------------------------------------------
# Retorno futuro
# ---------------------------------------------------------------------------


def test_retorno_futuro_calculado_a_mano():
    start = date(2022, 1, 1)
    # 100 → 200 en el día 365 (duplica).
    bars = [{"ts": start.isoformat(), "close": 100.0}]
    bars += [
        {"ts": (start + timedelta(days=i)).isoformat(), "close": 100.0}
        for i in range(1, 360)
    ]
    bars += [
        {"ts": (start + timedelta(days=i)).isoformat(), "close": 200.0}
        for i in range(360, 400)
    ]
    result = forward_return(bars, start, months=12)
    assert result == pytest.approx(1.0)  # +100 %


def test_horizonte_incompleto_no_se_evalua():
    # Sin datos hasta el final del horizonte, evaluar sería inventar.
    start = date(2023, 1, 1)
    bars = _bars(start, 100, 100.0)
    assert forward_return(bars, start, months=12) is None


# ---------------------------------------------------------------------------
# Walk-forward completo
# ---------------------------------------------------------------------------


def _universe_entry(drift: float, revenue: float, equity: float, eps: float):
    start = date(2020, 1, 1)
    return {
        "periods": [
            {
                "fiscal_year": "2020",
                "end_date": "2020-12-31",
                "revenue": revenue,
                "net_income": revenue * 0.1,
                "operating_income": revenue * 0.15,
                "equity": equity,
                "eps_diluted": eps,
                "shares_outstanding": 100.0,
                "cfo": revenue * 0.12,
                "capex": revenue * 0.03,
            }
        ],
        "filings": [{"type": "10-K", "filed_at": "2021-02-15"}],
        "bars": _bars(start, 1400, 50.0, daily_drift=drift),
    }


def test_walk_forward_produce_observaciones_evaluables():
    universe = {
        "A": _universe_entry(0.0012, 1000, 500, 3.0),
        "B": _universe_entry(0.0002, 800, 900, 1.5),
        "C": _universe_entry(-0.0005, 1200, 400, 4.0),
        "D": _universe_entry(0.0008, 600, 300, 2.0),
    }
    dates = [date(2021, 6, 1), date(2021, 9, 1)]
    result = run_walk_forward(universe, dates, horizon_months=6)

    assert result["n_observations"] > 0
    for obs in result["observations"]:
        assert obs["score"] is not None
        assert isinstance(obs["outperformed"], bool)
        # El resultado se mide contra la mediana del universo en esa fecha.
        assert obs["outperformed"] == (obs["forward_return"] > obs["median_return"])


def test_walk_forward_excluye_sentimiento_explicitamente():
    result = run_walk_forward({}, [], horizon_months=12)
    assert "sentiment" in result["excluded_factors"]
    assert "sentimiento" in result["methodology"]


def test_walk_forward_ignora_fechas_sin_corte_transversal():
    # Con dos empresas no hay z-scores posibles: 0 observaciones, sin error.
    universe = {"A": _universe_entry(0.001, 1000, 500, 3.0), "B": _universe_entry(0.0, 800, 900, 1.5)}
    result = run_walk_forward(universe, [date(2021, 6, 1)], horizon_months=6)
    assert result["n_observations"] == 0


def test_fechas_de_rebalanceo_trimestrales():
    dates = monthly_rebalance_dates(date(2020, 1, 15), date(2021, 1, 1), step_months=3)
    assert dates[0] == date(2020, 1, 15)
    assert dates[1] == date(2020, 4, 15)
    assert all(d <= date(2021, 1, 1) for d in dates)
    assert len(dates) == 4

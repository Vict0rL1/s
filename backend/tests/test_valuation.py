"""Tests del DCF contra un caso calculado a mano paso a paso."""

import pytest

from app.analysis.valuation import dcf, scenario_set, sensitivity_grid


def test_dcf_caso_calculado_a_mano():
    # FCF base 100, crecimiento 10 %, descuento 12 %, terminal 3 %, 2 años,
    # deuda neta 50, 10 acciones. Cálculo manual:
    #   FCF1 = 110        → PV = 110 / 1.12      = 98.2142857
    #   FCF2 = 121        → PV = 121 / 1.2544    = 96.4604592
    #   TV   = 121·1.03 / (0.12−0.03) = 1384.7778
    #   PV(TV) = 1384.7778 / 1.2544   = 1103.9364
    #   EV = 98.2143 + 96.4605 + 1103.9364 = 1298.6111
    #   Equity = 1248.6111 → por acción = 124.8611
    result = dcf(
        base_fcf=100.0,
        growth_rate=0.10,
        discount_rate=0.12,
        terminal_growth=0.03,
        years=2,
        net_debt=50.0,
        shares_outstanding=10.0,
    )
    assert result["projections"][0]["fcf"] == pytest.approx(110.0)
    assert result["projections"][0]["present_value"] == pytest.approx(98.2142857, rel=1e-6)
    assert result["projections"][1]["present_value"] == pytest.approx(96.4604592, rel=1e-6)
    assert result["terminal_value"] == pytest.approx(1384.7777778, rel=1e-6)
    assert result["pv_terminal"] == pytest.approx(1103.9363503, rel=1e-6)
    assert result["enterprise_value"] == pytest.approx(1298.6110952, rel=1e-6)
    assert result["equity_value"] == pytest.approx(1248.6110952, rel=1e-6)
    assert result["value_per_share"] == pytest.approx(124.8611095, rel=1e-6)


def test_dcf_peso_del_terminal_es_visible():
    # Con supuestos típicos, el terminal domina el valor: la UI debe poder
    # enseñarlo, porque es donde vive la mayor incertidumbre.
    result = dcf(100, 0.05, 0.10, 0.025, years=5, shares_outstanding=1)
    assert result["terminal_weight"] == pytest.approx(
        result["pv_terminal"] / result["enterprise_value"]
    )
    assert result["terminal_weight"] > 0.5


def test_dcf_rechaza_terminal_mayor_que_descuento():
    with pytest.raises(ValueError, match="terminal"):
        dcf(100, 0.05, 0.06, 0.07)


def test_dcf_rechaza_years_invalido():
    with pytest.raises(ValueError):
        dcf(100, 0.05, 0.10, 0.02, years=0)


def test_sensibilidad_marca_combinaciones_invalidas():
    grid = sensitivity_grid(
        base_fcf=100,
        growth_rate=0.05,
        discount_rate=0.04,  # descuento bajo: filas r−2 % quedan ≤ terminal
        terminal_growth=0.03,
        shares_outstanding=1.0,
    )
    assert len(grid["rows"]) == 5
    assert len(grid["rows"][0]["values"]) == 5
    assert grid["rows"][0]["values"][0] is None  # r=2 % ≤ g_terminal=3 % → inválido
    assert grid["rows"][-1]["values"][0] is not None  # r=6 % > 3 % → válido


def test_sensibilidad_monotona_en_wacc():
    # A mayor tasa de descuento, menor valor: si esto falla, el DCF está roto.
    grid = sensitivity_grid(100, 0.05, 0.10, 0.02, shares_outstanding=1.0)
    center_col = [row["values"][2] for row in grid["rows"]]
    assert all(a > b for a, b in zip(center_col, center_col[1:]))


def test_escenarios_ordenados_bajista_menor_que_alcista():
    scenarios = scenario_set(
        {
            "bear": {"growth_rate": 0.00, "discount_rate": 0.12, "terminal_growth": 0.01},
            "base": {"growth_rate": 0.05, "discount_rate": 0.10, "terminal_growth": 0.02},
            "bull": {"growth_rate": 0.10, "discount_rate": 0.09, "terminal_growth": 0.03},
        },
        base_fcf=100.0,
        years=5,
        net_debt=0.0,
        shares_outstanding=10.0,
    )
    assert (
        scenarios["bear"]["value_per_share"]
        < scenarios["base"]["value_per_share"]
        < scenarios["bull"]["value_per_share"]
    )
    # Los supuestos de cada escenario viajan en la respuesta (transparencia).
    assert scenarios["bear"]["assumptions"]["growth_rate"] == 0.00

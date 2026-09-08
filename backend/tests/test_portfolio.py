"""Tests de cálculos de portafolio contra casos hechos a mano."""

import pytest

from app.analysis.portfolio import (
    allocation_weights,
    concentration_warning,
    portfolio_summary,
    position_metrics,
    realized_pnl,
)


def test_metricas_de_posicion_a_mano():
    # 10 acciones a 100 de coste, ahora a 130: invertido 1000, valor 1300,
    # no realizado +300 = +30 %.
    result = position_metrics({"quantity": 10.0, "cost_basis": 100.0}, price=130.0)
    assert result["invested"] == pytest.approx(1000.0)
    assert result["market_value"] == pytest.approx(1300.0)
    assert result["unrealized_pnl"] == pytest.approx(300.0)
    assert result["unrealized_pct"] == pytest.approx(0.30)


def test_posicion_en_perdida():
    result = position_metrics({"quantity": 5.0, "cost_basis": 200.0}, price=150.0)
    assert result["unrealized_pnl"] == pytest.approx(-250.0)
    assert result["unrealized_pct"] == pytest.approx(-0.25)


def test_posicion_sin_precio_no_vale_cero():
    result = position_metrics({"quantity": 10.0, "cost_basis": 100.0}, price=None)
    assert result["invested"] == pytest.approx(1000.0)
    assert result["market_value"] is None
    assert result["unrealized_pnl"] is None  # ausencia de dato, no pérdida total


def test_resumen_excluye_posiciones_sin_precio():
    positions = [
        {"invested": 1000.0, "market_value": 1300.0},
        {"invested": 500.0, "market_value": 400.0},
        {"invested": 800.0, "market_value": None},  # sin precio
    ]
    summary = portfolio_summary(positions)
    assert summary["total_invested"] == pytest.approx(2300.0)  # todo lo aportado
    assert summary["total_market_value"] == pytest.approx(1700.0)  # solo con precio
    # No realizado sobre lo valorable: 1700 − 1500 = +200 → +13.33 %
    assert summary["unrealized_pnl"] == pytest.approx(200.0)
    assert summary["unrealized_pct"] == pytest.approx(200 / 1500)
    assert summary["priced_positions"] == 2
    assert summary["total_positions"] == 3


def test_resumen_sin_precios_no_inventa_total():
    summary = portfolio_summary([{"invested": 1000.0, "market_value": None}])
    assert summary["total_market_value"] is None
    assert summary["unrealized_pnl"] is None


def test_resumen_vacio():
    summary = portfolio_summary([])
    assert summary["total_invested"] == 0
    assert summary["total_market_value"] is None


def test_pesos_por_posicion_suman_uno():
    positions = [
        {"symbol": "AAPL", "market_value": 6000.0},
        {"symbol": "MSFT", "market_value": 3000.0},
        {"symbol": "KO", "market_value": 1000.0},
    ]
    weights = allocation_weights(positions, "symbol")
    assert [w["label"] for w in weights] == ["AAPL", "MSFT", "KO"]  # ordenado desc
    assert weights[0]["weight"] == pytest.approx(0.6)
    assert sum(w["weight"] for w in weights) == pytest.approx(1.0)


def test_pesos_agrupan_por_sector():
    positions = [
        {"sector": "Tech", "market_value": 3000.0},
        {"sector": "Tech", "market_value": 1000.0},
        {"sector": "Salud", "market_value": 1000.0},
    ]
    weights = allocation_weights(positions, "sector")
    assert len(weights) == 2
    tech = next(w for w in weights if w["label"] == "Tech")
    assert tech["weight"] == pytest.approx(0.8)


def test_pesos_ignoran_posiciones_sin_precio():
    positions = [
        {"symbol": "AAPL", "market_value": 1000.0},
        {"symbol": "XYZ", "market_value": None},
    ]
    weights = allocation_weights(positions, "symbol")
    assert len(weights) == 1
    assert weights[0]["weight"] == pytest.approx(1.0)


def test_aviso_de_concentracion():
    weights = [
        {"label": "AAPL", "weight": 0.45},
        {"label": "MSFT", "weight": 0.30},
        {"label": "KO", "weight": 0.25},
    ]
    avisos = concentration_warning(weights, threshold=0.25)
    assert len(avisos) == 2  # 0.25 exacto no supera el umbral
    assert "AAPL" in avisos[0]


def test_pnl_realizado_suma_cierres():
    cerradas = [
        {"realized_pnl": 500.0},
        {"realized_pnl": -200.0},
        {"realized_pnl": None},  # tolerado
    ]
    assert realized_pnl(cerradas) == pytest.approx(300.0)

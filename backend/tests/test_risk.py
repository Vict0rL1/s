"""Tests de métricas de riesgo contra valores construidos a mano."""

import math

import pandas as pd
import pytest

from app.analysis.risk import annualized_volatility, beta, daily_returns, max_drawdown


def test_daily_returns_calculados_a_mano():
    closes = pd.Series([100.0, 110.0, 99.0])
    returns = daily_returns(closes)
    assert returns.iloc[0] == pytest.approx(0.10)
    assert returns.iloc[1] == pytest.approx(-0.10)


def test_beta_de_un_activo_apalancado_es_2():
    # El activo replica exactamente 2× el benchmark → beta = 2 por definición.
    bench = pd.Series([0.01, -0.02, 0.015, 0.005, -0.01] * 8)
    asset = bench * 2
    assert beta(asset, bench) == pytest.approx(2.0)


def test_beta_sin_datos_suficientes_es_none():
    assert beta(pd.Series([0.01] * 5), pd.Series([0.01] * 5)) is None


def test_volatilidad_anualizada_a_mano():
    returns = pd.Series([0.01, -0.01] * 15)  # 30 retornos alternos
    expected = returns.std(ddof=1) * math.sqrt(252)
    assert annualized_volatility(returns) == pytest.approx(float(expected))
    assert annualized_volatility(pd.Series([0.01] * 5)) is None  # muy pocos datos


def test_max_drawdown_calculado_a_mano():
    # Pico 120 → valle 84: drawdown = 84/120 − 1 = −30 %.
    closes = pd.Series(
        [100.0, 120.0, 110.0, 84.0, 95.0],
        index=["d1", "d2", "d3", "d4", "d5"],
    )
    result = max_drawdown(closes)
    assert result["max_drawdown"] == pytest.approx(-0.30)
    assert result["peak"] == "d2"
    assert result["trough"] == "d4"


def test_max_drawdown_serie_alcista_es_cero():
    closes = pd.Series([100.0, 101.0, 102.0])
    assert max_drawdown(closes)["max_drawdown"] == pytest.approx(0.0)


def test_max_drawdown_tolera_fechas_duplicadas():
    # Un proveedor puede devolver dos barras con la misma fecha. Con
    # indexación por etiqueta esto rompía el cálculo.
    closes = pd.Series(
        [100.0, 120.0, 80.0, 90.0], index=["d1", "d1", "d2", "d2"]
    )
    result = max_drawdown(closes)
    assert result["max_drawdown"] == pytest.approx(-1 / 3)  # 80/120 − 1

"""Tests de indicadores técnicos contra valores calculados a mano.

Los oráculos se calculan con implementaciones independientes (bucles
explícitos), no reutilizando el código bajo prueba.
"""

import math

import pandas as pd
import pytest

from app.analysis.indicators import ema, macd, rsi, sma


def test_sma_valores_conocidos():
    close = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0])
    out = sma(close, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2] == pytest.approx(2.0)  # (1+2+3)/3
    assert out[3] == pytest.approx(3.0)
    assert out[4] == pytest.approx(4.0)


def test_sma_ventana_invalida():
    with pytest.raises(ValueError):
        sma(pd.Series([1.0]), 0)


def test_ema_recurrencia_manual():
    close = pd.Series([10.0, 11.0, 12.0, 11.0, 13.0])
    span = 3
    alpha = 2 / (span + 1)
    out = ema(close, span)
    # Recurrencia estándar calculada a mano desde el primer valor.
    expected = close.iloc[0]
    for i in range(1, len(close)):
        expected = alpha * close.iloc[i] + (1 - alpha) * expected
    assert out.iloc[-1] == pytest.approx(expected)
    assert math.isnan(out.iloc[0])  # min_periods=span


def test_rsi_solo_subidas_es_100():
    close = pd.Series([float(i) for i in range(1, 31)])
    out = rsi(close, 14)
    assert out.iloc[-1] == pytest.approx(100.0)


def test_rsi_solo_bajadas_tiende_a_0():
    close = pd.Series([float(i) for i in range(30, 0, -1)])
    out = rsi(close, 14)
    assert out.iloc[-1] == pytest.approx(0.0, abs=1e-9)


def test_rsi_calculo_wilder_manual():
    # Serie corta con periodo 3, calculada a mano con el suavizado de Wilder.
    close = pd.Series([10.0, 11.0, 10.5, 11.5, 12.0, 11.0])
    period = 3
    out = rsi(close, period)

    deltas = close.diff().dropna().tolist()
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    # Suavizado de Wilder = EMA con alpha=1/period, arrancando en el primer delta.
    alpha = 1 / period
    avg_gain, avg_loss = gains[0], losses[0]
    for g, l in zip(gains[1:], losses[1:]):
        avg_gain = alpha * g + (1 - alpha) * avg_gain
        avg_loss = alpha * l + (1 - alpha) * avg_loss
    expected = 100 - 100 / (1 + avg_gain / avg_loss)
    assert out.iloc[-1] == pytest.approx(expected)


def test_rsi_esta_acotado_0_100():
    close = pd.Series([100 + ((-1) ** i) * (i % 7) for i in range(60)], dtype="float64")
    out = rsi(close, 14).dropna()
    assert ((out >= 0) & (out <= 100)).all()


def test_macd_es_diferencia_de_emas():
    close = pd.Series([float(100 + i + (i % 5)) for i in range(80)])
    out = macd(close)
    esperado = ema(close, 12) - ema(close, 26)
    pd.testing.assert_series_equal(out["macd"], esperado, check_names=False)
    # El histograma es macd - señal por construcción.
    resto = (out["histogram"] - (out["macd"] - out["signal"])).abs().dropna()
    assert (resto < 1e-12).all()


def test_macd_parametros_invalidos():
    with pytest.raises(ValueError):
        macd(pd.Series([1.0, 2.0]), fast=26, slow=12)

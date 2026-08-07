"""Tests del resumen de precio derivado de la descarga masiva de cierres.

Esta pieza es la que permite enseñar precio y minigráfico en 500 filas sin
gastar una sola llamada extra, así que conviene que sus casos raros —series
cortas, huecos, precio plano— estén cubiertos.
"""

from __future__ import annotations

import math

import pandas as pd

from app.providers.yfinance_provider import SPARK_POINTS, _price_summary


def serie(valores):
    return pd.Series(valores, dtype="float64")


def test_resume_precio_variacion_y_rango():
    resumen = _price_summary(serie([100.0, 110.0, 90.0, 120.0]))
    assert resumen["last"] == 120.0
    # Frente al cierre anterior (90), no frente al primero.
    assert resumen["change_pct"] == round((120 / 90 - 1) * 100, 2)
    assert resumen["low_52w"] == 90.0
    assert resumen["high_52w"] == 120.0
    assert resumen["points"] == 4


def test_la_posicion_en_el_rango_va_de_cero_a_uno():
    en_maximo = _price_summary(serie([50.0, 75.0, 100.0]))
    assert en_maximo["range_position"] == 1.0
    en_minimo = _price_summary(serie([100.0, 75.0, 50.0]))
    assert en_minimo["range_position"] == 0.0
    a_medias = _price_summary(serie([0.0, 100.0, 50.0]))
    assert a_medias["range_position"] == 0.5


def test_precio_plano_no_divide_entre_cero():
    """Un valor que no se ha movido no tiene posición en su rango: es None."""
    resumen = _price_summary(serie([42.0, 42.0, 42.0]))
    assert resumen["range_position"] is None
    assert resumen["change_pct"] == 0.0


def test_la_serie_se_muestrea_para_no_inflar_la_respuesta():
    """Con 500 empresas, cada punto de más son 500 números de más."""
    resumen = _price_summary(serie([float(i) for i in range(252)]))
    assert len(resumen["spark"]) == SPARK_POINTS
    # Conserva los extremos: la forma del año no se recorta.
    assert resumen["spark"][0] == 0.0
    assert resumen["spark"][-1] == 251.0
    assert resumen["points"] == 252


def test_series_cortas_se_devuelven_enteras():
    resumen = _price_summary(serie([10.0, 11.0, 12.0]))
    assert resumen["spark"] == [10.0, 11.0, 12.0]


def test_un_solo_cierre_no_inventa_variacion():
    resumen = _price_summary(serie([25.0]))
    assert resumen["last"] == 25.0
    assert resumen["change_pct"] is None  # no hay con qué comparar


def test_serie_vacia_o_toda_nan_devuelve_none():
    assert _price_summary(serie([])) is None
    assert _price_summary(pd.Series([math.nan, math.nan], dtype="float64")) is None
    assert _price_summary(None) is None


def test_los_valores_no_finitos_se_descartan():
    resumen = _price_summary(pd.Series([10.0, math.inf, 20.0], dtype="float64"))
    assert resumen["last"] == 20.0
    assert resumen["high_52w"] == 20.0

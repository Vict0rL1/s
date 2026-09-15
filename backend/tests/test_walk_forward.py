"""Tests de validación fuera de muestra y de distribuciones.

Lo que estos tests protegen: que la app no vuelva a publicar como
«probabilidad» una tasa ajustada con los mismos datos que pretende anticipar,
ni resuma con una media un resultado que la media describe mal.
"""

from __future__ import annotations

from app.analysis.rule_backtest import (
    MIN_OPERACIONES_VENTANA,
    distribucion,
    ventanas_rodantes,
)
from app.analysis.signal import calibrate, calibrate_walk_forward


def obs(score, gano, dia):
    return {"score": score, "outperformed": gano, "as_of": f"2021-{dia // 28 + 1:02d}-{dia % 28 + 1:02d}"}


def op(neto, fecha, ganadora=None):
    return {
        "neto_pct": neto,
        "entrada_fecha": fecha,
        "ganadora": neto > 0 if ganadora is None else ganadora,
    }


# --- Calibración fuera de muestra -------------------------------------------


def test_la_calibracion_normal_es_circular_y_la_walk_forward_no():
    """La tabla in-sample se ajusta con los mismos resultados que luego publica
    como predicción; sobre datos puramente aleatorios eso se nota."""
    import random

    random.seed(7)
    observaciones = [obs(random.uniform(-1, 1), random.random() > 0.5, i) for i in range(400)]

    dentro = calibrate(observaciones)
    fuera = calibrate_walk_forward(observaciones)

    # In-sample siempre encuentra "estructura" en el ruido: algún cubo se aleja
    # del 50 %. Fuera de muestra, sobre ruido, la tasa vuelve a ~50 %.
    assert fuera["n_evaluadas"] > 50
    assert 0.35 < fuera["tasa_acierto"] < 0.65
    assert dentro  # la tabla in-sample existe, pero no es una predicción


def test_las_primeras_observaciones_no_cuentan_como_aciertos_gratis():
    """Sin historia no se puede predecir; contarlas infla el resultado."""
    r = calibrate_walk_forward([obs(0.8, True, i) for i in range(10)], min_obs=5)
    assert r["sin_historia"] == 5
    assert r["n_evaluadas"] == 5


def test_una_senal_de_verdad_predictiva_si_se_detecta_fuera_de_muestra():
    """El test anterior por sí solo no distingue «honesto» de «roto»."""
    observaciones = [obs(0.9, True, i) for i in range(60)]
    observaciones += [obs(-0.9, False, i) for i in range(60, 120)]
    r = calibrate_walk_forward(observaciones, min_obs=5)
    assert r["tasa_acierto"] == 1.0


def test_la_nota_advierte_de_que_este_numero_sera_peor():
    r = calibrate_walk_forward([obs(0.5, True, i) for i in range(50)], min_obs=5)
    assert "circular" in r["nota"]
    assert "peor" in r["nota"]


# --- Distribución en vez de un número único ---------------------------------


def test_la_media_esconde_la_forma_del_resultado():
    """Dos sistemas con la misma media son cosas muy distintas."""
    constante = [op(2.0, f"2021-01-{i % 28 + 1:02d}") for i in range(20)]
    loteria = [op(-5.0, f"2021-01-{i % 28 + 1:02d}") for i in range(18)]
    loteria += [op(65.0, "2021-02-01"), op(65.0, "2021-02-02")]

    a, b = distribucion(constante), distribucion(loteria)
    assert abs(a["media"] - b["media"]) < 0.5     # misma media
    assert a["mediana"] != b["mediana"]           # forma distinta
    assert b["p10"] < 0 < b["p90"]


def test_los_escenarios_son_percentiles_reales_no_supuestos():
    d = distribucion([op(float(i), f"2021-01-{i % 28 + 1:02d}") for i in range(1, 21)])
    assert d["escenarios"]["bajista"] == d["p10"]
    assert d["escenarios"]["base"] == d["mediana"]
    assert d["escenarios"]["alcista"] == d["p90"]
    assert "no supuestos" in d["nota"]


def test_sin_operaciones_no_se_inventa_una_distribucion():
    assert distribucion([])["n"] == 0


# --- Ventanas rodantes ------------------------------------------------------


def test_detecta_que_la_ventaja_sale_de_un_solo_tramo():
    """+2 % de media que en realidad es -3 % tres años y +17 % uno."""
    ops = [op(-3.0, f"2021-{m:02d}-01") for m in range(1, 13) for _ in range(3)]
    ops += [op(17.0, f"2022-{m:02d}-01") for m in range(1, 13) for _ in range(3)]
    r = ventanas_rodantes(ops, n_ventanas=4)
    assert r["estable"] is False
    assert r["ventanas_positivas"] < len(r["ventanas"])
    assert "suerte de un tramo" in r["nota"]


def test_una_ventaja_estable_se_reconoce_como_tal():
    ops = [op(2.0, f"202{a}-{m:02d}-01") for a in range(1, 5) for m in range(1, 13)]
    r = ventanas_rodantes(ops, n_ventanas=4)
    assert r["estable"] is True
    assert "lo mínimo para creérsela" in r["nota"]


def test_con_pocas_operaciones_no_se_parte_en_ventanas():
    r = ventanas_rodantes([op(1.0, "2021-01-01")] * (MIN_OPERACIONES_VENTANA * 2 - 1))
    assert r["ventanas"] == []
    assert r["estable"] is None

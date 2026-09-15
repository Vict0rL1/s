"""Tests de la comparación contra baselines.

El riesgo de este módulo no es que calcule mal: es que redacte bien. Un
backtest que solo sabe dar buenas noticias no valida nada. La mitad de estos
tests comprueban que el veredicto dice que no cuando toca.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

from app.analysis.baselines import (
    MARGEN_CLARO_PCT,
    bootstrap_diferencia,
    comparar,
    hacer_seleccion_momentum,
    metricas,
    seleccion_comprar_y_mantener,
    seleccion_equiponderada,
    simular_cartera,
)


def universo(tasas: dict[str, float], dias=1500, inicio=date(2019, 1, 1)):
    """Cada símbolo crece a una tasa diaria compuesta fija."""
    return {
        s: {
            "bars": [
                {"ts": (inicio + timedelta(days=t)).isoformat(), "close": 100 * math.exp(r * t)}
                for t in range(dias)
            ]
        }
        for s, r in tasas.items()
    }


def fechas_mensuales(n=36, inicio=date(2020, 1, 1)):
    salida, actual = [], inicio
    for _ in range(n):
        salida.append(actual)
        mes = actual.month + 1
        actual = date(actual.year + (mes - 1) // 12, (mes - 1) % 12 + 1, 1)
    return salida


def ops(symbol, tramos):
    return [
        {"symbol": symbol, "entrada_fecha": a, "salida_fecha": b, "neto_pct": 0.0,
         "ganadora": True}
        for a, b in tramos
    ]


# --- El motor mide lo que dice medir ----------------------------------------


def test_comprar_y_mantener_no_paga_rotacion_y_rebalancear_si():
    """Si el rebalanceo saliera gratis, el baseline 2 ganaría siempre."""
    u = universo({"A": 0.0004, "B": 0.0001, "C": 0.0002})
    f = fechas_mensuales()
    quieto = simular_cartera(u, f, seleccion_comprar_y_mantener, coste_lado=1.0)
    rebal = simular_cartera(u, f, seleccion_equiponderada, coste_lado=1.0)
    assert quieto["rotacion_media"] < rebal["rotacion_media"]


def test_sin_costes_las_metricas_reflejan_el_crecimiento_real():
    # Las barras son días NATURALES, no sesiones: e^(0.0004 × 365) − 1 ≈ 15,7 %.
    u = universo({"A": 0.0004})
    m = simular_cartera(u, fechas_mensuales(), seleccion_equiponderada, coste_lado=0.0)
    esperado = (math.exp(0.0004 * 365) - 1) * 100
    assert abs(m["cagr_pct"] - esperado) < 1.0, (m["cagr_pct"], esperado)
    assert m["max_drawdown_pct"] == 0.0  # crecimiento monótono


def test_el_drawdown_captura_la_peor_caida_desde_maximos():
    curva = [{"fecha": "x", "capital": c} for c in (1.0, 1.5, 0.75, 1.2)]
    m = metricas(curva, [0.5, -0.5, 0.6])
    assert m["max_drawdown_pct"] == -50.0


def test_el_momentum_elige_a_las_que_mas_subieron():
    u = universo({"GANA": 0.0008, "PIERDE": -0.0004, "MEDIA": 0.0001})
    sel = hacer_seleccion_momentum(top_n=1)
    assert sel(u, date(2022, 1, 1), True) == {"GANA"}


# --- Bootstrap ---------------------------------------------------------------


def test_dos_series_identicas_no_se_distinguen_del_azar():
    serie = [0.01, -0.02, 0.03, 0.00, 0.015, -0.01] * 8
    r = bootstrap_diferencia(serie, serie, n=300)
    assert r["diferencia_anual_pct"] == 0.0
    assert r["distinguible_del_azar"] is False


def test_una_ventaja_grande_y_constante_si_se_distingue():
    a = [0.02] * 48
    b = [0.00] * 48
    r = bootstrap_diferencia(a, b, n=300)
    assert r["distinguible_del_azar"] is True
    assert r["ic95"][0] > 0


def test_con_pocos_periodos_no_se_inventa_un_intervalo():
    r = bootstrap_diferencia([0.01] * 5, [0.0] * 5)
    assert r["suficiente"] is False


def test_el_remuestreo_es_por_bloques_no_por_meses_sueltos():
    """Remuestrear meses sueltos rompe la autocorrelación y estrecha el
    intervalo: declararía significativo lo que no lo es."""
    from app.analysis.baselines import BLOQUE_BOOTSTRAP

    assert BLOQUE_BOOTSTRAP > 1
    # Ruido puro con la misma media: el intervalo debe contener el cero.
    import random
    rng = random.Random(3)
    a = [rng.gauss(0.008, 0.05) for _ in range(72)]
    b = [rng.gauss(0.008, 0.05) for _ in range(72)]
    r = bootstrap_diferencia(a, b, n=500)
    assert r["ic95"][0] < 0 < r["ic95"][1]


# --- El veredicto, que es lo que importa ------------------------------------


def test_dice_NO_SUPERA_cuando_el_baseline_gana():
    """La razón de ser del módulo: decir que no."""
    u = universo({"A": 0.0006, "B": 0.0006, "C": 0.0006})
    f = fechas_mensuales()
    # La estrategia solo está dentro un tramo corto; comprar y mantener gana.
    r = comparar(u, f, ops("A", [("2020-02-01", "2020-05-01")]), coste_lado=0.1)
    assert "NO SUPERA AL BASELINE" in r["veredicto"]
    assert "a favor de no hacer nada" in r["veredicto"]
    assert "cuesta comisiones y atención" in r["veredicto"]


def test_una_ventaja_minima_se_llama_empate_y_no_victoria():
    """Ganar por décimas se lo come cualquier diferencia de comisiones."""
    from app.analysis.baselines import _veredicto

    resultados = {
        "estrategia": {"cagr_pct": 10.4, "vol_pct": 12.0, "sharpe": 0.87, "max_drawdown_pct": -20.0},
        "comprar_y_mantener": {"cagr_pct": 10.0},
        "equiponderada": {"cagr_pct": 9.5},
        "momentum_12m": {"cagr_pct": 9.0},
    }
    v = _veredicto(resultados, {})
    assert "trátalo como un empate" in v
    assert 10.4 - 10.0 < MARGEN_CLARO_PCT


def test_ganar_sin_significancia_se_declara_indistinguible_del_azar():
    from app.analysis.baselines import _veredicto

    resultados = {
        "estrategia": {"cagr_pct": 15.0, "vol_pct": 12.0, "sharpe": 1.25, "max_drawdown_pct": -20.0},
        "comprar_y_mantener": {"cagr_pct": 8.0},
        "equiponderada": {"cagr_pct": 7.5},
        "momentum_12m": {"cagr_pct": 9.0},
    }
    comparaciones = {n: {"distinguible_del_azar": False} for n in resultados if n != "estrategia"}
    v = _veredicto(resultados, comparaciones)
    assert "no se distingue del azar" in v


def test_una_ventaja_real_se_reconoce_pero_con_la_salvedad_del_universo():
    from app.analysis.baselines import _veredicto

    resultados = {
        "estrategia": {"cagr_pct": 15.0, "vol_pct": 12.0, "sharpe": 1.25, "max_drawdown_pct": -20.0},
        "comprar_y_mantener": {"cagr_pct": 8.0},
        "equiponderada": {"cagr_pct": 7.5},
        "momentum_12m": {"cagr_pct": 9.0},
    }
    comparaciones = {n: {"distinguible_del_azar": True} for n in resultados if n != "estrategia"}
    v = _veredicto(resultados, comparaciones)
    assert "fuera del azar" in v
    assert "sin las empresas que quebraron" in v


def test_la_tabla_trae_las_cuatro_carteras_con_las_mismas_metricas():
    u = universo({"A": 0.0004, "B": 0.0002, "C": 0.0006})
    r = comparar(u, fechas_mensuales(), ops("A", [("2020-01-01", "2022-12-01")]), 0.1)
    assert set(r["tabla"]) == {"estrategia", "comprar_y_mantener", "equiponderada", "momentum_12m"}
    for fila in r["tabla"].values():
        for m in ("cagr_pct", "vol_pct", "sharpe", "max_drawdown_pct"):
            assert m in fila


def test_la_metodologia_advierte_del_sharpe_con_tasa_cero():
    u = universo({"A": 0.0004, "B": 0.0002, "C": 0.0006})
    r = comparar(u, fechas_mensuales(), ops("A", [("2020-01-01", "2021-01-01")]), 0.1)
    assert "tasa libre de riesgo 0" in r["metodologia"]
    assert "no es comparable con el Sharpe publicado" in r["metodologia"]


def test_mas_retorno_con_mas_volatilidad_no_se_presenta_como_ganar():
    """Un Sharpe inferior significa que el retorno extra viene de asumir más
    riesgo, y esa palanca se consigue sin modelo: comprando el baseline con
    margen. Decir solo «rinde más» lo escondería."""
    from app.analysis.baselines import _veredicto

    resultados = {
        "estrategia": {"cagr_pct": 28.3, "vol_pct": 22.1, "sharpe": 1.28, "max_drawdown_pct": -21.6},
        "comprar_y_mantener": {"cagr_pct": 16.7, "sharpe": 1.33},
        "equiponderada": {"cagr_pct": 16.4, "sharpe": 1.39},
        "momentum_12m": {"cagr_pct": 16.4, "sharpe": 1.39},
    }
    v = _veredicto(resultados, {n: {"distinguible_del_azar": True} for n in resultados})
    assert "su Sharpe (1.28) es PEOR" in v
    assert "no de elegir mejor" in v


def test_con_mejor_sharpe_no_se_avisa_de_nada():
    from app.analysis.baselines import _veredicto

    resultados = {
        "estrategia": {"cagr_pct": 20.0, "vol_pct": 10.0, "sharpe": 2.0, "max_drawdown_pct": -9.0},
        "comprar_y_mantener": {"cagr_pct": 8.0, "sharpe": 0.8},
        "equiponderada": {"cagr_pct": 7.5, "sharpe": 0.7},
        "momentum_12m": {"cagr_pct": 9.0, "sharpe": 0.9},
    }
    v = _veredicto(resultados, {n: {"distinguible_del_azar": True} for n in resultados})
    assert "es PEOR" not in v

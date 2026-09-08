"""Rangos, DCF inverso y comparables ajustados.

La regla que gobierna todo el módulo —**nunca un precio objetivo único**— se fija
aquí de la forma más dura que se puede: recorriendo la respuesta entera y
comprobando que no hay ningún campo suelto que contenga un precio. Una regla que
solo vive en el docstring dura hasta el siguiente que añada un campo.
"""

from __future__ import annotations

import math

import pytest

from app.analysis.relative_value import (
    MAX_CONDICION,
    MIN_PARES,
    MIN_R2,
    ajustar_por_crecimiento_y_calidad,
    rango_de_precio_implicito,
)
from app.analysis.reverse_dcf import (
    CRECIMIENTO_MAX,
    curva_de_crecimiento_implicito,
    juzgar_contra_el_pasado,
    margen_implicito,
)
from app.analysis.valuation import (
    dcf,
    rango_de_valor,
    redondear,
    sensibilidad_ordenada,
)


# --- Rangos, no puntos --------------------------------------------------------


def test_un_escenario_devuelve_un_rango_y_no_un_numero():
    """Tres escenarios con un valor puntual cada uno son TRES precios objetivo,
    no un rango. Cada escenario tiene que traer su propia horquilla."""
    r = rango_de_valor(1000e6, 0.08, 0.09, 0.025, 5, 500e6, 100e6)
    assert r["disponible"] is True
    assert r["bajo"] < r["centro"] < r["alto"]
    assert r["amplitud_pct"] > 0


def test_la_precision_se_recorta_a_lo_que_el_metodo_aguanta():
    """«147,32 $» finge céntimos sobre un método donde un cuarto de punto de
    WACC cambia el resultado en varios euros."""
    assert redondear(147.3219) == 147.0
    assert redondear(1473.219) == 1470.0
    assert redondear(0.0147319) == 0.0147
    assert redondear(None) is None
    assert redondear(0) == 0


def test_un_rango_muy_ancho_se_declara_como_lo_que_es():
    """Un rango de ±60 % no es una valoración: es un aviso de que el método no
    discrimina, y debe decirse en vez de servir el centro como si valiera."""
    r = rango_de_valor(
        1000e6, 0.12, 0.085, 0.03, 5, 0.0, 100e6,
        banda_crecimiento=0.05, banda_descuento=0.02,
    )
    assert r["amplitud_pct"] > 60
    assert "no discrimina" in r["nota"]


def test_un_peso_terminal_alto_se_dice_alto():
    """Si tres cuartas partes del valor están después del horizonte, esto no es
    una valoración de los próximos años."""
    r = rango_de_valor(1000e6, 0.08, 0.09, 0.03, 5, 0.0, 100e6)
    assert r["peso_terminal"] > 0.7
    assert "apuesta sobre la perpetuidad" in r["nota"]


def test_una_banda_invalida_entera_no_finge_un_rango():
    r = rango_de_valor(1000e6, 0.08, 0.03, 0.035, 5, 0.0, 100e6)
    assert r["disponible"] is False


# --- Qué supuesto manda -------------------------------------------------------


def test_la_sensibilidad_ordena_los_supuestos_por_cuanto_mueven():
    s = sensibilidad_ordenada(1000e6, 0.08, 0.09, 0.025, 5, 500e6, 100e6)
    assert s["disponible"] is True
    recorridos = [f["recorrido_pct"] for f in s["supuestos"]]
    assert recorridos == sorted(recorridos, reverse=True)
    assert s["dominante"] == s["supuestos"][0]["supuesto"]


def test_incluye_el_crecimiento_a_perpetuidad_que_la_matriz_clasica_deja_fuera():
    """En muchas empresas es el que más manda, porque el valor terminal se lleva
    tres cuartas partes del total, y la matriz WACC × crecimiento no lo toca."""
    s = sensibilidad_ordenada(1000e6, 0.08, 0.09, 0.025, 5, 500e6, 100e6)
    claves = {f["supuesto"] for f in s["supuestos"]}
    assert "terminal_growth" in claves
    assert "base_fcf" in claves


def test_las_perturbaciones_son_comparables_entre_si():
    """Perturbar cada supuesto un 10 % de su valor daría un orden engañoso: un
    10 % de un WACC del 9 % es 0,9 pp y un 10 % de un terminal del 2,5 % es
    0,25 pp, así que el WACC ganaría por la unidad, no por su influencia."""
    from app.analysis.valuation import PERTURBACIONES

    assert PERTURBACIONES["growth_rate"][0] == PERTURBACIONES["discount_rate"][0]


# --- DCF inverso --------------------------------------------------------------


def test_el_inverso_recupera_exactamente_el_crecimiento_del_directo():
    """La comprobación que hace confiable todo lo demás: si el precio ES el
    valor que da un DCF al 8 %, el inverso tiene que devolver 8 %."""
    valor = dcf(1000e6, 0.08, 0.09, 0.025, 5, net_debt=500e6)["equity_value"]
    curva = curva_de_crecimiento_implicito(
        market_cap=valor, base_fcf=1000e6, terminal_growth=0.025, net_debt=500e6
    )
    al_9 = next(p for p in curva["puntos"] if p["discount_rate"] == 0.09)
    assert abs(al_9["crecimiento_implicito"] - 0.08) < 1e-4


def test_el_crecimiento_implicito_viaja_como_curva_no_como_numero():
    """No es una propiedad de la empresa: es función del WACC que elijas, y
    cambiarlo dos puntos puede duplicar la respuesta."""
    valor = dcf(1000e6, 0.08, 0.09, 0.025, 5, net_debt=500e6)["equity_value"]
    c = curva_de_crecimiento_implicito(
        market_cap=valor, base_fcf=1000e6, terminal_growth=0.025, net_debt=500e6
    )
    assert len(c["puntos"]) >= 5
    assert c["rango"]["alto"] - c["rango"]["bajo"] > 0.10  # más de 10 pp de recorrido
    assert "No es un dato de la empresa" in c["nota"]


def test_un_precio_absurdo_lo_dice_en_vez_de_devolver_un_numero_absurdo():
    """Que el número exacto sea 70 % u 80 % da igual: lo informativo es que el
    precio no se explica con el flujo de caja actual."""
    from app.analysis.reverse_dcf import crecimiento_implicito

    r = crecimiento_implicito(
        market_cap=1e15, base_fcf=1000e6, discount_rate=0.09,
        terminal_growth=0.025, years=5,
    )
    assert r["disponible"] is False
    assert r["fuera_de_rango"] == "arriba"
    assert f"{CRECIMIENTO_MAX * 100:.0f} %" in r["motivo"]


def test_sin_flujo_de_caja_positivo_el_inverso_no_aplica():
    from app.analysis.reverse_dcf import crecimiento_implicito

    r = crecimiento_implicito(
        market_cap=1e9, base_fcf=-50e6, discount_rate=0.09,
        terminal_growth=0.025, years=5,
    )
    assert r["disponible"] is False
    assert "quema caja" in r["motivo"]


def test_el_veredicto_razona_sobre_el_rango_entero_no_sobre_su_centro():
    """El fallo que tuvo la primera versión: con una curva de −0,5 % a 18 % —lo
    normal— resumía el punto medio y concluía «ni exige un cambio». El centro de
    un rango de dieciocho puntos no describe nada."""
    valor = dcf(1000e6, 0.08, 0.09, 0.025, 5, net_debt=500e6)["equity_value"]
    curva = curva_de_crecimiento_implicito(
        market_cap=valor, base_fcf=1000e6, terminal_growth=0.025, net_debt=500e6
    )
    j = juzgar_contra_el_pasado(curva, {"fcf_cagr": 0.04, "revenue_cagr": 0.05})
    assert "implicito_centro" not in j
    assert j["wacc_de_cruce"] is not None
    assert "decide tu tasa de descuento" in j["nota"]


def test_cuando_todo_el_rango_supera_al_historico_la_afirmacion_es_fuerte():
    """«En todo el rango de descuentos» es una afirmación que no depende del
    WACC, y por eso vale mucho más que una comparación con el centro."""
    valor = dcf(1000e6, 0.08, 0.09, 0.025, 5, net_debt=500e6)["equity_value"]
    curva = curva_de_crecimiento_implicito(
        market_cap=valor * 2.2, base_fcf=1000e6, terminal_growth=0.025, net_debt=500e6
    )
    j = juzgar_contra_el_pasado(curva, {"fcf_cagr": 0.04, "revenue_cagr": 0.05})
    assert j["wacc_de_cruce"] is None
    assert "No depende de qué WACC elijas" in j["nota"]


def test_el_margen_implicito_es_exacto_porque_el_valor_es_lineal_en_el_margen():
    """Sin bisección: el valor de empresa es proporcional al margen de FCF, así
    que despejarlo es una división. Se comprueba invirtiendo el cálculo."""
    revenue, margen = 5000e6, 0.20
    ev = dcf(revenue * margen, 0.05, 0.09, 0.025, 5, net_debt=0.0)["enterprise_value"]
    r = margen_implicito(
        market_cap=ev - 500e6, revenue=revenue, margen_actual=margen,
        revenue_growth=0.05, discount_rate=0.09, terminal_growth=0.025, net_debt=500e6,
    )
    assert r["disponible"] is True
    assert abs(r["margen_implicito"] - margen) < 1e-6
    assert abs(r["expansion_necesaria_pp"]) < 0.01


def test_un_precio_alto_exige_expandir_el_margen_y_lo_dice():
    ev = dcf(5000e6 * 0.20, 0.05, 0.09, 0.025, 5)["enterprise_value"]
    r = margen_implicito(
        market_cap=ev * 1.5, revenue=5000e6, margen_actual=0.20, revenue_growth=0.05,
        discount_rate=0.09, terminal_growth=0.025,
    )
    assert r["margen_implicito"] > 0.28
    assert "Pregúntate de dónde saldría" in r["nota"]


# --- Comparables ajustados ----------------------------------------------------


def pares_con_relacion(n=7, ruido=0.8, semilla=3):
    """Pares donde crecimiento y calidad varían de forma INDEPENDIENTE.

    Hacerlos variar juntos —que es lo fácil— produce colinealidad perfecta y el
    test acabaría probando el guardián en vez de la regresión.
    """
    import random

    rng = random.Random(semilla)
    combos = [(0.03, 0.28), (0.16, 0.10), (0.06, 0.22), (0.19, 0.31),
              (0.02, 0.09), (0.11, 0.18), (0.14, 0.07)][:n]
    return [
        {"symbol": f"P{i}", "crecimiento": g, "calidad": q,
         "multiplo": 6 + 80 * g + 30 * q + rng.gauss(0, ruido)}
        for i, (g, q) in enumerate(combos)
    ]


OBJETIVO = {"symbol": "OBJ", "crecimiento": 0.14, "calidad": 0.26, "multiplo": 28.0}


def test_el_ajuste_devuelve_un_intervalo_de_prediccion_no_un_multiplo():
    r = ajustar_por_crecimiento_y_calidad(pares_con_relacion(), OBJETIVO)
    assert r["disponible"] and r["fiable"]
    assert r["intervalo"]["bajo"] < r["multiplo_sugerido"] < r["intervalo"]["alto"]
    assert r["grados_libertad"] == 4  # 7 pares - 3 parámetros


def test_el_objetivo_no_entra_en_su_propio_ajuste():
    """Si entrara, su múltiplo predicho sería un residuo de sí mismo."""
    pares = pares_con_relacion()
    con_objetivo = [*pares, {**OBJETIVO, "symbol": "OBJ"}]
    a = ajustar_por_crecimiento_y_calidad(pares, OBJETIVO)
    b = ajustar_por_crecimiento_y_calidad(con_objetivo, OBJETIVO)
    assert a["pares_usables"] == b["pares_usables"] == len(pares)


def test_un_ajuste_que_no_explica_nada_se_niega_a_concluir():
    import random

    rng = random.Random(11)
    pares = [
        {**p, "multiplo": rng.uniform(10, 35)} for p in pares_con_relacion()
    ]
    r = ajustar_por_crecimiento_y_calidad(pares, OBJETIVO)
    assert r["r2"] < MIN_R2
    assert r["fiable"] is False
    assert "no sostiene una conclusión" in r["nota"]


def test_crecimiento_y_calidad_colineales_se_detectan_antes_de_regresar():
    """`inv()` no falla con casi-colinealidad: devuelve basura. En un sector
    real las empresas buenas suelen crecer, así que este caso pasa de verdad."""
    colineales = [
        {"symbol": f"C{i}", "crecimiento": 0.02 + i * 0.025,
         "calidad": 0.08 + i * 0.03, "multiplo": 15 + i}
        for i in range(7)
    ]
    r = ajustar_por_crecimiento_y_calidad(colineales, OBJETIVO)
    assert r["disponible"] is False
    assert r["indice_condicion"] > MAX_CONDICION
    assert "no puede separar sus efectos" in r["nota"]
    assert r["crudo"] is not None  # se cae a la comparación cruda


def test_con_pocos_pares_no_se_hace_una_regresion_de_dos_variables():
    r = ajustar_por_crecimiento_y_calidad(pares_con_relacion(3), OBJETIVO)
    assert r["disponible"] is False
    assert str(MIN_PARES) in r["nota"]
    assert "NO está ajustada" in r["nota"]


def test_el_intervalo_usa_la_t_de_student_y_no_la_normal():
    """Con 4 grados de libertad, usar 1,96 estrecharía el intervalo casi a la
    mitad — justo el error que este módulo existe para no cometer."""
    from app.analysis.relative_value import _t_critico

    assert _t_critico(4) == pytest.approx(2.776)
    assert _t_critico(3) > _t_critico(10) > _t_critico(100)
    assert _t_critico(100) == 1.96


def test_el_multiplo_se_traduce_a_un_rango_de_precio_no_a_uno_solo():
    r = rango_de_precio_implicito(20.0, 26.0, 5.0, 140.0)
    assert r["precio_bajo"] == 100.0
    assert r["precio_alto"] == 130.0
    assert r["posicion"] == "por encima"
    assert "no un precio objetivo" in r["nota"]


def test_sin_denominador_positivo_el_multiplo_no_se_traduce():
    """Una empresa en pérdidas no tiene un P/E que traducir a precio."""
    assert rango_de_precio_implicito(20.0, 26.0, -2.0, 140.0)["disponible"] is False

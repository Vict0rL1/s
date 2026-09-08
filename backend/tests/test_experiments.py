"""Tests del registro, el Sharpe deflactado y el holdout bloqueado.

Lo que protegen: que probar cuarenta variantes y quedarse con la mejor no pueda
presentarse como un hallazgo, y que el holdout no se pueda mirar por accidente.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

from app.analysis.experiments import (
    FRACCION_HOLDOUT,
    HoldoutBloqueado,
    abrir_holdout,
    corregir_multiples,
    historial,
    partir_periodo,
    pvalor_desde_bootstrap,
    registrar,
    sharpe_deflactado,
    sharpe_esperado_del_mejor,
)


def serie(media=0.01, sigma=0.04, n=72, semilla=5):
    rng = random.Random(semilla)
    return [rng.gauss(media, sigma) for _ in range(n)]


# --- Holdout: reservado y con huella ----------------------------------------


def test_el_corte_es_cronologico_no_aleatorio():
    """Partir al azar dejaría un holdout que comparte régimen de mercado con el
    desarrollo: no sería información nueva."""
    fechas = [date(2020, 1, 1) + timedelta(days=30 * i) for i in range(40)]
    p = partir_periodo(fechas)
    assert max(p["desarrollo"]) < min(p["holdout"])
    assert abs(len(p["holdout"]) / len(fechas) - FRACCION_HOLDOUT) < 0.05


def test_el_holdout_no_se_abre_sin_confirmacion_explicita():
    with pytest.raises(HoldoutBloqueado):
        abrir_holdout("", veces_abierto=0)
    with pytest.raises(HoldoutBloqueado):
        abrir_holdout("si", veces_abierto=0)
    # Ni siquiera algo que "suena" a confirmación.
    with pytest.raises(HoldoutBloqueado):
        abrir_holdout("True", veces_abierto=0)


def test_la_primera_apertura_es_fuera_de_muestra_y_las_demas_no():
    """Un holdout mirado dos veces ya no es un holdout."""
    primera = abrir_holdout("SI, QUEMAR EL HOLDOUT", veces_abierto=0)
    assert primera["sigue_siendo_fuera_de_muestra"] is True
    assert "quemado" in primera["aviso"]

    segunda = abrir_holdout("SI, QUEMAR EL HOLDOUT", veces_abierto=1)
    assert segunda["sigue_siendo_fuera_de_muestra"] is False
    assert "NO es fuera de muestra" in segunda["aviso"]


def test_un_periodo_corto_no_finge_tener_holdout():
    p = partir_periodo([date(2021, 1, 1), date(2021, 2, 1)])
    assert p["suficiente"] is False
    assert p["holdout"] == []


# --- Sharpe deflactado -------------------------------------------------------


def test_probar_mas_veces_sube_el_liston():
    """Con cuarenta intentos sobre ruido, alguno sale bien por construcción."""
    umbrales = [sharpe_esperado_del_mejor(n, 0.15) for n in (2, 10, 40, 200)]
    assert umbrales == sorted(umbrales)
    assert umbrales[-1] > umbrales[0] * 2


def test_el_mismo_resultado_deja_de_ser_hallazgo_si_probaste_mucho():
    """El punto entero del módulo: el Sharpe no mide solo la estrategia, mide
    también cuántas veces miraste."""
    retornos = serie(media=0.012, sigma=0.03)
    sharpes = [0.05 * i for i in range(-6, 7)]  # dispersión observada

    poco = sharpe_deflactado(retornos, n_pruebas=2, sharpes_probados=sharpes)
    mucho = sharpe_deflactado(retornos, n_pruebas=300, sharpes_probados=sharpes)

    assert poco["dsr"] > mucho["dsr"]
    assert mucho["sharpe_umbral"] > poco["sharpe_umbral"]
    assert poco["sharpe_observado"] == mucho["sharpe_observado"]  # no cambia


def test_avisa_de_que_el_dsr_depende_del_recuento():
    r = sharpe_deflactado(serie(), n_pruebas=5)
    assert "solo es tan honesto como el recuento" in r["nota"]
    assert "no registraste lo inflan" in r["nota"]


def test_una_serie_sin_ventaja_no_sale_como_hallazgo():
    r = sharpe_deflactado(serie(media=0.0, sigma=0.05), n_pruebas=20)
    assert r["es_hallazgo"] is False
    assert "compatible con haber probado" in r["nota"]


def test_con_muy_pocos_periodos_no_se_calcula():
    assert sharpe_deflactado([0.01] * 5, n_pruebas=3)["suficiente"] is False


# --- Comparaciones múltiples -------------------------------------------------


def test_bonferroni_es_mas_estricto_que_benjamini_hochberg():
    ps = {f"e{i}": p for i, p in enumerate([0.001, 0.01, 0.03, 0.04, 0.2, 0.6])}
    r = corregir_multiples(ps)
    assert len(r["sobreviven_bonferroni"]) <= len(r["sobreviven_bh"])
    assert "e0" in r["sobreviven_bonferroni"]  # 0.001 < 0.05/6


def test_un_pvalor_que_pasaria_solo_deja_de_pasar_al_probar_muchas():
    """0,04 es «significativo» hasta que resulta que probaste veinte cosas."""
    solo = corregir_multiples({"a": 0.04})
    entre_muchas = corregir_multiples({f"e{i}": 0.04 for i in range(20)})
    assert solo["bonferroni"]["a"] is True
    assert entre_muchas["bonferroni"]["e0"] is False


def test_la_nota_explica_para_que_sirve_cada_correccion():
    r = corregir_multiples({"a": 0.01, "b": 0.4})
    assert "proporción de falsos" in r["nota"]


def test_el_pvalor_del_bootstrap_no_asume_normalidad():
    """Los retornos tienen colas gordas; asumir normalidad estrecharía todo."""
    centrado = [-1.0, -0.5, 0.0, 0.5, 1.0] * 20
    assert pvalor_desde_bootstrap(centrado) > 0.5
    todo_positivo = [1.0] * 100
    assert pvalor_desde_bootstrap(todo_positivo) == 0.0


# --- El registro -------------------------------------------------------------


def test_el_historial_cuenta_las_pruebas_y_avisa_del_holdout(session_factory):
    with session_factory() as s:
        for i in range(3):
            registrar(
                s,
                hipotesis=f"variante {i}",
                estrategia="reglas",
                parametros={"umbral": 0.3 + i * 0.05},
                desde="2019-01-01",
                hasta="2023-01-01",
                universo=["AAPL", "MSFT"],
                resultado={"cagr_pct": 5.0 + i},
                sharpe=0.1 * i,
            )
        h = historial(s)

    assert h["n_pruebas"] == 3
    assert h["veces_holdout_abierto"] == 0
    assert len(h["sharpes"]) == 3
    assert "solo es honesto si están todas" in h["nota"]


def test_un_experimento_sobre_el_holdout_queda_marcado_para_siempre(session_factory):
    """La cuenta de aperturas es lo que impide fingir que solo se miró una vez."""
    with session_factory() as s:
        registrar(
            s, hipotesis="final", estrategia="reglas", parametros={},
            desde="2023-01-01", hasta="2024-01-01", universo=["AAPL"],
            resultado={}, sharpe=0.2, uso_holdout=True,
        )
        h = historial(s)

    assert h["veces_holdout_abierto"] == 1
    assert "dejó de ser fuera de muestra" in h["nota"]


def test_pruebas_casi_identicas_no_desactivan_la_correccion():
    """Si las pruebas registradas salen parecidas, su dispersión tiende a cero
    y el umbral se desvanecería: la corrección se apagaría justo cuando más
    veces has mirado. Ante la duda se deflacta MÁS, nunca menos."""
    retornos = serie(media=0.012, sigma=0.03)
    identicas = [0.43] * 8  # ocho repeticiones de la misma prueba

    r = sharpe_deflactado(retornos, n_pruebas=9, sharpes_probados=identicas)
    assert r["sharpe_umbral"] > 0, "el umbral no puede caer a cero por dispersión nula"

    # Y sigue subiendo si además pruebas mucho más.
    mas = sharpe_deflactado(retornos, n_pruebas=200, sharpes_probados=identicas)
    assert mas["sharpe_umbral"] > r["sharpe_umbral"]

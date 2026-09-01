"""Tests del dimensionador: cuánto comprar, separado de qué comprar."""

from __future__ import annotations

import math
import random
from datetime import date, timedelta

from app.analysis.sizing import (
    MAX_POR_POSICION_PCT,
    MAX_POR_SECTOR_PCT,
    agrupar_por_correlacion,
    con_caida_esperada,
    correlacion,
    dimensionar,
    peor_ventana,
    volatilidad_cartera,
)


def cand(symbol, peso, sector="Tech", vol=20.0):
    return {"symbol": symbol, "sector": sector, "peso_bruto_pct": peso, "vol_anual_pct": vol}


def serie_precios(tasa, vol, dias=800, semilla=1, inicio=date(2021, 1, 1)):
    rng = random.Random(semilla)
    salida, p = [], 100.0
    for t in range(dias):
        p *= math.exp(rng.gauss(tasa, vol))
        salida.append((inicio + timedelta(days=t), p))
    return salida


# --- El problema que este módulo resuelve -----------------------------------


def test_ocho_ideas_al_doce_por_ciento_no_pueden_dar_el_cien_por_cien():
    """El error que producía tener el tamaño dentro de decide(): cada número era
    correcto por separado y el conjunto, insostenible."""
    ideas = [cand(f"S{i}", 12.5, sector=f"Sec{i}") for i in range(8)]
    r = dimensionar(ideas, objetivo_vol_pct=100.0)  # sin escalar por volatilidad
    assert r["invertido_pct"] <= 8 * MAX_POR_POSICION_PCT
    assert all(w <= MAX_POR_POSICION_PCT + 0.01 for w in r["pesos"].values())


def test_ninguna_posicion_pasa_del_tope_diga_lo_que_diga_el_stop():
    r = dimensionar([cand("A", 40.0, sector="X")], objetivo_vol_pct=100.0)
    assert r["pesos"]["A"] == MAX_POR_POSICION_PCT
    assert any("tope por posición" in x for x in r["recortes"])
    assert any("el tamaño no te salva el stop" in x for x in r["recortes"])


def test_el_sector_se_recorta_en_conjunto():
    """Cinco tecnológicas no son cinco apuestas."""
    ideas = [cand(f"T{i}", 9.0, sector="Tech") for i in range(5)]
    r = dimensionar(ideas, objetivo_vol_pct=100.0)
    assert sum(r["pesos"].values()) <= MAX_POR_SECTOR_PCT + 0.01
    assert any("tope por sector" in x for x in r["recortes"])


def test_la_correlacion_agrupa_lo_que_el_sector_no_ve():
    """Dos empresas de sectores distintos con correlación 0,9 son una sola
    posición repartida — y el filtro por sector no lo detecta."""
    rng = random.Random(7)
    base = [rng.gauss(0, 0.02) for _ in range(200)]
    ruido = random.Random(8)
    gemela = [x + ruido.gauss(0, 0.002) for x in base]
    otro = random.Random(9)
    independiente = [otro.gauss(0, 0.02) for _ in range(200)]

    retornos = {"A": base, "B": gemela, "C": independiente}
    ideas = [cand("A", 9.0, "Tech"), cand("B", 9.0, "Salud"), cand("C", 9.0, "Energía")]
    r = dimensionar(ideas, retornos=retornos, objetivo_vol_pct=100.0)

    juntas = [g for g in r["clusters"] if set(g) == {"A", "B"}]
    assert juntas, f"A y B deberían agruparse: {r['clusters']}"


def test_el_enlace_simple_no_parte_clusters_reales():
    """Basta un camino de correlación alta: exigir que TODAS las parejas estén
    correlacionadas daría una falsa sensación de diversificación."""
    corr = {("A", "B"): 0.9, ("B", "C"): 0.9, ("A", "C"): 0.2}
    grupos = agrupar_por_correlacion(["A", "B", "C"], corr)
    assert sorted(grupos[0]) == ["A", "B", "C"]


# --- Volatility targeting ----------------------------------------------------


def test_la_volatilidad_no_es_la_suma_ponderada():
    """Sumar volatilidades ignora que las posiciones no se mueven a la vez, y
    siempre exagera."""
    pesos = {"A": 0.5, "B": 0.5}
    vols = {"A": 0.30, "B": 0.30}  # ya en fracción
    independientes = volatilidad_cartera(pesos, vols, {("A", "B"): 0.0})
    identicas = volatilidad_cartera(pesos, vols, {("A", "B"): 1.0})
    assert independientes < identicas
    assert abs(identicas - 0.30) < 0.001   # correlación 1 = la de una sola
    assert abs(independientes - 0.30 / math.sqrt(2)) < 0.001


def test_se_escala_hacia_abajo_cuando_la_volatilidad_supera_el_objetivo():
    # Cinco posiciones al 10 % con volatilidad del 60 % y correlación 0,5
    # dan una cartera al ~23 %: muy por encima de un objetivo del 10 %.
    ideas = [cand(f"S{i}", 10.0, sector=f"Sec{i}", vol=60.0) for i in range(5)]
    r = dimensionar(ideas, objetivo_vol_pct=10.0)
    assert r["escala_aplicada"] < 1.0
    assert r["vol_estimada_pct"] <= 10.5, r["vol_estimada_pct"]
    assert any("volatilidad estimada" in x for x in r["recortes"])


def test_nunca_se_escala_hacia_arriba_porque_eso_es_apalancarse():
    """Escalar hacia arriba es una decisión que no toma un algoritmo."""
    ideas = [cand("A", 3.0, "X", vol=5.0)]
    r = dimensionar(ideas, objetivo_vol_pct=40.0)
    assert r["escala_aplicada"] == 1.0
    assert r["pesos"]["A"] == 3.0


def test_la_nota_declara_el_supuesto_de_correlacion():
    r = dimensionar([cand("A", 5.0), cand("B", 5.0, "Salud")], objetivo_vol_pct=100.0)
    assert "se asume 0,5" in r["nota"]
    assert "es un supuesto, no un dato" in r["nota"]


# --- Estrés sobre la cartera actual ------------------------------------------


def test_el_peor_escenario_sale_del_historico_real_con_sus_fechas():
    series = {"A": serie_precios(0.0003, 0.02, semilla=1),
              "B": serie_precios(0.0002, 0.03, semilla=2)}
    r = peor_ventana({"A": 50.0, "B": 50.0}, series)
    assert r["suficiente"] is True
    assert r["max_drawdown_pct"] < 0
    assert r["drawdown_desde"] < r["drawdown_hasta"]
    assert r["años_cubiertos"] > 1


def test_avisa_de_las_crisis_que_el_historico_NO_vio():
    """Un «peor caso» sobre cinco años tranquilos no es el peor caso: es el peor
    de lo que dio tiempo a pasar."""
    series = {"A": serie_precios(0.0003, 0.02, dias=800, inicio=date(2021, 1, 1))}
    r = peor_ventana({"A": 100.0}, series)
    assert "NO ha vivido" in r["aviso_cobertura"]
    assert "2008" in r["aviso_cobertura"]
    assert "2020" in r["aviso_cobertura"]


def test_un_historico_largo_no_avisa_de_lo_que_si_vio():
    series = {"A": serie_precios(0.0003, 0.02, dias=2000, inicio=date(2006, 1, 1))}
    r = peor_ventana({"A": 100.0}, series)
    assert "NO ha vivido" not in r["aviso_cobertura"]


# --- Retorno y caída van juntos ----------------------------------------------


def test_toda_proyeccion_de_retorno_lleva_su_caida_al_lado():
    """«+12 % anual» y «+12 % con un −45 % por el camino» son propuestas
    distintas, y quien solo ve la primera abandona en el peor momento."""
    estres = {"suficiente": True, "max_drawdown_pct": -45.0, "peor_ventana_pct": -31.0,
              "aviso_cobertura": "cubre 8 años"}
    r = con_caida_esperada({"retorno_esperado_pct": 12.0}, estres)
    assert r["max_drawdown_esperado_pct"] == -45.0
    assert r["peor_ventana_pct"] == -31.0


def test_sin_historico_no_se_enseña_un_retorno_pelado():
    r = con_caida_esperada({"retorno_esperado_pct": 12.0}, {"suficiente": False})
    assert r["max_drawdown_esperado_pct"] is None
    assert "no se puede interpretar" in r["aviso_cobertura"]

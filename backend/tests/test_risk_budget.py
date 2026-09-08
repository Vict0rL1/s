"""Tests del presupuesto de riesgo: la suma que nadie hacía."""

from __future__ import annotations

from app.analysis.risk_budget import (
    GRUPO_CRIPTO,
    HEAT_MAXIMO_PCT,
    presupuesto_de_riesgo,
    riesgo_de_posicion,
)


def pos(symbol="AAPL", valor=10_000, precio=100.0, stop=90.0, sector="Tech", clase="accion"):
    return {
        "symbol": symbol,
        "market_value": valor,
        "price": precio,
        "stop": stop,
        "sector": sector,
        "asset_class": clase,
    }


def test_el_riesgo_es_la_distancia_al_stop_no_la_posicion_entera():
    """Tener 10.000 € con el stop un 10 % abajo arriesga 1.000, no 10.000."""
    r = riesgo_de_posicion(pos(), total_cartera=100_000)
    assert r["riesgo_pct"] == 1.0
    assert r["peso_pct"] == 10.0


def test_un_stop_ya_perforado_pone_en_riesgo_toda_la_posicion():
    """Decir «te queda un 2 % de riesgo» cuando el stop quedó atrás da un
    falso alivio justo cuando más se necesita mirar."""
    r = riesgo_de_posicion(pos(precio=80.0, stop=90.0), total_cartera=100_000)
    assert r["riesgo_pct"] == 10.0
    assert "posición entera" in r["nota"]


def test_una_posicion_sin_datos_no_cuenta_como_riesgo_cero():
    """Contarla como cero maquillaría justo el total que importa."""
    assert riesgo_de_posicion(pos(stop=None), total_cartera=100_000) is None
    r = presupuesto_de_riesgo([pos(), pos("X", stop=None)], 100_000)
    assert r["sin_calcular"] == 1
    assert any("mayor que el que ves" in a for a in r["avisos"])


# --- La suma, que es el punto -----------------------------------------------


def test_ocho_ideas_al_uno_por_ciento_son_ocho_por_ciento():
    posiciones = [pos(f"S{i}", sector=f"Sec{i}") for i in range(8)]
    r = presupuesto_de_riesgo(posiciones, 100_000)
    assert r["riesgo_total_pct"] == 8.0
    assert any("en riesgo a la vez" in a for a in r["avisos"])


def test_por_debajo_del_tope_no_alarma():
    r = presupuesto_de_riesgo([pos(f"S{i}", sector=f"Sec{i}") for i in range(3)], 100_000)
    assert r["riesgo_total_pct"] == 3.0
    assert r["avisos"] == []
    assert r["margen_pct"] == HEAT_MAXIMO_PCT - 3.0


# --- Lo que se mueve junto no diversifica -----------------------------------


def test_avisa_cuando_un_sector_concentra_el_riesgo():
    """Cinco tecnológicas no son cinco apuestas: caen juntas."""
    r = presupuesto_de_riesgo([pos(f"T{i}", sector="Tech") for i in range(5)], 100_000)
    assert r["por_grupo"]["Tech"] == 5.0
    assert any("una sola apuesta grande" in a for a in r["avisos"])


def test_cripto_se_agrupa_entera_aunque_sean_monedas_distintas():
    """Separarlas por «sector» fingiría una diversificación que no existe."""
    posiciones = [
        pos("BTC-USD", sector="Cripto", clase="cripto"),
        pos("ETH-USD", sector="Otra cosa", clase="cripto"),
        pos("SOL-USD", sector="Y otra", clase="cripto"),
        pos("XRP-USD", sector="Distinta", clase="cripto"),
    ]
    r = presupuesto_de_riesgo(posiciones, 100_000)
    assert list(r["por_grupo"]) == [GRUPO_CRIPTO]
    assert r["por_grupo"][GRUPO_CRIPTO] == 4.0
    assert any(GRUPO_CRIPTO in a for a in r["avisos"])


def test_las_posiciones_se_ordenan_por_riesgo_no_por_tamano():
    """La grande y tranquila importa menos que la pequeña con el stop lejos."""
    grande_tranquila = pos("BIG", valor=50_000, precio=100, stop=98)   # 1 %
    pequena_volatil = pos("VOL", valor=10_000, precio=100, stop=60)    # 4 %
    r = presupuesto_de_riesgo([grande_tranquila, pequena_volatil], 100_000)
    assert [p["symbol"] for p in r["posiciones"]] == ["VOL", "BIG"]


def test_la_nota_no_vende_los_topes_como_un_hallazgo_de_la_app():
    r = presupuesto_de_riesgo([pos()], 100_000)
    assert "convención" in r["nota"]
    assert "no un resultado medido" in r["nota"]


def test_sin_valor_de_cartera_no_se_inventa_un_porcentaje():
    assert presupuesto_de_riesgo([pos()], None)["riesgo_total_pct"] == 0.0

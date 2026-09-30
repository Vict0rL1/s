"""Tests de la recomendación de ETFs: otro activo, otros criterios."""

from __future__ import annotations

from app.analysis.etf_picks import (
    avisos_de_solapamiento,
    evaluar_etf,
    recomendar,
)


def etf(symbol="VOO", expense_ratio=0.0003, aum=5e11, name="Vanguard S&P 500"):
    return {"symbol": symbol, "name": name, "expense_ratio": expense_ratio, "aum": aum}


def precio(above=True):
    return {"last": 100.0, "sma200": 90.0, "above_sma200": above}


def test_el_coste_manda_porque_es_lo_unico_garantizado():
    """La tendencia puede girarse mañana; el gasto corriente lo pagas seguro."""
    barato = evaluar_etf(etf(expense_ratio=0.0003), precio())
    caro = evaluar_etf(etf("ARKK", expense_ratio=0.0075), precio())
    assert barato["valor"] > caro["valor"]
    assert caro["action"] == "evitar"


def test_el_coste_se_explica_en_dinero_no_en_porcentaje_abstracto():
    """«0,75 %» no significa nada; «75 € al año por cada 10.000» sí."""
    r = evaluar_etf(etf(expense_ratio=0.0075), precio())
    assert any("€ al año por cada 10.000" in x for x in r["reasons"])


def test_un_etf_diminuto_se_evita_aunque_sea_barato():
    """Si liquidan el fondo te devuelven el dinero cuando les conviene, y si
    estabas en pérdidas las realizas sin elegirlo."""
    r = evaluar_etf(etf("TINY", expense_ratio=0.0003, aum=20e6), precio())
    assert r["action"] == "evitar"
    assert any("riesgo real de liquidación" in x for x in r["reasons"])


def test_barato_y_grande_pero_en_tendencia_bajista_se_vigila():
    r = evaluar_etf(etf(), precio(above=False))
    assert r["action"] == "vigilar"


def test_barato_grande_y_en_tendencia_se_compra():
    assert evaluar_etf(etf(), precio())["action"] == "comprar"


def test_sin_dato_de_coste_no_se_asume_que_es_barato():
    r = evaluar_etf(etf(expense_ratio=None), precio())
    assert any("Sin dato de coste" in x for x in r["reasons"])
    assert r["action"] != "comprar"


# --- El error caro al montar una cartera de ETFs ----------------------------


def test_avisa_cuando_dos_recomendados_son_el_mismo_fondo_con_otro_nombre():
    """Se compran tres fondos creyendo que se diversifica y los tres llevan
    dentro las mismas diez empresas."""
    evaluados = [
        {"symbol": "VOO", "action": "comprar"},
        {"symbol": "SPY", "action": "comprar"},
    ]
    avisos = avisos_de_solapamiento(
        evaluados, [{"a": "VOO", "b": "SPY", "overlap_weight": 0.98}]
    )
    assert len(avisos) == 1
    assert "no diversifica, concentra" in avisos[0]


def test_no_avisa_de_solapamiento_entre_cosas_que_no_recomienda():
    evaluados = [{"symbol": "VOO", "action": "comprar"}, {"symbol": "SPY", "action": "evitar"}]
    assert avisos_de_solapamiento(
        evaluados, [{"a": "VOO", "b": "SPY", "overlap_weight": 0.98}]
    ) == []


def test_un_solapamiento_bajo_no_es_un_problema():
    evaluados = [{"symbol": "VOO", "action": "comprar"}, {"symbol": "VXUS", "action": "comprar"}]
    assert avisos_de_solapamiento(
        evaluados, [{"a": "VOO", "b": "VXUS", "overlap_weight": 0.03}]
    ) == []


# --- Honestidad --------------------------------------------------------------


def test_no_pretende_predecir_que_sector_ira_mejor():
    r = recomendar([etf()], {"VOO": precio()}, [])
    assert "NO predice qué sector" in r["nota"]
    assert "esa decisión es tuya" in r["nota"]


def test_ordena_de_mejor_a_peor_y_nombra_a_los_recomendados():
    r = recomendar(
        [etf("ARKK", 0.0075, 6e9), etf("VOO", 0.0003, 5e11)],
        {"ARKK": precio(), "VOO": precio()},
        [],
    )
    assert [e["symbol"] for e in r["evaluados"]] == ["VOO", "ARKK"]
    assert r["recomendados"] == ["VOO"]

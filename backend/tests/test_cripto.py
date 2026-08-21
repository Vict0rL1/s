"""Tests del mercado de cripto.

El riesgo aquí no es que falle, es que engañe. Sin estados financieros no hay
valor ni calidad que medir, así que la puntuación sale de momentum y nada más.
Una app que presente eso con la misma confianza que una acción con cuatro
factores está mintiendo por omisión, y estos tests existen para impedirlo.
"""

from __future__ import annotations

from app.analysis.decision import TOPES_STOP, _stop_pct, decide
from app.analysis.markets import MARKETS, load_market
from app.analysis.shortlist import conviccion


def test_el_universo_carga_y_usa_tickers_que_el_proveedor_entiende():
    m = load_market("cripto")
    assert 10 <= len(m["companies"]) <= 40
    for c in m["companies"]:
        # yfinance cotiza cripto como BTC-USD; sin el sufijo no devuelve nada.
        assert c["symbol"].endswith("-USD"), c
        assert c["name"]


def test_el_mercado_avisa_de_que_solo_hay_momentum():
    """Es la limitación estructural del activo, no una nota al pie."""
    meta = MARKETS["cripto"]
    assert meta["solo_momentum"] is True
    d = meta["description"].lower()
    assert "momentum y nada más" in d
    assert "no hay factor de valor" in d or "no hay estados financieros" in d


def test_cripto_se_declara_como_su_propia_clase_de_activo():
    assert MARKETS["cripto"]["asset_class"] == "cripto"
    # Y las acciones no heredan sus topes por accidente.
    assert MARKETS["us_sp500"].get("asset_class", "accion") == "accion"


# --- El stop, que es donde esto se rompía en silencio ------------------------


def test_el_stop_de_cripto_no_se_pega_al_tope_de_las_acciones():
    """Con el rango de acciones, BTC (27 %), ETH (37 %) y una altcoin (60 %)
    daban TODAS 25 %: el stop dejaba de dimensionarse por volatilidad y pasaba
    a ser una constante que el ruido normal perfora una y otra vez."""
    btc, eth, alt = 3.0, 4.0, 6.5
    stops = [_stop_pct(v, "cripto") for v in (btc, eth, alt)]
    assert len(set(stops)) == 3, "deben diferenciarse entre sí"
    assert stops[0] < stops[1] < stops[2]
    # Y ninguno cabe en el rango de una acción, que es justo el problema.
    assert all(s > TOPES_STOP["accion"][1] for s in stops[1:])


def test_un_stop_mas_ancho_obliga_a_una_posicion_mas_pequena():
    """El riesgo por idea sigue siendo el mismo 1 %; lo que cambia es cuánto
    dinero hace falta para asumirlo."""
    precio = {"last": 100.0, "sma200": 80.0, "above_sma200": True, "daily_vol_pct": 6.5}
    cripto = decide({"symbol": "X", "score": 0.9}, precio, clase="cripto")["levels"]
    accion = decide({"symbol": "Y", "score": 0.9}, precio, clase="accion")["levels"]
    assert cripto["stop_pct"] > accion["stop_pct"]
    assert cripto["peso_sugerido_pct"] < accion["peso_sugerido_pct"]
    # El riesgo efectivo es idéntico en ambos casos.
    for n in (cripto, accion):
        assert abs(n["peso_sugerido_pct"] / 100 * n["stop_pct"] / 100 - 0.01) < 0.0006


def test_sin_volatilidad_medible_no_se_hereda_el_valor_de_las_acciones():
    medio = _stop_pct(None, "cripto")
    minimo, maximo = TOPES_STOP["cripto"]
    assert minimo < medio < maximo


# --- La convicción castiga sola a un activo de un solo factor ---------------


def test_una_idea_de_solo_momentum_puntua_por_debajo_de_una_contrastada():
    """No hace falta una regla especial para cripto: el motor de convicción ya
    penaliza que una idea la sostenga un único factor, y eso es exactamente lo
    que le pasa a un activo sin estados financieros."""
    base = {"context": {"sector_name": "X"}, "decision": {"action": "comprar", "levels": {"stop_pct": 20.0}}}
    solo_momentum = conviccion({**base, "symbol": "BTC-USD", "score": 0.9,
                                "families": {"momentum": 0.9}})
    tres_factores = conviccion({**base, "symbol": "AAPL", "score": 0.9,
                                "families": {"value": 0.6, "quality": 0.7, "momentum": 0.9}})
    assert solo_momentum["valor"] < tres_factores["valor"]
    assert solo_momentum["acuerdo"] < tres_factores["acuerdo"]

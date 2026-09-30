"""Solapamiento de ETFs: «no se pudo leer» no es «no se solapan».

De la auditoría de RC1. Si yfinance no devolvía la composición de un ETF —cosa
que pasa— la lista de holdings llegaba vacía, `overlap_weight([], ...)` daba
0 %, y dos ETFs que son el mismo índice (SPY y VOO) pasaban como diversificados
sin un solo aviso. El error más caro al montar una cartera de ETFs quedaba
tapado justo cuando menos se sabía.
"""

from __future__ import annotations

from app.analysis.etf import overlap_weight
from app.analysis.etf_picks import avisos_de_solapamiento

SPY = [{"symbol": "AAPL", "weight": 0.07}, {"symbol": "MSFT", "weight": 0.065}]


def test_sin_composicion_el_solapamiento_es_desconocido_no_cero():
    r = overlap_weight([], SPY)
    assert r["overlap_weight"] is None
    assert r["desconocido"] is True
    assert "no se" in r["motivo"].lower()


def test_con_composicion_de_ambos_se_calcula_como_siempre():
    r = overlap_weight(SPY, SPY)
    assert r["overlap_weight"] > 0.13
    assert r["desconocido"] is False


def test_un_peso_ausente_no_cuenta_como_cero_silencioso():
    """Un holding compartido sin peso sigue siendo compartido: se avisa."""
    a = [{"symbol": "AAPL", "weight": None}]
    b = [{"symbol": "AAPL", "weight": 0.07}]
    r = overlap_weight(a, b)
    assert r["shared_count"] == 1
    assert r["pesos_desconocidos"] == ["AAPL"]


def test_dos_elegidos_con_solapamiento_desconocido_generan_aviso():
    evaluados = [
        {"symbol": "SPY", "action": "comprar"},
        {"symbol": "VOO", "action": "comprar"},
    ]
    avisos = avisos_de_solapamiento(
        evaluados, [{"a": "SPY", "b": "VOO", "overlap_weight": None, "desconocido": True}]
    )
    assert avisos, "comprar dos ETFs sin poder comprobar su solapamiento no puede callarse"
    assert "no se ha podido comprobar" in avisos[0].lower()


def test_solapamiento_bajo_conocido_sigue_sin_aviso():
    evaluados = [
        {"symbol": "VOO", "action": "comprar"},
        {"symbol": "VXUS", "action": "comprar"},
    ]
    assert avisos_de_solapamiento(
        evaluados, [{"a": "VOO", "b": "VXUS", "overlap_weight": 0.03, "desconocido": False}]
    ) == []

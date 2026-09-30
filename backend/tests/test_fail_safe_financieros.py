"""Los estados financieros de EDGAR también pasan por la frontera.

`financials` alimenta el DCF, la salud financiera, los disparadores de tesis y
la puntuación de la lista diaria, y era el único tipo de dato importante sin
validador. Lo que puede llegar mal:

- un `NaN` o un infinito en cualquier partida, que atraviesa las fórmulas;
- un signo imposible en una partida que no puede ser negativa. El caso caro es
  el capex: llega como pago POSITIVO, así que un capex negativo —un error de
  signo— hace que `FCF = cfo − capex` SUME en vez de restar e infle la
  valoración;
- acciones en circulación ≤ 0, que dan un valor por acción infinito o negativo.

La regla es la de siempre: lo que no puede ser verdad se deja en None (se sabe
que falta) y se cuenta; no se corrige adivinando el signo.
"""

from __future__ import annotations

import pytest

from app.analysis.fundamentals import free_cash_flow
from app.validacion import PayloadInvalido, validar


def _periodo(**cambios):
    base = {
        "fiscal_year": 2025, "end_date": "2025-12-31", "revenue": 5e9,
        "net_income": 8e8, "operating_income": 1.2e9, "cfo": 1.4e9, "capex": 4e8,
        "equity": 4e9, "total_assets": 9e9, "cash": 1e9, "long_term_debt": 2e9,
        "short_term_debt": 5e8, "shares_outstanding": 1e8, "eps_diluted": 8.0,
    }
    return {**base, **cambios}


def _validar(*periodos):
    return validar("financials", {"symbol": "X", "periods": list(periodos)})


def test_un_periodo_limpio_pasa_intacto():
    r = _validar(_periodo())
    assert r["periods"][0] == _periodo()
    assert "partidas_descartadas" not in r


@pytest.mark.parametrize("malo", [float("nan"), float("inf"), float("-inf"), "n/d"])
def test_un_valor_no_finito_se_queda_en_none(malo):
    r = _validar(_periodo(revenue=malo))
    assert r["periods"][0]["revenue"] is None
    assert r["partidas_descartadas"] == 1


def test_un_capex_negativo_no_infla_el_flujo_libre():
    """El caso caro: con signo cambiado, FCF = cfo − (−capex) = cfo + capex."""
    r = _validar(_periodo(capex=-4e8))
    assert r["periods"][0]["capex"] is None
    assert free_cash_flow(r["periods"][0]) is None  # desconocido, no inflado


@pytest.mark.parametrize("campo", ["revenue", "total_assets", "cash", "long_term_debt",
                                   "short_term_debt", "capex"])
def test_las_partidas_que_no_pueden_ser_negativas(campo):
    r = _validar(_periodo(**{campo: -1.0}))
    assert r["periods"][0][campo] is None


@pytest.mark.parametrize("acciones", [0, -1e8])
def test_acciones_no_positivas_se_descartan(acciones):
    r = _validar(_periodo(shares_outstanding=acciones))
    assert r["periods"][0]["shares_outstanding"] is None


@pytest.mark.parametrize("campo", ["net_income", "operating_income", "cfo", "equity",
                                   "eps_diluted"])
def test_las_que_pueden_ser_negativas_se_respetan(campo):
    """Una empresa con pérdidas o patrimonio negativo es un dato, no un error."""
    r = _validar(_periodo(**{campo: -5.0}))
    assert r["periods"][0][campo] == -5.0


def test_un_capex_de_cero_es_un_dato():
    assert _validar(_periodo(capex=0.0))["periods"][0]["capex"] == 0.0


def test_un_periodo_sin_ejercicio_se_tira():
    r = _validar(_periodo(), {**_periodo(), "fiscal_year": None})
    assert len(r["periods"]) == 1


def test_sin_ningun_periodo_utilizable_se_rechaza():
    with pytest.raises(PayloadInvalido):
        _validar({"fiscal_year": None})
    with pytest.raises(PayloadInvalido):
        validar("financials", {"symbol": "X", "periods": []})


def test_la_fecha_de_publicacion_sobrevive_al_saneado():
    """`filed_at` es lo que impide mirar al futuro en los backtests: los
    fundamentales solo cuentan desde que se publicaron. Si el saneado la
    convirtiera en None, el control point-in-time se quedaría sin fecha."""
    r = _validar(_periodo(filed_at="2026-02-14"))
    assert r["periods"][0]["filed_at"] == "2026-02-14"
    assert r["periods"][0]["end_date"] == "2025-12-31"
    assert r["periods"][0]["fiscal_year"] == 2025

"""Los saneadores y el estado del dato.

Estos tests son cortos y aburridos y son los más importantes del repositorio.
Todos los fallos abiertos que destapó la auditoría empiezan aquí: un `NaN` que
pasa una guarda escrita como `if not x`, un cero que se cuela donde iba un
precio, un `True` que vale 1.0. Si este módulo falla, falla en silencio en
todos los demás.
"""

from __future__ import annotations

import math

import pytest

from app.datos import (
    Dato,
    Estado,
    faltantes,
    indeterminado,
    numero,
    porcentaje,
    precio,
    todos_finitos,
)

NAN = float("nan")
INF = float("inf")


# --- numero(): lo que para en seco ---------------------------------------


@pytest.mark.parametrize("valor", [None, NAN, INF, -INF, "hola", "", [], {}, object()])
def test_numero_rechaza_lo_que_no_es_un_numero_utilizable(valor):
    assert numero(valor) is None


@pytest.mark.parametrize("valor,esperado", [(0, 0.0), (-3.5, -3.5), ("2.5", 2.5), (7, 7.0)])
def test_numero_acepta_lo_que_si_lo_es(valor, esperado):
    assert numero(valor) == esperado


def test_nan_es_truthy_y_por_eso_hace_falta_esto():
    """La razón de existir del módulo, escrita como test.

    `if not nan` es False: un NaN pasa entero cualquier guarda escrita así, que
    es como estaban escritas las del motor de decisión.
    """
    assert bool(NAN) is True
    assert not (NAN > 0) and not (NAN < 0) and not (NAN == 0)
    assert numero(NAN) is None


def test_los_booleanos_no_son_numeros():
    """`True` vale 1.0 en Python: colado donde va un precio, es un dólar."""
    assert numero(True) is None
    assert numero(False) is None


# --- precio(): finito y positivo -----------------------------------------


@pytest.mark.parametrize("valor", [0, 0.0, -1, -0.01, NAN, INF, None, "x"])
def test_precio_rechaza_lo_que_no_puede_cotizar(valor):
    assert precio(valor) is None


def test_precio_acepta_un_precio_normal():
    assert precio(150.25) == 150.25
    assert precio("99.5") == 99.5


# --- porcentaje() ---------------------------------------------------------


def test_porcentaje_rechaza_negativos_y_disparates():
    assert porcentaje(-5) is None
    assert porcentaje(40_000) is None  # error de unidades, no un dato
    assert porcentaje(NAN) is None


def test_porcentaje_acepta_cero():
    """Cero es un porcentaje legítimo: una empresa puede no crecer."""
    assert porcentaje(0) == 0.0


# --- todos_finitos() ------------------------------------------------------


def test_todos_finitos():
    assert todos_finitos(1, 2.5, "3")
    assert not todos_finitos(1, NAN)
    assert not todos_finitos(1, None)


# --- Dato -----------------------------------------------------------------


def test_un_dato_valido_lleva_fuente_y_fecha():
    d = Dato.valido(150.0, fuente="finnhub", fecha="2026-09-29T10:00:00+00:00")
    assert d.es_fiable and d.hay_valor
    assert d.a_json()["fuente"] == "finnhub"


def test_desconocido_no_tiene_valor_y_explica_por_que():
    d = Dato.desconocido("la API no respondió")
    assert not d.hay_valor and not d.es_fiable
    assert d.estado is Estado.DESCONOCIDO
    assert "no respondió" in d.motivo


def test_viejo_si_tiene_valor_pero_no_es_fiable():
    """Viejo no es ausente: un precio de hace diez minutos sirve, diciéndolo."""
    d = Dato.viejo(150.0, "de hace 3 horas", fecha="2026-09-29T07:00:00+00:00")
    assert d.hay_valor           # se puede operar con él
    assert not d.es_fiable       # pero no callándoselo


def test_error_se_distingue_de_desconocido():
    """DESCONOCIDO se reintenta; ERROR se investiga. No son el mismo caso."""
    assert Dato.error("vino un NaN").estado is Estado.ERROR
    assert Dato.desconocido("sin respuesta").estado is Estado.DESCONOCIDO


def test_el_valor_por_defecto_exige_un_motivo_escrito():
    """La guarda contra el `or 0` involuntario.

    Todos los fallos de esta familia empezaron con un defecto que nadie escribió
    a conciencia. Tener que redactar el porqué obliga a mirar si el defecto es
    de verdad neutro — y en una cartera casi nunca lo es.
    """
    d = Dato.desconocido("sin dato")
    assert d.o(0.0, porque="aquí cero sí es neutro") == 0.0
    with pytest.raises(ValueError):
        d.o(0.0, porque="")


def test_un_dato_valido_devuelve_su_valor_no_el_defecto():
    assert Dato.valido(42.0).o(0.0, porque="da igual") == 42.0


# --- faltantes() e indeterminado() ----------------------------------------


def test_faltantes_nombra_lo_que_falta():
    faltan = faltantes({"precio": 100.0, "stop": None, "vol": NAN, "score": 0.5})
    assert faltan == ["stop", "vol"]  # NaN cuenta como ausente


def test_faltantes_no_confunde_cero_con_ausente():
    """Cero es un dato. Un crecimiento del 0 % es información, no un hueco."""
    assert faltantes({"crecimiento": 0.0}) == []


def test_indeterminado_dice_que_no_es_una_recomendacion_neutra():
    r = indeterminado(["precio"], "sobre AAPL")
    assert r["indeterminado"] is True
    assert r["faltan"] == ["precio"]
    assert "no es una recomendación neutra" in r["motivo"].lower()
    assert "AAPL" in r["motivo"]


def test_indeterminado_sin_lista_sigue_siendo_legible():
    assert "datos obligatorios" in indeterminado([])["motivo"]


def test_math_isfinite_es_la_comprobacion_correcta():
    """Documenta por qué no basta con `is not None`."""
    for malo in (NAN, INF, -INF):
        assert malo is not None          # pasa la guarda ingenua
        assert not math.isfinite(malo)   # y no debería
        assert numero(malo) is None

"""El motor de decisión ante datos corruptos: tiene que decir «no sé».

Estos tests salieron de la auditoría de RC1, y todos fallaban al escribirlos.
La guarda del motor era `if price is None or not price.get("last")`, y ni `NaN`
ni un precio negativo la cruzan: `NaN` es *truthy* y `-50.0` también. El
resultado era una recomendación de COMPRAR con un stop `NaN` —o negativo— y,
peor, con un `peso_bruto_pct` perfectamente numérico que viajaba entero al
dimensionador. Una cotización corrupta producía una orden de compra
dimensionada.

La regla que comprueban: **ante un dato que no se puede usar, la respuesta es
`sin_datos`, nunca una acción**. Y `sin_datos` tiene que decir qué falta.
"""

from __future__ import annotations

import pytest

from app.analysis import decision

NAN = float("nan")
INF = float("inf")

SENAL = {"score": 0.5}
PRECIO_OK = {"last": 100.0, "daily_vol_pct": 2.0, "above_sma200": True}


def _precio(**cambios):
    return {**PRECIO_OK, **cambios}


# --- P0-1 y P0-2: precios que no pueden usarse ---------------------------


@pytest.mark.parametrize(
    "malo,etiqueta",
    [
        (NAN, "NaN"),
        (INF, "infinito"),
        (-INF, "-infinito"),
        (-50.0, "negativo"),
        (0.0, "cero"),
        ("ciento", "texto"),
    ],
)
def test_un_precio_inutilizable_no_produce_una_accion(malo, etiqueta):
    d = decision.decide(SENAL, _precio(last=malo))
    assert d["action"] == "sin_datos", f"un precio {etiqueta} produjo «{d['action']}»"
    assert d["levels"] is None
    assert d["confidence"] == "ninguna"


def test_un_precio_nan_no_deja_escapar_un_peso_al_dimensionador():
    """El detalle que convertía el fallo en una compra real.

    `peso_bruto_pct` se calcula solo desde `stop_pct`, así que salía numérico
    (5,5 %) aunque el precio fuera NaN, y `sizing` lo aceptaba como bueno.
    """
    d = decision.decide(SENAL, _precio(last=NAN))
    assert d["levels"] is None


def test_el_motivo_dice_cual_es_el_dato_que_falla():
    d = decision.decide(SENAL, _precio(last=NAN))
    texto = " ".join(d["reasons"]).lower()
    assert "precio" in texto


def test_un_precio_valido_sigue_funcionando():
    """La guarda no puede volverse tan estricta que apague el motor."""
    d = decision.decide(SENAL, _precio(last=100.0))
    assert d["action"] != "sin_datos"
    assert d["levels"]["stop"] > 0


# --- La puntuación también puede venir corrupta --------------------------


def test_una_puntuacion_nan_no_es_una_puntuacion_neutra():
    """Antes caía en «ninguna» con el texto «ni destaca ni preocupa».

    Eso es una afirmación sobre la empresa, y no se sabe nada sobre la empresa.
    """
    d = decision.decide({"score": NAN}, _precio())
    assert d["action"] == "sin_datos"
    assert "ni destaca ni preocupa" not in " ".join(d["reasons"])


def test_sin_puntuacion_sigue_siendo_sin_datos():
    assert decision.decide({}, _precio())["action"] == "sin_datos"


# --- Datos opcionales corruptos: degradar, no romper ---------------------


def test_una_volatilidad_nan_no_impide_decidir_pero_ensancha_el_stop():
    """La volatilidad es opcional: sin ella el stop va al medio del rango.

    Lo que NO puede pasar es que un NaN se cuele hasta el stop.
    """
    d = decision.decide(SENAL, _precio(daily_vol_pct=NAN))
    assert d["action"] != "sin_datos"
    stop = d["levels"]["stop"]
    assert stop > 0 and stop == stop  # ni negativo ni NaN
    assert d["levels"]["stop_pct"] == decision._stop_pct(None)


def test_una_sma200_nan_no_se_lee_como_tendencia_favorable():
    """Con SMA corrupta no se puede afirmar que está sobre su media.

    `100 > NaN` es False, así que el bug no era una compra — pero la razón
    escrita sí mentía sobre lo que se sabía.
    """
    d = decision.decide(SENAL, _precio(sma200=NAN, above_sma200=True))
    assert d["action"] in ("vigilar", "ninguna", "sin_datos")


# --- Y sobre una posición abierta ----------------------------------------


def test_un_coste_corrupto_no_produce_un_stop_de_posicion_absurdo():
    d = decision.decide(SENAL, _precio(), position={"cost_basis": NAN, "quantity": 10})
    if d["levels"] is not None:
        assert d["levels"]["stop"] is None or d["levels"]["stop"] > 0


def test_una_posicion_con_precio_corrupto_no_dice_vender_ni_mantener():
    """Sobre lo que ya tienes, inventar un veredicto es peor todavía.

    «Mantener» sobre una posición cuyo precio no se pudo leer es una
    recomendación de no hacer nada tomada sin mirar.
    """
    d = decision.decide(SENAL, _precio(last=NAN), position={"cost_basis": 90.0, "quantity": 10})
    assert d["action"] == "sin_datos"
    assert d["owned"] is True


# --- El stop se fija al abrir, no se recalcula con la volatilidad de hoy ---
#
# Encontrado por el test de extremo a extremo del RC1. El stop de una posición
# se recalculaba cada día con la volatilidad ACTUAL. En una caída la volatilidad
# se dispara, el stop se aleja solo hasta el tope del 25 %, y un precio que ya
# había perforado el stop del día de compra seguía «por encima del stop». El
# control de riesgo tenía un camino que lo evitaba: su propio recálculo.


def test_un_stop_fijado_al_abrir_no_se_aleja_con_la_volatilidad():
    pos = {"cost_basis": 150.0, "quantity": 10, "stop": 136.2}
    d = decision.decide(
        SENAL, {"last": 120.0, "daily_vol_pct": 6.0, "sma200": 160.0, "above_sma200": False},
        position=pos,
    )
    assert d["action"] == "vender"
    assert d["levels"]["stop"] == 136.2
    assert d["levels"]["stop_fijado_al_abrir"] is True


def test_sin_stop_guardado_se_recalcula_y_se_dice():
    """Posiciones antiguas, anteriores al stop fijado: se recalcula, avisando."""
    d = decision.decide(SENAL, _precio(), position={"cost_basis": 90.0, "quantity": 10})
    assert d["levels"]["stop_fijado_al_abrir"] is False
    assert any("recalcula" in r.lower() for r in d["reasons"])


def test_un_stop_guardado_corrupto_no_se_usa():
    d = decision.decide(SENAL, _precio(), position={"cost_basis": 90.0, "quantity": 10,
                                                     "stop": float("nan")})
    assert d["levels"]["stop"] == d["levels"]["stop"]  # no NaN
    assert d["levels"]["stop_fijado_al_abrir"] is False


# --- Un precio VIEJO no es un precio inválido, pero no basta para comprar ---
#
# Cuando todas las fuentes fallan, la caché sirve la última copia marcada
# `estado: viejo`. Sobre eso se puede opinar —la tendencia y la puntuación no
# cambian en veinte minutos— pero no fijar una zona de compra: el ±2 % se
# mediría contra un precio que quizá ya no existe.


def test_no_se_recomienda_comprar_sobre_un_precio_viejo():
    d = decision.decide(SENAL, _precio(estado="viejo", antiguedad_segundos=1800))
    assert d["action"] != "comprar"
    assert d["action"] == "vigilar"
    assert any("viejo" in r.lower() for r in d["reasons"])


def test_sobre_lo_que_tienes_un_precio_viejo_no_calla_un_stop_perforado():
    """Al revés que comprar: avisar de un riesgo con un dato viejo es prudente."""
    d = decision.decide(
        SENAL, _precio(last=80.0, estado="viejo", antiguedad_segundos=1800),
        position={"cost_basis": 100.0, "quantity": 10, "stop": 90.0},
    )
    assert d["action"] == "vender"
    assert any("viejo" in r.lower() for r in d["reasons"])


def test_un_precio_valido_sigue_permitiendo_comprar():
    d = decision.decide(SENAL, _precio(last=100.0, sma200=90.0, estado="valido"))
    assert d["action"] == "comprar"

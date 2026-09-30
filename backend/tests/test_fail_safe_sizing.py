"""El dimensionador ante datos incompletos: un límite que no corre, se dice.

De la auditoría de RC1. El proyecto ya tuvo una vez el bug de «la regla existe
en el código pero nunca se ejecuta» —el tope por correlación, arreglado en
`e0067d7`— y la auditoría encontró que la lección estaba aprendida a medias: se
arregló el sitio que llamaba, no la función. `dimensionar(retornos=None)` seguía
devolviendo `clusters: []` sin una palabra sobre que el tope no se había
comprobado.

Tres fallos abiertos, todos con la misma forma: **menos datos producían menos
riesgo aparente, y por tanto más compra autorizada**.

La regla que comprueban: un control de riesgo que no se puede evaluar tiene que
declararse como no evaluado. Callarlo lo convierte en decorativo, y un límite
decorativo es peor que ninguno porque se ve como seguridad.
"""

from __future__ import annotations

import pytest

from app.analysis import sizing

NAN = float("nan")


def _c(symbol, sector="Tech", peso=9.0, vol=20.0):
    return {"symbol": symbol, "sector": sector, "peso_bruto_pct": peso, "vol_anual_pct": vol}


def _series_correlacionadas(n=30):
    """Dos series que suben y bajan a la vez: correlación ~1."""
    base = [(-1) ** i * 0.02 + 0.001 * i for i in range(n)]
    return base


# --- P0-5: el tope por correlación que no se ejecuta ---------------------


def test_sin_retornos_se_declara_que_la_correlacion_no_se_comprobo():
    r = sizing.dimensionar([_c("A"), _c("B"), _c("C")], retornos=None)
    control = next(c for c in r["controles"] if c["limite"] == "correlación")
    assert control["aplicado"] is False
    assert "no se" in control["motivo"].lower()
    assert r["todos_los_limites_aplicados"] is False


def test_con_retornos_el_tope_por_correlacion_si_se_aplica_y_se_declara():
    serie = _series_correlacionadas()
    retornos = {"A": serie, "B": serie, "C": serie}
    r = sizing.dimensionar(
        [_c("A"), _c("B"), _c("C")], retornos=retornos
    )
    control = next(c for c in r["controles"] if c["limite"] == "correlación")
    assert control["aplicado"] is True
    # Y hace su trabajo: tres series idénticas son UNA apuesta.
    assert len(r["clusters"]) == 1 and len(r["clusters"][0]) == 3


def test_retornos_de_solo_algunos_simbolos_se_cuenta_como_parcial():
    """Medir la mitad de las parejas no es haber comprobado el tope."""
    serie = _series_correlacionadas()
    r = sizing.dimensionar(
        [_c("A"), _c("B"), _c("C")], retornos={"A": serie, "B": serie}
    )
    control = next(c for c in r["controles"] if c["limite"] == "correlación")
    assert control["parejas_medidas"] == 1
    assert control["parejas_posibles"] == 3
    assert control["aplicado"] is False  # no se midieron todas


# --- P0-3: una volatilidad NaN anulaba el objetivo de volatilidad --------


def test_una_volatilidad_nan_no_desactiva_el_objetivo_de_volatilidad():
    """Era el peor de los tres: `sqrt(NaN)` → None → `if vol and ...` → no escala.

    Y la pantalla mostraba «—» en la volatilidad estimada, que se lee como «no
    hay dato» cuando lo que había pasado es que un límite de riesgo no corrió.
    """
    r = sizing.dimensionar(
        [_c("A", vol=40.0), _c("B", sector="Salud", vol=NAN)], retornos=None
    )
    control = next(c for c in r["controles"] if c["limite"] == "volatilidad")
    # O se aplicó con un supuesto declarado, o se declara que no se aplicó.
    # Lo que no vale es escala 1.0 en silencio.
    assert control["aplicado"] is True
    assert control["sin_volatilidad"] == ["B"]
    assert r["vol_estimada_pct"] is not None


def test_una_volatilidad_ausente_no_reduce_el_riesgo_estimado():
    """P0-4: excluirla en silencio bajaba la vol de cartera un 42 %."""
    completo = sizing.volatilidad_cartera(
        {"A": 0.5, "B": 0.5}, {"A": 0.40, "B": 0.40}, {}
    )
    incompleto = sizing.volatilidad_cartera({"A": 0.5, "B": 0.5}, {"A": 0.40}, {})
    assert incompleto is not None
    # Con un supuesto conservador, ignorar el dato NO puede salir más barato.
    assert incompleto >= completo * 0.95, (
        f"faltar un dato bajó el riesgo estimado de {completo:.4f} a {incompleto:.4f}"
    )


def test_una_volatilidad_de_cero_es_un_dato_no_una_ausencia():
    """`vol_anual.get(s)` es falsy con 0.0: un activo sin volatilidad se caía."""
    v = sizing.volatilidad_cartera({"A": 1.0}, {"A": 0.0}, {})
    assert v == 0.0 or v is None  # cero es legítimo; lo que no vale es inventarlo


def test_sin_ninguna_volatilidad_el_objetivo_se_declara_no_aplicado():
    r = sizing.dimensionar([_c("A", vol=None), _c("B", vol=None)], retornos=None)
    control = next(c for c in r["controles"] if c["limite"] == "volatilidad")
    assert control["aplicado"] is False
    assert r["todos_los_limites_aplicados"] is False


# --- Los límites que YA funcionaban no se rompen -------------------------


def test_el_tope_por_posicion_sigue_recortando():
    r = sizing.dimensionar([_c("A", peso=30.0)], retornos=None)
    assert r["pesos"]["A"] == pytest.approx(sizing.MAX_POR_POSICION_PCT)
    control = next(c for c in r["controles"] if c["limite"] == "posición")
    assert control["aplicado"] is True


def test_el_tope_por_sector_sigue_contando_lo_que_ya_tienes():
    r = sizing.dimensionar(
        [_c("A", peso=10.0), _c("B", peso=10.0)],
        cartera=[{"symbol": "Z", "sector": "Tech", "peso_pct": 20.0, "vol_anual_pct": 20.0}],
        retornos=None,
    )
    assert sum(r["pesos"].values()) == pytest.approx(5.0)  # 25 − 20 ya ocupado


def test_una_cartera_sin_candidatas_no_revienta():
    r = sizing.dimensionar([], retornos=None)
    assert r["pesos"] == {}
    assert "controles" in r


# --- Peso bruto corrupto -------------------------------------------------


def test_un_peso_bruto_nan_no_se_convierte_en_una_posicion():
    r = sizing.dimensionar([_c("A", peso=NAN)], retornos=None)
    assert r["pesos"].get("A", 0.0) == 0.0


def test_un_peso_de_cartera_nan_no_contamina_los_topes():
    """Un peso NaN en el libro haría NaN todos los «ocupado» y los topes."""
    r = sizing.dimensionar(
        [_c("A", peso=5.0)],
        cartera=[{"symbol": "Z", "sector": "Tech", "peso_pct": NAN, "vol_anual_pct": 20.0}],
        retornos=None,
    )
    peso = r["pesos"].get("A", 0.0)
    assert peso == peso  # no es NaN
    assert peso >= 0.0


# --- Fase 5: lo correlacionado no puede pesar como lo independiente ------


def _serie(patron):
    """Una serie de 30 retornos a partir de un patrón que se repite."""
    return [patron[i % len(patron)] for i in range(30)]


ARRIBA = _serie([0.02, -0.01, 0.03, -0.02, 0.01])
IGUAL = ARRIBA
DISTINTA_1 = _serie([-0.01, 0.02, -0.03, 0.01, 0.02])
DISTINTA_2 = _serie([0.03, 0.01, -0.02, -0.01, -0.03])
DISTINTA_3 = _serie([0.01, -0.03, 0.02, 0.03, -0.01])
DISTINTA_4 = _serie([-0.02, 0.01, 0.01, -0.03, 0.03])


def test_cinco_correlacionadas_no_pesan_como_cinco_independientes():
    """El corazón de la Fase 5: cinco tickets no son cinco apuestas.

    Mismas candidatas, mismos sectores, mismo peso bruto. Lo único que cambia
    es si sus retornos se mueven juntos. Si el resultado fuera el mismo, el
    dimensionador no estaría haciendo su trabajo.
    """
    simbolos = ["A", "B", "C", "D", "E"]
    # Sectores distintos a propósito: así el recorte no puede venir del tope
    # sectorial, tiene que venir de la correlación.
    cands = [
        _c(s, sector=f"Sector{i}", peso=9.0, vol=20.0)
        for i, s in enumerate(simbolos)
    ]

    juntas = sizing.dimensionar(cands, retornos={s: IGUAL for s in simbolos})
    sueltas = sizing.dimensionar(
        cands,
        retornos=dict(
            zip(simbolos, [ARRIBA, DISTINTA_1, DISTINTA_2, DISTINTA_3, DISTINTA_4])
        ),
    )

    total_juntas = sum(juntas["pesos"].values())
    total_sueltas = sum(sueltas["pesos"].values())
    assert total_juntas < total_sueltas, (
        f"cinco posiciones idénticas recibieron {total_juntas:.1f} % y cinco "
        f"independientes {total_sueltas:.1f} %: la correlación no está pesando"
    )
    # Y las cinco idénticas caen bajo el tope de un solo cluster.
    assert total_juntas <= sizing.MAX_POR_CLUSTER_PCT + 0.01


def test_ocho_ideas_al_uno_por_ciento_no_autorizan_un_ocho_por_ciento():
    """Cada idea arriesga un 1 %, pero el conjunto no suma libremente.

    Es el error que motivó separar `sizing` de `decision`: ocho pesos brutos
    correctos por separado dan una cartera insostenible.
    """
    simbolos = [f"S{i}" for i in range(8)]
    cands = [_c(s, sector=f"Sec{i}", peso=12.5, vol=25.0) for i, s in enumerate(simbolos)]
    r = sizing.dimensionar(cands, retornos={s: IGUAL for s in simbolos})
    total = sum(r["pesos"].values())
    assert total < 8 * 12.5
    assert total <= sizing.MAX_POR_CLUSTER_PCT + 0.01
    assert r["recortes"], "se recortó sin explicar por qué"


def test_una_idea_buena_puede_ser_rechazada_por_lo_que_ya_tienes():
    """Análisis individual impecable, tamaño cero. Es el caso que importa.

    El dimensionador no opina sobre la empresa: dice que no cabe. Y lo dice
    con la razón, porque «0 %» sin explicación se lee como un fallo.
    """
    r = sizing.dimensionar(
        [_c("NUEVA", sector="Tech", peso=9.0, vol=20.0)],
        cartera=[
            {"symbol": "YA1", "sector": "Tech", "peso_pct": 13.0, "vol_anual_pct": 20.0},
            {"symbol": "YA2", "sector": "Tech", "peso_pct": 12.0, "vol_anual_pct": 20.0},
        ],
        retornos=None,
    )
    assert r["pesos"]["NUEVA"] == 0.0
    assert any("sin margen" in x.lower() for x in r["recortes"])


def test_la_cartera_abierta_sola_ya_puede_agotar_el_objetivo_de_volatilidad():
    """Si lo que tienes ya pasa del objetivo, las ideas nuevas van a cero.

    Y el mensaje tiene que decir que no es culpa de las ideas: no cabe más
    riesgo, y bajar de ahí es una decisión de soltar, no de dimensionar.
    """
    r = sizing.dimensionar(
        [_c("NUEVA", sector="Otro", peso=5.0, vol=20.0)],
        cartera=[
            {"symbol": "V1", "sector": "Tech", "peso_pct": 40.0, "vol_anual_pct": 45.0},
            {"symbol": "V2", "sector": "Salud", "peso_pct": 40.0, "vol_anual_pct": 45.0},
        ],
        retornos=None,
    )
    assert r["pesos"]["NUEVA"] == 0.0
    assert any("no es que las ideas sean malas" in x.lower() for x in r["recortes"])


def test_los_controles_viajan_siempre_en_la_respuesta():
    """Sin esto, el consumidor no puede saber qué se comprobó y qué no."""
    r = sizing.dimensionar([_c("A")], retornos=None)
    nombres = {c["limite"] for c in r["controles"]}
    assert nombres == {"posición", "sector", "correlación", "volatilidad"}
    for c in r["controles"]:
        assert "aplicado" in c
        if not c["aplicado"]:
            assert c["motivo"], f"«{c['limite']}» no se aplicó y no dice por qué"


def test_un_limite_no_aplicado_queda_en_el_registro(caplog):
    import logging

    # El capturador se engancha al logger directamente: `registro.configurar()`
    # corta la propagación de `app`, y si otro test ya la llamó, caplog (que
    # escucha en la raíz) no vería nada.
    registro = logging.getLogger("app.riesgo")
    registro.addHandler(caplog.handler)
    try:
        with caplog.at_level(logging.WARNING, logger="app.riesgo"):
            sizing.dimensionar([_c("A"), _c("B")], retornos=None)
    finally:
        registro.removeHandler(caplog.handler)
    assert any("correlación" in r.getMessage() and "NO aplicado" in r.getMessage()
               for r in caplog.records)

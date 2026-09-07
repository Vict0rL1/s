"""La cartera como una cosa, no como N análisis sueltos.

Lo que fijan estos tests no es que los números salgan: es que salgan ACOMPAÑADOS
de lo que los hace legibles. Un «−45 % en 2008» calculado sobre las tres
posiciones de ocho que existían entonces no es un dato de tu cartera, y la
diferencia entre informarlo y esconderlo es toda la diferencia.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest

from app.analysis import portfolio_risk as pr


def _dias(desde: date, hasta: date) -> list[date]:
    dias, d = [], desde
    while d <= hasta:
        if d.weekday() < 5:
            dias.append(d)
        d += timedelta(days=1)
    return dias


def _serie(dias, semilla, beta=0.0, comun=None, ruido=0.01, s0=100.0):
    """Precios = factor común * beta + ruido propio. Con beta alto, se mueven juntas."""
    rng = np.random.default_rng(semilla)
    idio = rng.normal(0, ruido, len(dias))
    p, out = s0, []
    for i, d in enumerate(dias):
        r = idio[i] + (beta * comun[i] if comun is not None else 0.0)
        p *= 1 + r
        out.append((d, p))
    return out


@pytest.fixture
def calendario():
    return _dias(date(2006, 1, 2), date(2023, 12, 29))


@pytest.fixture
def factor_comun(calendario):
    return np.random.default_rng(0).normal(0, 0.012, len(calendario))


# --- Correlación --------------------------------------------------------------


def test_la_correlacion_se_mide_sobre_retornos_y_no_sobre_precios(calendario):
    """Dos precios que suben correlacionan siempre; eso no dice nada.

    Dos series con tendencia alcista fuerte pero ruido independiente tienen
    correlación de PRECIOS cercana a 1 y correlación de RETORNOS cercana a 0.
    Si el módulo devolviera lo primero, este test fallaría.
    """
    rng = np.random.default_rng(3)
    a, b, pa, pb = [], [], 100.0, 100.0
    for d in calendario:
        pa *= 1 + 0.0006 + rng.normal(0, 0.01)
        pb *= 1 + 0.0006 + rng.normal(0, 0.01)
        a.append((d, pa))
        b.append((d, pb))

    precios = np.corrcoef([p for _, p in a], [p for _, p in b])[0, 1]
    assert abs(precios) > 0.8, "el escenario debe tener precios muy correlacionados"

    resultado = pr.matriz_correlacion({"A": a, "B": b})
    assert resultado["disponible"] is True
    assert abs(resultado["parejas"][0]["corr"]) < 0.15


def test_la_correlacion_dice_que_posicion_le_recorta_la_ventana(calendario, factor_comun):
    """Si una posición se compró el año pasado, TODAS se correlacionan sobre ese
    año. El usuario cree estar viendo la correlación de siempre."""
    corte = calendario.index(date(2022, 1, 3))
    series = {
        "VIEJA": _serie(calendario, 1, 1.0, factor_comun),
        "OTRA": _serie(calendario, 2, 1.0, factor_comun),
        "NUEVA": _serie(calendario, 3, 1.0, factor_comun)[corte:],
    }
    r = pr.matriz_correlacion(series)

    assert r["limita_la_ventana"] == "NUEVA"
    assert date.fromisoformat(r["desde"]) >= date(2022, 1, 3)
    assert "NUEVA" in r["nota"]


def test_si_todas_cubren_la_ventana_no_se_acusa_a_ninguna_de_recortarla(
    calendario, factor_comun
):
    """Con `ventana_reciente` todas las series quedan del mismo largo, y ahí
    `min()` devolvía una cualquiera: la pantalla llegó a decir que AAPL —con
    veinte años de histórico— era «la posición con menos histórico»."""
    series = pr.ventana_reciente(
        {
            "AAPL": _serie(calendario, 1, 1.0, factor_comun),
            "MSFT": _serie(calendario, 2, 1.0, factor_comun),
            "NVDA": _serie(calendario, 3, 1.0, factor_comun),
        }
    )
    r = pr.matriz_correlacion(series)
    assert r["limita_la_ventana"] is None
    assert "cubren la ventana entera" in r["nota"]
    assert "menos histórico" not in r["nota"]


def test_sin_solape_no_se_inventa_una_correlacion(calendario):
    """Correlacionar series con fechas distintas mide el calendario."""
    mitad = len(calendario) // 2
    series = {
        "A": _serie(calendario[:mitad], 1),
        "B": _serie(calendario[mitad:], 2),
    }
    r = pr.matriz_correlacion(series)
    assert r["disponible"] is False
    assert "sesiones" in r["nota"]


def test_una_serie_plana_se_descarta_y_se_dice_cual(calendario):
    series = {
        "VIVA": _serie(calendario, 1),
        "OTRA": _serie(calendario, 2),
        "PLANA": [(d, 50.0) for d in calendario],
    }
    r = pr.matriz_correlacion(series)
    assert r["disponible"] is True
    assert r["descartadas"] == ["PLANA"]
    assert "PLANA" not in r["simbolos"]
    assert "PLANA" in r["nota"]


def test_la_ventana_reciente_recorta_por_la_cola(calendario):
    """El estrés quiere 2008; la correlación quiere lo de ahora."""
    series = {"A": _serie(calendario, 1)}
    recortada = pr.ventana_reciente(series, 100)
    assert len(recortada["A"]) == 100
    assert recortada["A"][-1] == series["A"][-1]  # se queda con lo NUEVO


# --- Concentración real -------------------------------------------------------


def test_diez_tickers_identicos_son_una_sola_apuesta():
    """La pregunta del usuario, literal: cuánto del riesgo viene de una sola
    apuesta subyacente aunque estén en tickers distintos."""
    r = pr.numero_efectivo_de_apuestas([[1.0] * 10] * 10)
    assert r["apuestas_efectivas"] == pytest.approx(1.0, abs=0.01)
    assert r["primera_componente_pct"] == pytest.approx(100.0, abs=0.1)


def test_diez_tickers_independientes_son_diez_apuestas():
    r = pr.numero_efectivo_de_apuestas(np.eye(10).tolist())
    assert r["apuestas_efectivas"] == pytest.approx(10.0, abs=0.01)


def test_una_cartera_correlacionada_tiene_menos_apuestas_que_posiciones(
    calendario, factor_comun
):
    series = {
        f"S{i}": _serie(calendario, i + 10, 1.0, factor_comun, ruido=0.004)
        for i in range(6)
    }
    corr = pr.matriz_correlacion(series)
    r = pr.numero_efectivo_de_apuestas(corr["matriz"])
    assert r["apuestas_efectivas"] < 2.0
    assert r["primera_componente_pct"] > 70
    assert "más recibos" in r["nota"]


# --- Look-through de ETFs -----------------------------------------------------


def test_la_exposicion_a_una_empresa_suma_la_directa_y_la_del_etf():
    """Tener AAPL y un ETF que lleva AAPL dentro es tener más AAPL."""
    posiciones = [
        {"symbol": "AAPL", "peso_pct": 20.0},
        {"symbol": "SPY", "peso_pct": 50.0, "es_etf": True},
    ]
    holdings = {
        "SPY": [{"symbol": "AAPL", "weight": 0.07}, {"symbol": "MSFT", "weight": 0.06}]
    }
    r = pr.look_through_etf(posiciones, holdings)

    aapl = next(e for e in r["exposicion"] if e["symbol"] == "AAPL")
    assert aapl["directa_pct"] == 20.0
    assert aapl["indirecta_pct"] == pytest.approx(3.5)  # 50 % * 7 %
    assert aapl["total_pct"] == pytest.approx(23.5)
    assert r["duplicadas"] == ["AAPL"]

    # MSFT solo existe dentro del fondo: aparece, pero sin parte directa.
    msft = next(e for e in r["exposicion"] if e["symbol"] == "MSFT")
    assert msft["directa_pct"] == 0.0
    assert msft["total_pct"] == pytest.approx(3.0)


def test_el_look_through_confiesa_cuanto_del_fondo_ve():
    """Los ~10 mayores holdings de un S&P 500 son un 30 % del fondo. Callarlo
    haría pasar «no hay solape» por «no hay solape en lo que miré»."""
    posiciones = [{"symbol": "SPY", "peso_pct": 100.0, "es_etf": True}]
    holdings = {
        "SPY": [{"symbol": "AAPL", "weight": 0.07}, {"symbol": "MSFT", "weight": 0.06}]
    }
    r = pr.look_through_etf(posiciones, holdings)
    assert r["cobertura_por_etf_pct"]["SPY"] == pytest.approx(13.0)
    assert "punta" in r["nota"]


def test_un_etf_sin_composicion_se_nombra_en_vez_de_desaparecer():
    posiciones = [{"symbol": "XYZ", "peso_pct": 100.0, "es_etf": True}]
    r = pr.look_through_etf(posiciones, {})
    assert r["etfs_sin_composicion"] == ["XYZ"]


# --- Exposición agregada ------------------------------------------------------


def test_lo_desconocido_va_a_su_cubo_y_se_cuenta():
    """Repartir lo que no se sabe entre lo que sí daría una foto más limpia y
    menos cierta."""
    posiciones = [
        {"symbol": "A", "peso_pct": 40.0, "sector": "Tech"},
        {"symbol": "B", "peso_pct": 35.0, "sector": None},
        {"symbol": "C", "peso_pct": 25.0, "sector": "Tech"},
    ]
    r = pr.exposicion(posiciones, "sector", "Sin sector")
    assert r["desconocido_pct"] == 35.0
    assert r["filas"][0] == {"etiqueta": "Tech", "peso_pct": 65.0}
    assert sum(f["peso_pct"] for f in r["filas"]) == pytest.approx(100.0)
    assert "35 %" in r["nota"]


def test_las_caracteristicas_no_se_disfrazan_de_exposicion_a_factores():
    """Una media ponderada no es una exposición estimada por regresión, y
    llamarla así sería vestir de rigor lo que no lo tiene."""
    posiciones = [
        {"symbol": "A", "peso_pct": 50.0, "pe_ttm": 40.0, "roe": 0.30},
        {"symbol": "B", "peso_pct": 50.0, "pe_ttm": 10.0, "roe": 0.10},
    ]
    r = pr.caracteristicas_ponderadas(posiciones)
    pe = next(c for c in r["caracteristicas"] if c["campo"] == "pe_ttm")
    assert pe["valor"] == pytest.approx(25.0)
    assert r["con_referencia"] is False
    assert "referencia" in r["nota"].lower()


def test_la_cobertura_de_cada_caracteristica_viaja_con_el_numero():
    """Un P/E medio calculado sobre el 20 % de la cartera no es el P/E de la
    cartera."""
    posiciones = [
        {"symbol": "A", "peso_pct": 20.0, "pe_ttm": 40.0},
        {"symbol": "B", "peso_pct": 80.0, "pe_ttm": None},
    ]
    pe = next(
        c
        for c in pr.caracteristicas_ponderadas(posiciones)["caracteristicas"]
        if c["campo"] == "pe_ttm"
    )
    assert pe["valor"] == pytest.approx(40.0)
    assert pe["cobertura_pct"] == 20.0


def test_la_inclinacion_respeta_el_sentido_de_cada_metrica():
    """En value, P/E BAJO es la inclinación; en quality, ROE ALTO."""
    posiciones = [{"symbol": "A", "peso_pct": 100.0, "pe_ttm": 8.0, "roe": 0.05}]
    r = pr.caracteristicas_ponderadas(posiciones, {"pe_ttm": 20.0, "roe": 0.15})
    por_campo = {c["campo"]: c for c in r["caracteristicas"]}
    assert por_campo["pe_ttm"]["inclinacion"] == "hacia"  # barata → value
    assert por_campo["roe"]["inclinacion"] == "en contra"  # ROE bajo → poca calidad


# --- Estrés en crisis reales --------------------------------------------------


def test_el_estres_mide_las_tres_crisis_cuando_hay_historico(calendario, factor_comun):
    series = {"A": _serie(calendario, 1, 1.0, factor_comun)}
    posiciones = [{"symbol": "A", "peso_pct": 100.0}]
    r = pr.estres_en_crisis(posiciones, series)
    assert {c["clave"] for c in r["crisis"]} == {"2008", "2020", "2022"}
    assert r["medibles"] == 3
    for c in r["crisis"]:
        assert c["cobertura_pct"] == 100.0
        assert c["max_drawdown_pct"] <= 0


def test_una_posicion_que_no_existia_baja_la_cobertura_y_se_nombra(
    calendario, factor_comun
):
    """De ocho posiciones, si en 2008 solo existían tres, el número describe
    esas tres reponderadas — y hay que decirlo."""
    corte = calendario.index(date(2015, 1, 2))
    series = {
        "VIEJA": _serie(calendario, 1, 1.0, factor_comun),
        "NUEVA": _serie(calendario, 2, 1.0, factor_comun)[corte:],
    }
    posiciones = [
        {"symbol": "VIEJA", "peso_pct": 30.0},
        {"symbol": "NUEVA", "peso_pct": 70.0},
    ]
    r = pr.estres_en_crisis(posiciones, series)
    c2008 = next(c for c in r["crisis"] if c["clave"] == "2008")

    assert c2008["cobertura_pct"] == pytest.approx(30.0)
    assert c2008["sin_datos"] == ["NUEVA"]
    # Solo el 30 % cubierto: por debajo de la mitad se retira el titular.
    assert c2008["titular_fiable"] is False
    assert "NO tu cartera" in c2008["nota"]

    c2020 = next(c for c in r["crisis"] if c["clave"] == "2020")
    assert c2020["titular_fiable"] is True
    assert c2020["cobertura_pct"] == 100.0


def test_sin_historico_se_dice_que_no_hay_datos_y_no_que_aguanto():
    """El silencio se lee como buena noticia. Hay que romperlo."""
    posiciones = [{"symbol": "IPO", "peso_pct": 100.0}]
    r = pr.estres_en_crisis(posiciones, {})
    c2008 = next(c for c in r["crisis"] if c["clave"] == "2008")
    assert c2008["medible"] is False
    assert "No es que aguantara bien" in c2008["nota"]


def test_el_estres_avisa_de_que_los_pesos_son_los_de_hoy(calendario, factor_comun):
    """En 2008 no tenías esta cartera, y la empresa de hoy no es la de entonces."""
    r = pr.estres_en_crisis(
        [{"symbol": "A", "peso_pct": 100.0}],
        {"A": _serie(calendario, 1, 1.0, factor_comun)},
    )
    assert "no «cómo se habría comportado tu cartera»" in r["aviso_general"]


def test_el_estres_rebalancea_a_pesos_fijos_y_no_deja_derivar_la_cartera():
    """Comprar y no tocar deja que los pesos deriven: al final del tramo se está
    midiendo otra cartera. Con mezcla constante, 50/50 de algo que sube un 0,5 %
    diario y algo que baja un 0,5 % diario rinde 0 al rebalancear cada día; con
    buy-and-hold rendiría más de un +50 %. Este test fija la primera."""
    crisis = [
        {
            "clave": "prueba",
            "nombre": "Ventana de prueba",
            "desde": date(2020, 1, 1),
            "hasta": date(2020, 12, 31),
            "caida_sp500_pct": -10.0,
            "contexto": "sintética",
        }
    ]
    dias = _dias(date(2020, 1, 1), date(2020, 12, 31))
    n = len(dias)
    sube = [(d, 100.0 * (1.005**i)) for i, d in enumerate(dias)]
    baja = [(d, 100.0 * (0.995**i)) for i, d in enumerate(dias)]

    # Lo que habría dado comprar y no tocar, calculado aquí para que el test
    # documente el tamaño del error que se está evitando.
    buy_and_hold = (
        0.5 * sube[-1][1] / sube[0][1] + 0.5 * baja[-1][1] / baja[0][1] - 1
    ) * 100
    assert buy_and_hold > 50, "el escenario debe separar de verdad las dos formas"

    r = pr.estres_en_crisis(
        [{"symbol": "SUBE", "peso_pct": 50.0}, {"symbol": "BAJA", "peso_pct": 50.0}],
        {"SUBE": sube, "BAJA": baja},
        crisis,
    )["crisis"][0]
    assert r["medible"] is True
    assert r["sesiones"] == n
    # Mezcla constante: 0 %. Buy-and-hold daría más de un +50 % en el mismo tramo.
    assert abs(r["retorno_pct"]) < 0.5


def test_pocas_sesiones_sueltas_no_describen_una_caida_de_un_ano():
    """Tres cierres dentro de 2008 no son el histórico de 2008."""
    posiciones = [{"symbol": "A", "peso_pct": 100.0}]
    series = {
        "A": [(date(2008, 1, 2), 100.0), (date(2008, 6, 2), 80.0), (date(2009, 1, 2), 60.0)]
    }
    c2008 = next(
        c for c in pr.estres_en_crisis(posiciones, series)["crisis"] if c["clave"] == "2008"
    )
    assert c2008["medible"] is False


def test_una_cartera_que_sube_en_la_crisis_no_dice_que_cayo_menos():
    """«Cayó menos que el S&P 500» sobre un +14 % es verdad y se lee mal."""
    dias = _dias(date(2022, 1, 3), date(2022, 10, 12))
    sube = [(d, 100.0 * (1.002**i)) for i, d in enumerate(dias)]
    c2022 = next(
        c
        for c in pr.estres_en_crisis([{"symbol": "A", "peso_pct": 100.0}], {"A": sube})[
            "crisis"
        ]
        if c["clave"] == "2022"
    )
    assert c2022["retorno_pct"] > 0
    assert "SUBIDO" in c2022["nota"]
    assert "caído menos" not in c2022["nota"]


def test_la_volatilidad_sale_del_historico_que_ya_esta_descargado(calendario):
    """Pedirla a una API sería pagar dos veces por el mismo dato."""
    tranquila = _serie(calendario, 1, ruido=0.005)
    movida = _serie(calendario, 2, ruido=0.02)
    assert pr.volatilidad_anualizada(movida) > pr.volatilidad_anualizada(tranquila)
    # ~0,5 % diario * sqrt(252) ≈ 8 %; ~2 % diario ≈ 32 %.
    assert pr.volatilidad_anualizada(tranquila) == pytest.approx(8, abs=2)
    assert pr.volatilidad_anualizada(movida) == pytest.approx(32, abs=5)


def test_sin_suficientes_sesiones_la_volatilidad_no_se_inventa():
    """Una volatilidad de diez días no es una volatilidad anual."""
    dias = _dias(date(2024, 1, 1), date(2024, 1, 20))
    assert pr.volatilidad_anualizada(_serie(dias, 1)) is None

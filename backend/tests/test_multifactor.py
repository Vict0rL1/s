"""Tests del screener multifactor.

El riesgo de este módulo no es que reviente: es que **parezca informativo sin
serlo**. Seis controles deslizantes y un ranking ordenado dan una sensación de
rigor que un montón de ruido bien maquetado produce igual de bien. Lo que se fija
aquí es lo que separa una cosa de la otra:

- que la normalización sea sectorial de verdad, no un adorno del docstring;
- que un factor ausente no se rellene con un cero disfrazado de dato;
- que el percentil histórico compare la empresa con SU pasado y no consigo misma;
- y que el solapamiento entre familias se mida y se diga, porque seis pesos al
  máximo no son seis apuestas.
"""

from __future__ import annotations

import math

from app.analysis.multifactor import (
    FAMILIAS,
    MIN_ANOS_HISTORICO,
    MIN_POR_SECTOR,
    combinar,
    correlacion_entre_familias,
    factores_crudos,
    historia_de_la_empresa,
    normalizar_pesos,
    percentil_de_metrica,
    puntuar_familias,
    rankear,
    resumen_historico,
    zscores_por_sector,
)


def empresa(symbol, sector="Tech", *, pe=20.0, pb=3.0, roe=0.15, margen=0.20,
            d_e=0.5, momentum=0.10, vol=25.0, cap=1e10, crec=0.08, fcf_yield=0.05,
            roic=0.12, cobertura=10.0):
    return {
        "symbol": symbol,
        "sector": sector,
        "metrics": {
            "pe_ttm": pe,
            "pb": pb,
            "fcf_yield": fcf_yield,
            "roe": roe,
            "roic": roic,
            "operating_margin": margen,
            "interest_coverage": cobertura,
            "debt_to_equity": d_e,
        },
        "momentum": momentum,
        "vol_anual_pct": vol,
        "market_cap": cap,
        "crecimiento": {"revenue_cagr": crec, "eps_cagr": crec, "fcf_cagr": crec},
    }


def universo(n=12, sector="Tech", **kwargs):
    """Un universo con dispersión en todo, para que los z-scores existan."""
    return [
        empresa(
            f"S{i}",
            sector,
            pe=10 + i,
            pb=1 + i * 0.3,
            roe=0.05 + i * 0.02,
            margen=0.05 + i * 0.02,
            d_e=0.2 + i * 0.1,
            momentum=-0.2 + i * 0.05,
            vol=15 + i * 2,
            cap=1e9 * (i + 1),
            crec=0.01 + i * 0.02,
            **kwargs,
        )
        for i in range(n)
    ]


# --- Las seis familias existen y están orientadas ----------------------------


def test_las_seis_familias_estan_y_ninguna_se_queda_vacia():
    r = rankear(universo())
    assert set(FAMILIAS) == {
        "value", "quality", "momentum", "growth", "low_volatility", "size"
    }
    for fila in r["ranking"]:
        assert set(fila["familias"]) == set(FAMILIAS)
        assert all(v is not None for v in fila["familias"].values()), fila


def test_todos_los_factores_apuntan_a_mas_alto_es_mejor():
    """Barata, rentable, con momentum, pequeña, poco volátil y creciendo."""
    buena = factores_crudos(
        {"pe_ttm": 8, "pb": 1, "roe": 0.30, "debt_to_equity": 0.1},
        momentum=0.4, vol_anual_pct=12.0, market_cap=1e9,
        crecimiento={"revenue_cagr": 0.20},
    )
    mala = factores_crudos(
        {"pe_ttm": 60, "pb": 12, "roe": 0.02, "debt_to_equity": 4.0},
        momentum=-0.3, vol_anual_pct=70.0, market_cap=2e12,
        crecimiento={"revenue_cagr": -0.05},
    )
    for factor in ("earnings_yield", "book_yield", "roe", "low_leverage",
                   "momentum_12_1", "baja_volatilidad", "small_cap", "revenue_cagr"):
        assert buena[factor] > mala[factor], factor


def test_un_multiplo_negativo_no_convierte_una_empresa_en_perdidas_en_barata():
    assert factores_crudos({"pe_ttm": -12})["earnings_yield"] is None
    assert factores_crudos({"pe_ttm": 0})["earnings_yield"] is None


def test_el_tamaño_usa_logaritmos_para_que_no_lo_decidan_tres_gigantes():
    """Las capitalizaciones abarcan varios órdenes de magnitud: un z-score sobre
    el valor crudo lo dominarían las mega-caps y el resto sería indistinguible."""
    pequeña = factores_crudos({}, market_cap=1e9)["small_cap"]
    grande = factores_crudos({}, market_cap=1e12)["small_cap"]
    assert pequeña > grande
    assert abs((pequeña - grande) - math.log(1000)) < 1e-9


def test_un_dato_ausente_no_se_rellena_con_un_cero():
    crudos = factores_crudos({}, momentum=None)
    assert crudos["roe"] is None
    assert crudos["momentum_12_1"] is None
    assert crudos["small_cap"] is None


# --- Normalización por sector, no en absoluto --------------------------------


def test_se_normaliza_dentro_del_sector_no_contra_el_mercado():
    """Un P/E de 9 es caro en banca y barato en software. Un corte absoluto
    llenaría la lista de bancos y utilities todos los años."""
    # Banca: múltiplos estructuralmente bajos. Software: estructuralmente altos.
    banca = [empresa(f"B{i}", "Banca", pe=7 + i * 0.5) for i in range(6)]
    software = [empresa(f"W{i}", "Software", pe=30 + i * 2) for i in range(6)]
    r = rankear(banca + software, {"value": 1})

    por_symbol = {f["symbol"]: f for f in r["ranking"]}
    # El banco más barato de su sector debe puntuar como el software más barato
    # del suyo, pese a que sus P/E son 7 y 30.
    assert por_symbol["B0"]["familias"]["value"] > 0
    assert por_symbol["W0"]["familias"]["value"] > 0
    # Y el software caro puntúa mal aunque en absoluto no sea el P/E más alto...
    assert por_symbol["W5"]["familias"]["value"] < 0
    # ...mientras que ningún sector se lleva el podio entero.
    top3 = {f["symbol"][0] for f in r["ranking"][:3]}
    assert len(top3) == 2, [f["symbol"] for f in r["ranking"][:3]]


def test_un_sector_sin_muestra_no_se_puntua_y_se_dice():
    """Puntuar una empresa contra dos comparables es ruido con formato de
    número. Mejor no puntuarla y decir por qué."""
    grande = universo(8, "Tech")
    diminuto = [empresa("RARA", "Sector raro")]
    r = rankear(grande + diminuto)

    assert "RARA" not in [f["symbol"] for f in r["ranking"]]
    assert any(x["symbol"] == "RARA" for x in r["sin_puntuar"])
    assert "Sector raro" in r["sectores_sin_muestra"]
    assert str(MIN_POR_SECTOR) in r["aviso_sectores"]


def test_zscores_por_sector_devuelve_el_tamaño_de_cada_uno():
    z, tamanos = zscores_por_sector(
        {f"A{i}": float(i) for i in range(6)} | {"B0": 1.0},
        {f"A{i}": "Tech" for i in range(6)} | {"B0": "Banca"},
    )
    assert tamanos == {"Tech": 6, "Banca": 1}
    assert z["B0"] is None  # sector de una sola empresa


# --- Pesos ajustables --------------------------------------------------------


def test_los_pesos_cambian_el_ranking():
    """Si mover los pesos no cambia el orden, los controles son decorativos."""
    u = universo(10)
    por_value = rankear(u, {"value": 1})["ranking"]
    por_momentum = rankear(u, {"momentum": 1})["ranking"]
    assert [f["symbol"] for f in por_value] != [f["symbol"] for f in por_momentum]
    # En este universo, value y momentum están construidos en contra: el más
    # barato es el de menos momentum.
    assert por_value[0]["symbol"] != por_momentum[0]["symbol"]


def test_los_z_viajan_con_precision_para_que_el_cliente_reordene_igual():
    """La UI reordena en vivo al mover los pesos usando los z que le llegan.

    Si viajaran redondeados a la precisión de pantalla, dos empresas separadas
    por menos que el redondeo saldrían en un orden al mover el control y en otro
    al pulsar «Recalcular», sin nada que lo explicara. Se comprueba reproduciendo
    aquí la aritmética exacta que hace el cliente.
    """
    u = universo(14)
    pesos = {"value": 0.6, "quality": 0.1, "momentum": 0.05,
             "growth": 0.05, "low_volatility": 0.1, "size": 0.1}
    r = rankear(u, pesos)
    norm = normalizar_pesos(pesos)

    recalculado = []
    for fila in r["ranking"]:
        suma = disponible = 0.0
        for f, w in norm.items():
            z = fila["familias"][f]
            if z is None or not w:
                continue
            suma += w * z
            disponible += w
        recalculado.append((fila["symbol"], suma / disponible))
    recalculado.sort(key=lambda kv: -kv[1])

    assert [s for s, _ in recalculado] == [f["symbol"] for f in r["ranking"]]
    for (_, propio), fila in zip(recalculado, r["ranking"]):
        assert abs(propio - fila["score"]) < 1e-5


def test_los_pesos_se_normalizan_y_da_igual_la_escala():
    assert normalizar_pesos({"value": 2, "quality": 2}) == {"value": 0.5, "quality": 0.5}
    assert normalizar_pesos({"value": 0.5, "quality": 0.5}) == {"value": 0.5, "quality": 0.5}
    assert abs(sum(normalizar_pesos({}).values()) - 1.0) < 1e-9


def test_un_peso_negativo_se_rechaza_en_vez_de_invertir_el_factor_a_escondidas():
    """Apostar EN CONTRA de un factor es otra estrategia, no un signo menos."""
    try:
        normalizar_pesos({"value": -1})
    except ValueError as exc:
        assert "en contra" in str(exc)
    else:
        raise AssertionError("un peso negativo debería rechazarse")


def test_todos_los_pesos_a_cero_cae_a_los_de_partida():
    assert normalizar_pesos({"value": 0, "quality": 0}) == normalizar_pesos(None)


def test_la_cobertura_dice_cuanto_del_peso_se_pudo_medir():
    """Un compuesto con cobertura 0,4 y otro con 1,0 no son comparables aunque
    salga el mismo número."""
    completo = combinar(
        {f: 1.0 for f in FAMILIAS}, normalizar_pesos(None)
    )
    parcial = combinar(
        {"value": 1.0, **{f: None for f in FAMILIAS if f != "value"}},
        normalizar_pesos(None),
    )
    assert completo["cobertura"] == 1.0
    assert parcial["cobertura"] < 0.5
    assert parcial["score"] == 1.0  # se renormaliza sobre lo que hay


def test_las_aportaciones_explican_de_donde_sale_la_nota():
    """Una empresa que puntúa 1,8 por momentum puro y otra que puntúa 1,8 con
    las seis familias de acuerdo son ideas muy distintas."""
    r = rankear(universo(10))
    fila = r["ranking"][0]
    # Tolerancia holgada a propósito: las aportaciones viajan redondeadas a tres
    # decimales para la UI, y seis de ellas acumulan hasta 3 milésimas.
    assert abs(sum(fila["aportaciones"].values()) - fila["score"]) < 0.005


# --- Solapamiento entre familias ---------------------------------------------


def test_se_mide_y_se_declara_cuanto_se_pisan_las_familias():
    """Seis controles sugieren seis apuestas independientes y no lo son."""
    # Calidad y baja volatilidad construidas para ir de la mano.
    empresas = [
        empresa(f"S{i}", roe=0.05 + i * 0.02, margen=0.05 + i * 0.02,
                roic=0.03 + i * 0.02, d_e=2.0 - i * 0.15, cobertura=2 + i * 3,
                vol=45 - i * 2.5, pe=10 + i, pb=1 + i * 0.2, momentum=i * 0.03,
                cap=1e9 * (i + 1), crec=i * 0.01)
        for i in range(14)
    ]
    corr = rankear(empresas)["correlacion_familias"]
    # Las parejas van con los nombres en orden alfabético.
    assert corr["pares"]["low_volatility|quality"] > 0.5
    assert any("low_volatility y quality" in s for s in corr["solapamientos"])
    assert "no son dos apuestas" in corr["nota"]


def test_un_universo_pequeño_no_finge_medir_el_solapamiento():
    familias = puntuar_familias({"roe": {f"S{i}": float(i) for i in range(4)}})
    corr = correlacion_entre_familias(familias)
    assert corr["pares"] == {}
    assert "demasiado pequeño" in corr["nota"]


# --- Percentil histórico: la parte que el corte transversal no ve ------------


def test_el_percentil_situa_el_valor_de_hoy_en_la_historia_de_la_empresa():
    serie = [0.30, 0.29, 0.28, 0.27, 0.26, 0.25]
    r = percentil_de_metrica(serie, 0.18, "roe")
    assert r["disponible"] is True
    assert r["percentil"] == 0.0  # peor ROE que ninguno de sus años
    assert r["percentil_favorable"] == 0.0
    assert r["mediana"] == 0.275


def test_una_metrica_de_menos_es_mejor_no_se_lee_al_reves():
    """Estar en el percentil 90 de deuda es la peor lectura posible, no la
    mejor. Sin orientación, la UI lo colorearía de verde."""
    r = percentil_de_metrica([0.2, 0.3, 0.4, 0.5, 0.6], 0.9, "debt_to_equity")
    assert r["percentil"] == 1.0
    assert r["percentil_favorable"] == 0.0
    assert r["orientacion"] == "bajo_mejor"


def test_sin_años_suficientes_no_se_inventa_un_rango():
    r = percentil_de_metrica([0.1, 0.2], 0.15, "roe")
    assert r["disponible"] is False
    assert str(MIN_ANOS_HISTORICO) in r["motivo"]


def test_el_valor_actual_no_entra_en_la_serie_contra_la_que_se_compara():
    """Compararse consigo mismo arrastra el percentil hacia el centro."""
    anual = [{"roe": 0.30}, {"roe": 0.30}, {"roe": 0.30}, {"roe": 0.30},
             {"roe": 0.30}, {"roe": 0.30}, {"roe": 0.05}]
    h = historia_de_la_empresa(anual, {"roe": 0.05})
    # Seis años al 30 % y el actual al 5 %: percentil 0, no 1/7.
    assert h["roe"]["percentil"] == 0.0
    assert h["roe"]["n"] == 6


def test_el_caso_que_justifica_todo_esto_una_empresa_que_se_deteriora():
    """ROE del 18 % puntúa bien contra el sector. Que venga del 30 % y lleve
    años cayendo no lo ve ningún z-score transversal."""
    anual = [{"roe": v, "operating_margin": v} for v in (0.30, 0.28, 0.26, 0.24, 0.21, 0.18)]
    historia = historia_de_la_empresa(anual, anual[-1])
    resumen = resumen_historico(historia)
    assert "roe" in resumen["deteriorandose"]
    assert "no lo ve" in resumen["nota"]
    assert "comparables" in resumen["nota"]


def test_una_metrica_en_maximos_avisa_de_que_puede_ser_un_pico_de_ciclo():
    anual = [{"operating_margin": v} for v in (0.10, 0.12, 0.14, 0.16, 0.18, 0.31)]
    resumen = resumen_historico(historia_de_la_empresa(anual, anual[-1]))
    assert "operating_margin" in resumen["en_maximos"]
    assert "pico de ciclo" in resumen["nota"]


def test_sin_historico_se_dice_en_vez_de_callar():
    resumen = resumen_historico(historia_de_la_empresa([{"roe": 0.2}], {"roe": 0.2}))
    assert resumen["medidas"] == 0
    assert "Sin histórico anual suficiente" in resumen["nota"]


# --- Lo que el screener admite sobre sí mismo --------------------------------


def test_el_resultado_declara_que_no_esta_validado():
    """Ordenar por seis factores con pesos a mano es justo la clase de cosa que
    produce resultados bonitos por azar."""
    r = rankear(universo(8))
    assert "NO está validado" in r["advertencia"]
    assert "explorar, no como señal probada" in r["advertencia"]


def test_la_nota_declara_que_los_pesos_de_partida_no_son_un_resultado_medido():
    r = rankear(universo(8))
    assert "no un resultado medido aquí" in r["nota"]
    assert "DENTRO de su sector" in r["nota"]

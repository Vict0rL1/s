"""La curva de valor de la cartera: que el recorrido diga la verdad.

Tres formas de mentir con esta curva, y un test para cada una: convertir el
pasado al tipo de hoy, dejar que un cierre parezca una pérdida, y adelgazar la
serie saltándose el suelo.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.analysis import historial as h

HOY = date(2026, 9, 15)


def _dias(desde: date, hasta: date) -> list[date]:
    dias, d = [], desde
    while d <= hasta:
        if d.weekday() < 5:
            dias.append(d)
        d += timedelta(days=1)
    return dias


def _serie(dias, inicio=100.0, paso=0.0):
    return [(d, inicio + paso * i) for i, d in enumerate(dias)]


def _pos(symbol, cantidad=10, coste=100.0, abierta=None, cerrada=None, moneda="USD"):
    return {
        "symbol": symbol,
        "quantity": cantidad,
        "cost_basis": coste,
        "currency": moneda,
        "opened_at": abierta or date(2026, 1, 2),
        "closed_at": cerrada,
    }


DIAS = _dias(date(2026, 1, 2), HOY)


# --- Lo básico ------------------------------------------------------------------


def test_la_curva_multiplica_cantidad_por_precio_en_cada_fecha():
    serie = _serie(DIAS, 100.0, 1.0)  # 100, 101, 102…
    r = h.historial([_pos("AAA", cantidad=10)], {"AAA": serie}, hoy=HOY)

    assert r["disponible"] is True
    assert r["puntos"][0]["valor"] == pytest.approx(1000.0)
    assert r["puntos"][-1]["valor"] == pytest.approx(serie[-1][1] * 10)


def test_la_linea_de_coste_va_al_lado_de_la_de_valor():
    """Una curva de valor sola no dice si vas ganando."""
    r = h.historial([_pos("AAA", cantidad=10, coste=90.0)], {"AAA": _serie(DIAS)}, hoy=HOY)
    assert all(p["invertido"] == pytest.approx(900.0) for p in r["puntos"])


def test_una_posicion_no_cuenta_antes_de_comprarla():
    tarde = DIAS[len(DIAS) // 2]
    r = h.historial(
        [_pos("AAA"), _pos("BBB", abierta=tarde)],
        {"AAA": _serie(DIAS), "BBB": _serie(DIAS)},
        hoy=HOY,
    )
    primero = r["puntos"][0]
    ultimo = r["puntos"][-1]
    assert primero["abiertas"] == 1
    assert ultimo["abiertas"] == 2


def test_los_dias_sin_cotizacion_usan_el_ultimo_precio_conocido():
    """Interpolar inventaría movimiento donde no lo hubo."""
    huecos = [d for i, d in enumerate(DIAS) if i % 3 == 0]
    r = h.historial([_pos("AAA")], {"AAA": _serie(huecos, 100.0, 0.0)}, hoy=HOY)
    assert all(p["valor"] == pytest.approx(1000.0) for p in r["puntos"])


# --- Un cierre no es una pérdida --------------------------------------------------


def test_cerrar_una_posicion_baja_la_curva_y_se_avisa_de_que_es_una_retirada():
    """Sin decirlo, cada venta se leería como un desplome."""
    cierre = DIAS[len(DIAS) // 2]
    r = h.historial(
        [_pos("AAA"), _pos("BBB", cerrada=cierre)],
        {"AAA": _serie(DIAS), "BBB": _serie(DIAS)},
        hoy=HOY,
    )
    antes = next(p for p in r["puntos"] if p["fecha"] < cierre.isoformat())
    despues = next(p for p in r["puntos"] if p["fecha"] > cierre.isoformat())

    assert despues["valor"] < antes["valor"]
    assert despues["abiertas"] < antes["abiertas"]
    assert cierre.isoformat() in r["cierres"]
    assert "retirada, no una pérdida" in r["aviso"]


def test_sin_cierres_no_se_habla_de_retiradas():
    r = h.historial([_pos("AAA")], {"AAA": _serie(DIAS)}, hoy=HOY)
    assert r["cierres"] == []
    assert "retirada" not in r["aviso"]


def test_siempre_se_dice_que_no_es_el_valor_de_la_cuenta():
    r = h.historial([_pos("AAA")], {"AAA": _serie(DIAS)}, hoy=HOY)
    assert "no el de tu cuenta" in r["aviso"]


# --- El cambio de cada día, no el de hoy ------------------------------------------


def test_se_usa_el_tipo_vigente_de_cada_fecha_y_no_el_actual():
    """Convertir el pasado al tipo de hoy convierte un movimiento de divisa en
    un movimiento de la acción."""
    # El precio NO se mueve: todo lo que cambie viene del tipo.
    precio = _serie(DIAS, 100.0, 0.0)
    # El CAD se deprecia de 1,30 a 1,60 por dólar a lo largo del periodo.
    fx = [(d, 1.30 + 0.30 * i / (len(DIAS) - 1)) for i, d in enumerate(DIAS)]

    r = h.historial(
        [_pos("SHOP", cantidad=10, moneda="CAD")],
        {"SHOP": precio},
        {"CAD": fx},
        hoy=HOY,
    )
    primero, ultimo = r["puntos"][0], r["puntos"][-1]
    assert primero["valor"] == pytest.approx(1000 / 1.30, abs=0.5)
    assert ultimo["valor"] == pytest.approx(1000 / 1.60, abs=0.5)
    # Con el tipo de HOY aplicado a todo, el primer punto valdría lo mismo que
    # el último y la depreciación desaparecería del gráfico.
    assert primero["valor"] > ultimo["valor"]
    assert "tipo vigente ESE día" in r["aviso"]


def test_sin_historico_de_tipo_la_posicion_queda_fuera_y_se_nombra():
    r = h.historial(
        [_pos("AAA"), _pos("TOYO", moneda="JPY")],
        {"AAA": _serie(DIAS), "TOYO": _serie(DIAS)},
        {},  # sin tipos
        hoy=HOY,
    )
    assert [e["symbol"] for e in r["excluidas"]] == ["TOYO"]
    assert "JPY" in r["excluidas"][0]["motivo"]
    assert "quedan fuera de la curva" in r["aviso"]


def test_una_cartera_en_una_sola_divisa_no_menciona_cambios():
    r = h.historial([_pos("AAA")], {"AAA": _serie(DIAS)}, hoy=HOY)
    assert "tipo vigente" not in r["aviso"]


# --- Adelgazar sin mentir ----------------------------------------------------------


def test_el_adelgazado_conserva_el_suelo():
    """Un remuestreo que se salta el mínimo enseña una caída más suave de la
    que hubo, y desmiente al resumen de al lado."""
    puntos = [{"fecha": f"2026-01-{i:02d}", "valor": 1000.0, "invertido": 900.0, "abiertas": 1}
              for i in range(1, 29)] * 20
    puntos[300] = {**puntos[300], "valor": 410.0}
    adelgazada = h._adelgazar(puntos, 60)

    assert len(adelgazada) <= 64
    assert min(p["valor"] for p in adelgazada) == pytest.approx(410.0)


def test_una_serie_corta_no_se_adelgaza():
    puntos = [{"fecha": "2026-01-01", "valor": 1.0, "invertido": 1.0, "abiertas": 1}] * 5
    assert len(h._adelgazar(puntos, 60)) == 5


def test_el_resumen_se_calcula_sobre_la_serie_completa():
    """No puede depender de cuántos puntos quepan en el dibujo."""
    dias = _dias(date(2024, 1, 1), HOY)
    # Sube, se desploma a la mitad, y recupera parte.
    valores = ([100.0] * 200 + [50.0] + [80.0] * (len(dias) - 201))[: len(dias)]
    r = h.historial(
        [_pos("AAA", cantidad=1, abierta=dias[0])],
        {"AAA": list(zip(dias, valores))},
        hoy=HOY,
    )
    assert len(r["puntos"]) <= h.MAX_PUNTOS + 4          # la curva va adelgazada
    assert r["resumen"]["max_drawdown_pct"] == pytest.approx(-50.0, abs=0.1)
    assert r["sesiones"] > len(r["puntos"])              # …y el resumen no


# --- Negativas ---------------------------------------------------------------------


def test_sin_posiciones_no_hay_curva():
    assert h.historial([], {}, hoy=HOY)["disponible"] is False


def test_sin_historico_en_cache_se_dice_que_hay_que_descargarlo():
    r = h.historial([_pos("AAA")], {}, hoy=HOY)
    assert r["disponible"] is False
    assert "Descargar histórico completo" in r["nota"]


def test_con_cuatro_sesiones_no_se_dibuja_una_curva():
    pocos = DIAS[:4]
    r = h.historial([_pos("AAA", abierta=pocos[0])], {"AAA": _serie(pocos)}, hoy=pocos[-1])
    assert r["disponible"] is False
    assert "para que una curva sea una curva" in r["nota"]


# --- El índice encadenado: una venta no es una caída ------------------------------


def test_vender_no_cuenta_como_caida_en_el_drawdown():
    """Sobre el valor bruto, cerrar una posición hunde la línea y el resumen
    publicaba esa venta como «peor caída vivida». Era tu decisión presentada
    como un golpe del mercado."""
    cierre = DIAS[len(DIAS) // 2]
    plano = _serie(DIAS, 100.0, 0.0)  # el precio NO se mueve en todo el periodo
    r = h.historial(
        [_pos("AAA"), _pos("BBB", cerrada=cierre)],
        {"AAA": plano, "BBB": plano},
        hoy=HOY,
    )

    # El valor bruto SÍ cae a la mitad al vender.
    antes = next(p for p in r["puntos"] if p["fecha"] < cierre.isoformat())
    despues = next(p for p in r["puntos"] if p["fecha"] > cierre.isoformat())
    assert despues["valor"] == pytest.approx(antes["valor"] / 2, rel=0.01)

    # Y el drawdown es CERO: el mercado no se movió ni un punto.
    assert r["resumen"]["max_drawdown_pct"] == pytest.approx(0.0, abs=0.01)


def test_comprar_mas_tampoco_cuenta_como_subida():
    """La otra cara: una aportación no es rentabilidad."""
    tarde = DIAS[len(DIAS) // 2]
    plano = _serie(DIAS, 100.0, 0.0)
    r = h.historial(
        [_pos("AAA"), _pos("BBB", abierta=tarde)],
        {"AAA": plano, "BBB": plano},
        hoy=HOY,
    )
    assert r["puntos"][-1]["valor"] > r["puntos"][0]["valor"]   # entró más dinero
    assert r["resumen"]["rendimiento_pct"] == pytest.approx(0.0, abs=0.01)


def test_el_indice_si_recoge_lo_que_hace_el_mercado():
    """Y cuando el precio SÍ se mueve, el índice lo refleja entero."""
    sube = [(d, 100.0 * (1.001**i)) for i, d in enumerate(DIAS)]
    r = h.historial([_pos("AAA")], {"AAA": sube}, hoy=HOY)
    esperado = (1.001 ** (len(DIAS) - 1) - 1) * 100
    assert r["resumen"]["rendimiento_pct"] == pytest.approx(esperado, rel=0.02)


def test_el_indice_recoge_una_caida_real_como_drawdown():
    valores = [100.0] * 60 + [60.0] * (len(DIAS) - 60)
    r = h.historial([_pos("AAA")], {"AAA": list(zip(DIAS, valores))}, hoy=HOY)
    assert r["resumen"]["max_drawdown_pct"] == pytest.approx(-40.0, abs=0.1)


def test_cada_punto_lleva_su_indice():
    r = h.historial([_pos("AAA")], {"AAA": _serie(DIAS)}, hoy=HOY)
    assert all("indice" in p for p in r["puntos"])
    assert r["puntos"][0]["indice"] == pytest.approx(100.0)

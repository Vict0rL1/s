"""Que el dimensionador reciba de verdad los datos que necesita.

Los tests de `test_sizing.py` prueban la función; estos prueban la **llamada**,
que es donde estaban los dos fallos y donde no llegaba ningún test:

1. `dimensionar()` aceptaba `retornos` y el router la llamaba sin ellos. La
   matriz de correlación salía vacía, `clusters` salía siempre `[]` y el límite
   por correlación —escrito, probado y documentado— no se ejecutaba ni una vez
   en producción.
2. `dimensionar()` no sabía nada de las posiciones abiertas, así que los topes
   por sector y por correlación contaban solo las ideas nuevas.

Una función correcta a la que nunca se le pasan los datos es una función que no
existe, y la única forma de que eso no vuelva a pasar es probar el borde.
"""

from __future__ import annotations

import math
import random

from app.routers.signals import (
    _cartera_actual,
    _lista_corta_dimensionada,
    _retornos_desde_spark,
)


def _spark(semilla: int, n: int = 32, ruido_de: list[float] | None = None) -> list[float]:
    """Miniatura de precio como la que trae la respuesta real."""
    rng = random.Random(semilla)
    if ruido_de is not None:
        eco = random.Random(semilla + 500)
        return [round(p * math.exp(eco.gauss(0, 0.001)), 2) for p in ruido_de]
    salida, p = [], 100.0
    for _ in range(n):
        p *= math.exp(rng.gauss(0, 0.05))
        salida.append(round(p, 2))
    return salida


def señal(symbol, score, sector="Tech", spark=None, puntos=251, vol=1.5, last=100.0):
    return {
        "symbol": symbol,
        "score": score,
        "families": {"value": 0.5, "quality": 0.5, "momentum": 0.5},
        "context": {"sector_name": sector},
        "decision": {
            "action": "comprar",
            "levels": {"stop_pct": 12.0, "peso_bruto_pct": 9.0},
        },
        "price": {
            "last": last,
            "daily_vol_pct": vol,
            "spark": spark if spark is not None else _spark(hash(symbol) % 1000),
            "points": puntos,
        },
    }


# --- Bug 1: el límite por correlación no se ejecutaba ------------------------


def test_la_lista_corta_produce_correlaciones_de_verdad():
    """En producción `clusters` salía siempre vacío. Ese es el síntoma exacto."""
    base = _spark(3)
    señales = [
        señal("A", 1.2, "Tech", spark=base),
        señal("B", 1.1, "Salud", spark=_spark(3, ruido_de=base)),  # casi idéntica a A
        señal("C", 1.0, "Energía", spark=_spark(99)),
        señal("D", 0.9, "Consumo", spark=_spark(77)),
    ]
    r = _lista_corta_dimensionada(señales)
    clusters = r["sizing"]["clusters"]
    assert any(set(g) == {"A", "B"} for g in clusters), clusters


def test_los_retornos_salen_de_la_miniatura_sin_llamar_a_ninguna_api():
    """31 retornos de ~11 sesiones: una estimación gruesa, pero gratis. Sin ella
    el límite no existe, y con ella detecta lo que se mueve claramente junto."""
    base = _spark(3)
    señales = [señal("A", 1.0, spark=base), señal("B", 1.0, spark=_spark(3, ruido_de=base))]
    retornos = _retornos_desde_spark(señales, {"A", "B"})
    assert set(retornos) == {"A", "B"}
    assert len(retornos["A"]) == 31  # 32 puntos → 31 retornos


def test_no_se_cruzan_historiales_de_longitudes_distintas():
    """32 puntos muestreados sobre 250 sesiones y otros 32 sobre 100 cubren
    periodos distintos: correlacionarlos daría un número con buena pinta y
    ningún significado."""
    señales = [
        señal("LARGA", 1.0, spark=_spark(3), puntos=251),
        señal("CORTA", 1.0, spark=_spark(4), puntos=100),
    ]
    retornos = _retornos_desde_spark(señales, {"LARGA", "CORTA"})
    assert "CORTA" not in retornos


def test_una_miniatura_demasiado_corta_no_produce_una_correlacion_inventada():
    señales = [
        señal("A", 1.0, spark=[100.0, 101.0, 102.0]),
        señal("B", 1.0, spark=[100.0, 99.0, 98.0]),
    ]
    assert _retornos_desde_spark(señales, {"A", "B"}) == {}


# --- Bug 2: los topes no contaban la cartera abierta -------------------------


def test_la_cartera_abierta_llega_al_dimensionador_con_su_peso_y_su_sector():
    señales = [señal("A", 1.0, "Tech", last=50.0), señal("B", 1.0, "Salud", last=100.0)]
    cartera, aviso = _cartera_actual(
        señales,
        {"A": {"quantity": 60, "cost_basis": 40.0}, "B": {"quantity": 10, "cost_basis": 90.0}},
    )
    pesos = {p["symbol"]: p["peso_pct"] for p in cartera}
    # A vale 3.000 y B 1.000: 75 % / 25 % del libro.
    assert pesos == {"A": 75.0, "B": 25.0}
    assert {p["symbol"]: p["sector"] for p in cartera} == {"A": "Tech", "B": "Salud"}
    assert aviso is None


def test_una_posicion_que_este_barrido_no_cubre_se_declara():
    """Un tope calculado sobre media cartera es peor que ninguno si no sabes que
    le falta la otra mitad."""
    cartera, aviso = _cartera_actual(
        [señal("A", 1.0, "Tech", last=50.0)],
        {"A": {"quantity": 10}, "BTC-USD": {"quantity": 1}},
    )
    assert [p["symbol"] for p in cartera] == ["A"]
    assert "BTC-USD" in aviso
    assert "concentración real es mayor" in aviso


def test_el_sector_que_ya_tienes_recorta_las_ideas_nuevas_del_mismo_sector():
    """El fallo en producción: con un 20 % ya en tecnología, el dimensionador
    seguía autorizando otro 25 % del mismo sector."""
    señales = [señal(f"T{i}", 1.2 - i * 0.01, "Tech") for i in range(4)]
    señales.append(señal("VIEJA", -0.9, "Tech", last=100.0))

    sin_cartera = _lista_corta_dimensionada(señales)
    con_cartera = _lista_corta_dimensionada(señales, {"VIEJA": {"quantity": 10}})

    assert sin_cartera["sizing"]["ya_invertido_pct"] == 0.0
    # VIEJA es la única posición: ocupa el 100 % del libro y agota el tope.
    assert con_cartera["sizing"]["ya_invertido_pct"] == 100.0
    assert con_cartera["sizing"]["invertido_pct"] < sin_cartera["sizing"]["invertido_pct"]
    assert any("Tech" in x for x in con_cartera["sizing"]["recortes"])


def test_sin_posiciones_abiertas_la_lista_corta_no_cambia_de_forma():
    señales = [señal(f"S{i}", 1.2 - i * 0.01, f"Sec{i}") for i in range(4)]
    r = _lista_corta_dimensionada(señales, {})
    assert r["sizing"]["ya_invertido_pct"] == 0.0
    assert "aviso_cartera" not in r["sizing"]
    assert all(i["peso_final_pct"] is not None for i in r["ideas"])

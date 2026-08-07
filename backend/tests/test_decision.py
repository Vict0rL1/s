"""Tests del motor de decisión: qué hacer, a qué precio y cuándo salir."""

from __future__ import annotations

from app.analysis.decision import (
    RIESGO_POR_OPERACION,
    STOP_MAX_PCT,
    STOP_MIN_PCT,
    decide,
)


def señal(score, probability=None):
    return {"symbol": "TEST", "score": score, "probability": probability}


def precio(last=100.0, sma200=90.0, vol=1.2, **extra):
    return {
        "last": last,
        "sma200": sma200,
        "above_sma200": last > sma200 if sma200 else None,
        "daily_vol_pct": vol,
        "drawdown_pct": -5.0,
        **extra,
    }


# --- Sin posición: entrar, esperar o descartar --------------------------------


def test_comprar_exige_puntuacion_y_tendencia():
    d = decide(señal(0.8), precio(last=100, sma200=90))
    assert d["action"] == "comprar"
    assert d["levels"]["stop"] < 100 < d["levels"]["objetivo"]
    # La salida se define antes de entrar.
    assert any("Salir si" in t for t in d["triggers"])


def test_buena_empresa_en_tendencia_bajista_se_vigila_no_se_compra():
    """El filtro que evita comprar algo barato que sigue cayendo."""
    d = decide(señal(0.9), precio(last=80, sma200=100))
    assert d["action"] == "vigilar"
    assert any("recupere" in t or "encima de" in t for t in d["triggers"])


def test_puntuacion_baja_se_evita():
    d = decide(señal(-0.7), precio(last=100, sma200=90))
    assert d["action"] == "evitar"
    assert d["levels"] is None  # no se proponen niveles de algo que se descarta


def test_puntuacion_neutral_no_manda_actuar():
    """El montón tiene su propio estado: si cayera en 'vigilar', esa lista
    dejaría de servir para lo que existe."""
    d = decide(señal(0.1), precio())
    assert d["action"] == "ninguna"
    assert d["action"] != "vigilar"
    assert any("No hay motivo para actuar" in r for r in d["reasons"])


# --- Niveles: stop, objetivo y tamaño ----------------------------------------


def test_el_stop_se_dimensiona_por_volatilidad():
    tranquila = decide(señal(0.8), precio(vol=0.5))["levels"]
    nerviosa = decide(señal(0.8), precio(vol=3.0))["levels"]
    assert nerviosa["stop_pct"] > tranquila["stop_pct"]


def test_el_stop_esta_acotado_por_arriba_y_por_abajo():
    plana = decide(señal(0.8), precio(vol=0.01))["levels"]
    salvaje = decide(señal(0.8), precio(vol=20.0))["levels"]
    assert plana["stop_pct"] == STOP_MIN_PCT
    assert salvaje["stop_pct"] == STOP_MAX_PCT


def test_el_objetivo_respeta_la_relacion_riesgo_beneficio():
    niveles = decide(señal(0.8), precio())["levels"]
    assert niveles["objetivo_pct"] == niveles["stop_pct"] * niveles["ratio"]


def test_el_tamano_baja_cuando_el_stop_esta_lejos():
    """Arriesgar lo mismo en cada idea: stop lejano, posición pequeña."""
    cerca = decide(señal(0.8), precio(vol=0.5))["levels"]
    lejos = decide(señal(0.8), precio(vol=3.0))["levels"]
    assert lejos["peso_sugerido_pct"] < cerca["peso_sugerido_pct"]
    # El riesgo efectivo es el mismo en ambos casos.
    for n in (cerca, lejos):
        riesgo = n["peso_sugerido_pct"] / 100 * n["stop_pct"] / 100
        assert abs(riesgo - RIESGO_POR_OPERACION) < 0.0005


# --- Con posición abierta: sostener o soltar ---------------------------------


def test_vender_si_la_tesis_se_rompe():
    d = decide(señal(-0.5), precio(last=100, sma200=90), {"cost_basis": 80})
    assert d["action"] == "vender"
    assert any("ya no se sostiene" in r for r in d["reasons"])


def test_vender_si_el_precio_perfora_el_stop_de_tu_coste():
    # Coste 100, stop ~a un 11 % → 89. A 70 está claramente perforado.
    d = decide(señal(0.6), precio(last=70, sma200=60), {"cost_basis": 100})
    assert d["action"] == "vender"
    assert any("stop" in r for r in d["reasons"])


def test_reducir_si_pierde_la_tendencia_aunque_los_numeros_aguanten():
    d = decide(señal(0.6), precio(last=95, sma200=110), {"cost_basis": 90})
    assert d["action"] == "reducir"


def test_mantener_lo_que_va_bien_y_reportar_la_plusvalia():
    d = decide(señal(0.7), precio(last=120, sma200=100), {"cost_basis": 100})
    assert d["action"] == "mantener"
    assert d["pnl_pct"] == 20.0
    assert any("+20.00 %" in r for r in d["reasons"])


def test_una_posicion_siempre_lleva_sus_disparadores_de_salida():
    d = decide(señal(0.7), precio(last=120, sma200=100), {"cost_basis": 100})
    assert len(d["triggers"]) >= 2
    assert any("Vender si" in t for t in d["triggers"])


# --- Honestidad --------------------------------------------------------------


def test_sin_precio_no_se_decide():
    d = decide(señal(0.9), None)
    assert d["action"] == "sin_datos"
    assert d["levels"] is None


def test_sin_puntuacion_no_se_decide():
    d = decide(señal(None), precio())
    assert d["action"] == "sin_datos"


def test_la_confianza_distingue_reglas_validadas_de_solo_razonables():
    sin = decide(señal(0.8), precio())
    assert sin["confidence"] == "sin_calibrar"
    con = decide(señal(0.8, probability=0.61), precio())
    assert con["confidence"] == "calibrada"


def test_avisa_de_una_caida_fuerte_desde_maximos():
    d = decide(señal(0.8), precio(drawdown_pct=-40.0))
    assert any("por debajo de su máximo" in r for r in d["reasons"])

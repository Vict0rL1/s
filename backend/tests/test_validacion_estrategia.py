"""El informe de validación: todas las métricas, y un «no» cuando toca.

Fase 10 del RC1. No se prueba aquí si la estrategia gana dinero —eso exige
datos reales y este entorno no los tiene—, sino que el informe que lo diría
cuando se ejecute con datos reales:

- trae TODAS las métricas pedidas (CAGR, volatilidad, Sharpe, máxima caída,
  rotación, costes pagados, exposición),
- se compara contra un índice de referencia externo además de contra los
  baselines del propio universo,
- y dice «NO SUPERA AL BASELINE» cuando no lo supera, sin suavizarlo.

Los datos son sintéticos y deterministas a propósito: un test que dependiera
del mercado caducaría con el mercado.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.analysis import baselines


def _barras(ritmo_mensual: float, meses: int = 60, desde=date(2015, 1, 1)) -> dict:
    barras, p, d = [], 100.0, desde
    for _ in range(meses * 21):
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
        p *= (1 + ritmo_mensual) ** (1 / 21)
        barras.append({"ts": d.isoformat(), "close": round(p, 4)})
    return {"bars": barras}


def _fechas(meses=60, desde=date(2015, 2, 1)):
    return [date(desde.year + (desde.month - 1 + i) // 12, (desde.month - 1 + i) % 12 + 1, 1)
            for i in range(meses - 2)]


UNIVERSO = {"SUBE": _barras(0.02), "PLANA": _barras(0.0), "BAJA": _barras(-0.01)}


def test_la_simulacion_trae_todas_las_metricas_pedidas():
    r = baselines.simular_cartera(UNIVERSO, _fechas(), baselines.seleccion_equiponderada, 0.5)
    for clave in ("cagr_pct", "vol_pct", "sharpe", "max_drawdown_pct", "rotacion_media",
                  "costes_pagados_pct", "exposicion_media_pct", "n_periodos"):
        assert clave in r, f"falta {clave}"
    assert r["costes_pagados_pct"] > 0  # rebalancea: paga


def test_la_exposicion_mide_cuanto_tiempo_se_esta_invertido():
    """Una estrategia en liquidez la mitad del tiempo no puede reportar 100 %."""
    fechas = _fechas()

    def a_ratos(universo, as_of, primera):
        return ["SUBE"] if fechas.index(as_of) % 2 == 0 else []

    r = baselines.simular_cartera(UNIVERSO, fechas, a_ratos, 0.0)
    assert 40 <= r["exposicion_media_pct"] <= 60


def test_comprar_y_mantener_no_rota_ni_paga_despues_de_entrar():
    r = baselines.simular_cartera(UNIVERSO, _fechas(), baselines.seleccion_comprar_y_mantener, 0.5)
    assert r["costes_pagados_pct"] == pytest.approx(0.5, abs=0.01)  # solo la entrada


def test_se_compara_contra_un_indice_de_referencia_externo():
    """«Comprar y mantener» compra el MISMO universo, que ya viene filtrado por
    supervivencia. El índice externo es la vara que no comparte ese sesgo."""
    r = baselines.comparar(UNIVERSO, _fechas(), [], 0.5, referencia=_barras(0.01))
    assert "indice_referencia" in r["tabla"]
    assert r["tabla"]["indice_referencia"]["cagr_pct"] == pytest.approx(12.7, abs=0.5)


def test_una_estrategia_peor_que_no_hacer_nada_lo_dice_sin_adornos():
    """Estrategia: comprar solo lo que baja. El informe tiene que decir que no."""
    fechas = _fechas()
    operaciones = [{"symbol": "BAJA", "entrada_fecha": f.isoformat(),
                    "salida_fecha": (f + timedelta(days=25)).isoformat()} for f in fechas]
    r = baselines.comparar(UNIVERSO, fechas, operaciones, 0.5, referencia=_barras(0.01))
    assert r["tabla"]["estrategia"]["cagr_pct"] < r["tabla"]["comprar_y_mantener"]["cagr_pct"]
    assert "NO SUPERA AL BASELINE" in r["veredicto"]

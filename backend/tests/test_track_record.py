"""Tests del registro de aciertos — el módulo que mantiene honesta a la app."""

from datetime import datetime, timedelta, timezone

import pytest

from app.analysis.track_record import (
    classify_scenario,
    days_elapsed,
    track_record_summary,
)


def test_escenario_alcista_acertado():
    # Ancla 100, valor estimado 130 (+30 % implícito), precio hoy 120 (+20 %):
    # dirección alcista y el precio subió → acertado.
    result = classify_scenario(
        {"price_at_creation": 100.0, "value_mid": 130.0}, current_price=120.0
    )
    assert result["direction"] == "alcista"
    assert result["outcome"] == "acertado"
    assert result["implied_upside_pct"] == pytest.approx(0.30)
    assert result["price_change_pct"] == pytest.approx(0.20)
    # Error de estimación: |130 − 120| / 120 = 8.33 %
    assert result["estimate_error_pct"] == pytest.approx(10 / 120)


def test_escenario_alcista_fallido():
    result = classify_scenario(
        {"price_at_creation": 100.0, "value_mid": 130.0}, current_price=85.0
    )
    assert result["direction"] == "alcista"
    assert result["outcome"] == "fallido"
    assert result["price_change_pct"] == pytest.approx(-0.15)


def test_escenario_bajista_acertado():
    # Estimaba 70 sobre un precio de 100 (bajista) y el precio cayó a 80.
    result = classify_scenario(
        {"price_at_creation": 100.0, "value_mid": 70.0}, current_price=80.0
    )
    assert result["direction"] == "bajista"
    assert result["outcome"] == "acertado"


def test_escenario_bajista_fallido():
    result = classify_scenario(
        {"price_at_creation": 100.0, "value_mid": 70.0}, current_price=110.0
    )
    assert result["direction"] == "bajista"
    assert result["outcome"] == "fallido"


def test_sin_ancla_no_hay_veredicto():
    result = classify_scenario(
        {"price_at_creation": None, "value_mid": 130.0}, current_price=120.0
    )
    assert result["outcome"] is None
    assert result["direction"] is None
    assert "Faltan datos" in result["reason"]


def test_sin_precio_actual_no_hay_veredicto():
    result = classify_scenario(
        {"price_at_creation": 100.0, "value_mid": 130.0}, current_price=None
    )
    assert result["outcome"] is None


def test_escenario_neutral_no_se_puntua():
    # Estimación igual al precio de partida: no afirmaba dirección alguna.
    result = classify_scenario(
        {"price_at_creation": 100.0, "value_mid": 100.0}, current_price=150.0
    )
    assert result["direction"] == "neutral"
    assert result["outcome"] is None


def test_resumen_calcula_tasa_de_acierto():
    evaluados = [
        {"outcome": "acertado", "estimate_error_pct": 0.10},
        {"outcome": "acertado", "estimate_error_pct": 0.20},
        {"outcome": "fallido", "estimate_error_pct": 0.50},
        {"outcome": None, "estimate_error_pct": None},  # no evaluable
    ]
    summary = track_record_summary(evaluados)
    assert summary["total"] == 4
    assert summary["evaluable"] == 3
    assert summary["hits"] == 2
    assert summary["misses"] == 1
    assert summary["hit_rate"] == pytest.approx(2 / 3)
    assert summary["median_estimate_error_pct"] == pytest.approx(0.20)


def test_resumen_vacio_no_es_cero_ni_cien():
    summary = track_record_summary([])
    assert summary["hit_rate"] is None  # sin datos no hay tasa
    assert summary["total"] == 0


def test_resumen_solo_no_evaluables():
    summary = track_record_summary([{"outcome": None}, {"outcome": None}])
    assert summary["total"] == 2
    assert summary["evaluable"] == 0
    assert summary["hit_rate"] is None


def test_mediana_con_numero_par_de_errores():
    evaluados = [
        {"outcome": "acertado", "estimate_error_pct": 0.10},
        {"outcome": "fallido", "estimate_error_pct": 0.30},
    ]
    assert track_record_summary(evaluados)["median_estimate_error_pct"] == pytest.approx(0.20)


def test_dias_transcurridos():
    hace_30 = datetime.now(timezone.utc) - timedelta(days=30)
    assert days_elapsed(hace_30) == 30
    # Fecha futura (reloj desincronizado): nunca negativo.
    assert days_elapsed(datetime.now(timezone.utc) + timedelta(days=5)) == 0


def test_dias_transcurridos_con_fecha_naive():
    # SQLite devuelve datetimes sin tzinfo; se tratan como UTC.
    naive = (datetime.now(timezone.utc) - timedelta(days=10)).replace(tzinfo=None)
    assert days_elapsed(naive) == 10

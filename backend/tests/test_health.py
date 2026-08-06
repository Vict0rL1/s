"""Tests de Altman Z y Piotroski F contra casos construidos a mano."""

import pytest

from app.analysis.health import altman_z, health_snapshot, piotroski_f


def _period(**kwargs):
    base = {"fiscal_year": "2025", "end_date": "2025-12-31"}
    base.update(kwargs)
    return base


def test_altman_z_calculado_a_mano():
    # TA=1000, TL=400, CA=300, CL=200 (WC=100), RE=250, EBIT=150, ventas=900,
    # market cap=1200.
    #   Z = 1.2·(100/1000) + 1.4·(250/1000) + 3.3·(150/1000)
    #     + 0.6·(1200/400) + 1.0·(900/1000)
    #     = 0.12 + 0.35 + 0.495 + 1.8 + 0.9 = 3.665  → zona segura
    period = _period(
        total_assets=1000.0,
        total_liabilities=400.0,
        current_assets=300.0,
        current_liabilities=200.0,
        retained_earnings=250.0,
        operating_income=150.0,
        revenue=900.0,
    )
    result = altman_z(period, market_cap=1200.0)
    assert result["score"] == pytest.approx(3.665)
    assert result["zone"] == "segura"
    assert result["components"]["x4_market_cap_over_liabilities"] == pytest.approx(3.0)


def test_altman_z_zona_de_riesgo():
    period = _period(
        total_assets=1000.0,
        total_liabilities=900.0,
        current_assets=100.0,
        current_liabilities=400.0,  # WC negativo
        retained_earnings=-200.0,
        operating_income=10.0,
        revenue=500.0,
    )
    result = altman_z(period, market_cap=100.0)
    assert result["score"] < 1.81
    assert result["zone"] == "riesgo"


def test_altman_z_sin_datos_no_inventa():
    result = altman_z(_period(total_assets=1000.0), market_cap=None)
    assert result["score"] is None
    assert result["zone"] is None
    # El desglose muestra qué componente faltó.
    assert result["components"]["x4_market_cap_over_liabilities"] is None


def test_piotroski_empresa_que_mejora_en_todo():
    prev = _period(
        fiscal_year="2024",
        net_income=50.0, total_assets=1000.0, cfo=60.0,
        long_term_debt=300.0, current_assets=200.0, current_liabilities=100.0,
        shares_outstanding=100.0, gross_profit=400.0, revenue=900.0,
    )
    curr = _period(
        fiscal_year="2025",
        net_income=90.0, total_assets=1050.0, cfo=120.0,   # ROA sube, CFO>NI
        long_term_debt=250.0,                               # deuda baja
        current_assets=260.0, current_liabilities=110.0,    # ratio corriente sube
        shares_outstanding=100.0,                           # sin dilución
        gross_profit=480.0, revenue=1000.0,                 # margen y rotación suben
    )
    result = piotroski_f([prev, curr])
    assert result["score"] == 9
    assert result["max_possible"] == 9


def test_piotroski_empresa_que_empeora():
    prev = _period(
        fiscal_year="2024",
        net_income=90.0, total_assets=1000.0, cfo=100.0,
        long_term_debt=200.0, current_assets=300.0, current_liabilities=100.0,
        shares_outstanding=100.0, gross_profit=450.0, revenue=1000.0,
    )
    curr = _period(
        fiscal_year="2025",
        net_income=-20.0, total_assets=1100.0, cfo=-30.0,  # CFO < NI: falla también la señal de devengos
        long_term_debt=350.0, current_assets=250.0, current_liabilities=150.0,
        shares_outstanding=120.0, gross_profit=380.0, revenue=950.0,
    )
    result = piotroski_f([prev, curr])
    assert result["score"] == 0
    assert result["max_possible"] == 9


def test_piotroski_datos_incompletos_no_penalizan():
    # Sin datos de deuda ni márgenes: esas señales quedan como None y
    # max_possible baja — datos incompletos ≠ mala salud.
    prev = _period(fiscal_year="2024", net_income=50.0, total_assets=1000.0, cfo=60.0)
    curr = _period(fiscal_year="2025", net_income=80.0, total_assets=1000.0, cfo=90.0)
    result = piotroski_f([prev, curr])
    assert result["max_possible"] == 4  # ROA>0, CFO>0, ΔROA, CFO>NI
    assert result["score"] == 4
    sin_datos = [s for s in result["signals"] if s["passed"] is None]
    assert len(sin_datos) == 5


def test_piotroski_necesita_dos_ejercicios():
    result = piotroski_f([_period(net_income=1.0)])
    assert result["score"] is None


def test_snapshot_cobertura_de_intereses_calculada_a_mano():
    periods = [
        _period(
            operating_income=200.0,
            interest_expense=25.0,
            long_term_debt=300.0,
            short_term_debt=50.0,
            cash=120.0,
            cfo=180.0,
            capex=60.0,
        )
    ]
    snap = health_snapshot(periods, market_cap=None)
    assert snap["interest_coverage"] == pytest.approx(8.0)   # 200 / 25
    assert snap["net_debt"] == pytest.approx(230.0)          # 350 − 120
    assert snap["fcf"] == pytest.approx(120.0)               # 180 − 60

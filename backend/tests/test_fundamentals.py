"""Tests de ratios derivados, CAGR y parsing de companyfacts de EDGAR."""

import pytest

from app.analysis.fundamentals import (
    cagr,
    derive_ratio_series,
    free_cash_flow,
    growth_summary,
)
from app.providers.edgar import parse_companyfacts


def test_ratios_calculados_a_mano():
    period = {
        "fiscal_year": "2025",
        "end_date": "2025-12-31",
        "revenue": 1000.0,
        "gross_profit": 400.0,
        "operating_income": 250.0,
        "net_income": 180.0,
        "total_assets": 2000.0,
        "equity": 800.0,
        "current_assets": 500.0,
        "current_liabilities": 250.0,
        "long_term_debt": 300.0,
        "short_term_debt": 100.0,
        "cash": 200.0,
        "interest_expense": 50.0,
        "cfo": 260.0,
        "capex": 60.0,
    }
    ratios = derive_ratio_series([period])[0]
    assert ratios["gross_margin"] == pytest.approx(0.40)
    assert ratios["operating_margin"] == pytest.approx(0.25)
    assert ratios["net_margin"] == pytest.approx(0.18)
    assert ratios["roa"] == pytest.approx(0.09)
    assert ratios["roe"] == pytest.approx(0.225)
    # ROIC = 250·(1−0.21) / (800 + 400 − 200) = 197.5 / 1000 = 0.1975
    assert ratios["roic"] == pytest.approx(0.1975)
    assert ratios["current_ratio"] == pytest.approx(2.0)
    assert ratios["debt_to_equity"] == pytest.approx(0.5)
    assert ratios["interest_coverage"] == pytest.approx(5.0)
    assert ratios["fcf"] == pytest.approx(200.0)
    assert ratios["fcf_margin"] == pytest.approx(0.20)


def test_ratios_sin_datos_devuelven_none():
    ratios = derive_ratio_series([{"fiscal_year": "2025", "revenue": 100.0}])[0]
    assert ratios["roe"] is None
    assert ratios["debt_to_equity"] is None
    assert ratios["fcf"] is None


def test_cagr_calculado_a_mano():
    # 100 → 200 en 5 años: CAGR = 2^(1/5) − 1 ≈ 14.87 %
    assert cagr(100.0, 200.0, 5) == pytest.approx(0.148698, rel=1e-4)


def test_cagr_no_definido_con_negativos():
    assert cagr(-50.0, 100.0, 5) is None
    assert cagr(100.0, -50.0, 5) is None
    assert cagr(None, 100.0, 5) is None


def test_growth_summary_usa_hasta_5_ejercicios():
    periods = [
        {"fiscal_year": str(2019 + i), "revenue": 100.0 * (1.10**i), "cfo": 10.0 * (1.10**i)}
        for i in range(7)
    ]
    growth = growth_summary(periods)
    assert growth["years"] == 5
    assert growth["revenue_cagr"] == pytest.approx(0.10, rel=1e-6)
    assert growth["fcf_cagr"] == pytest.approx(0.10, rel=1e-6)


def test_free_cash_flow_sin_capex_usa_cfo():
    assert free_cash_flow({"cfo": 100.0}) == pytest.approx(100.0)
    assert free_cash_flow({}) is None


# ---------------------------------------------------------------------------
# Parsing de companyfacts (fixture mínimo con la estructura real de EDGAR)
# ---------------------------------------------------------------------------


def _fact(tag_entries):
    return {"units": {"USD": tag_entries}}


def test_parse_companyfacts_extrae_anuales_y_descarta_trimestres():
    facts = {
        "entityName": "Test Corp",
        "facts": {
            "us-gaap": {
                "Revenues": _fact(
                    [
                        # Anual FY2023 (10-K, ~365 días) → se queda
                        {"start": "2023-01-01", "end": "2023-12-31", "val": 900,
                         "fy": 2023, "fp": "FY", "form": "10-K"},
                        # Trimestre (10-Q) → fuera
                        {"start": "2024-01-01", "end": "2024-03-31", "val": 250,
                         "fy": 2024, "fp": "Q1", "form": "10-Q"},
                        # Anual FY2024 → se queda
                        {"start": "2024-01-01", "end": "2024-12-31", "val": 1000,
                         "fy": 2024, "fp": "FY", "form": "10-K"},
                        # Duración de 2 años (acumulado) → fuera aunque diga FY
                        {"start": "2023-01-01", "end": "2024-12-31", "val": 1900,
                         "fy": 2024, "fp": "FY", "form": "10-K"},
                    ]
                ),
                "Assets": _fact(
                    [
                        {"end": "2023-12-31", "val": 1800, "fy": 2023, "fp": "FY", "form": "10-K"},
                        {"end": "2024-12-31", "val": 2000, "fy": 2024, "fp": "FY", "form": "10-K"},
                    ]
                ),
                "NetIncomeLoss": _fact(
                    [
                        {"start": "2024-01-01", "end": "2024-12-31", "val": 180,
                         "fy": 2024, "fp": "FY", "form": "10-K"},
                    ]
                ),
            },
            "dei": {
                "EntityCommonStockSharesOutstanding": {
                    "units": {
                        "shares": [
                            {"end": "2024-12-31", "val": 500, "fy": 2024, "fp": "FY", "form": "10-K"}
                        ]
                    }
                }
            },
        },
    }
    periods = parse_companyfacts(facts)
    years = [p["fiscal_year"] for p in periods]
    assert years == ["2023", "2024"]
    p2024 = periods[-1]
    assert p2024["revenue"] == 1000
    assert p2024["total_assets"] == 2000
    assert p2024["net_income"] == 180
    assert p2024["shares_outstanding"] == 500
    # 2023 no tiene net_income en el fixture: ausente, no inventado.
    assert "net_income" not in periods[0]


def test_parse_companyfacts_prefiere_primera_etiqueta_con_datos():
    facts = {
        "facts": {
            "us-gaap": {
                # La etiqueta preferida está vacía → cae a "Revenues".
                "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {}},
                "Revenues": _fact(
                    [
                        {"start": "2024-01-01", "end": "2024-12-31", "val": 777,
                         "fy": 2024, "fp": "FY", "form": "10-K"},
                    ]
                ),
            },
            "dei": {},
        }
    }
    periods = parse_companyfacts(facts)
    assert periods[0]["revenue"] == 777


def test_parse_companyfacts_vacio():
    assert parse_companyfacts({"facts": {}}) == []

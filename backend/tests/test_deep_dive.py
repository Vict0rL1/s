"""Tests del informe de analista y de la valoración contra su propia historia."""

from datetime import date, timedelta

import pytest

from app.analysis.deep_dive import (
    build_verdict,
    cash_flow_section,
    debt_section,
    growth_section,
    margins_section,
    risks_section,
)
from app.analysis.fundamentals import derive_ratio_series
from app.analysis.valuation_history import (
    historical_multiples,
    percentile_rank,
    valuation_vs_history,
)


def _periods(n=6, revenue0=1000.0, growth=0.10, margin=0.20, eps0=2.0):
    out = []
    for i in range(n):
        revenue = revenue0 * (1 + growth) ** i
        out.append(
            {
                "fiscal_year": str(2018 + i),
                "end_date": f"{2018 + i}-12-31",
                "revenue": revenue,
                "gross_profit": revenue * 0.5,
                "operating_income": revenue * margin,
                "net_income": revenue * margin * 0.75,
                "eps_diluted": eps0 * (1 + growth) ** i,
                "equity": revenue * 0.8,
                "total_assets": revenue * 2,
                "total_liabilities": revenue * 1.2,
                "current_assets": revenue * 0.6,
                "current_liabilities": revenue * 0.3,
                "long_term_debt": revenue * 0.4,
                "short_term_debt": revenue * 0.1,
                "cash": revenue * 0.2,
                "retained_earnings": revenue * 0.5,
                "interest_expense": revenue * 0.02,
                "cfo": revenue * margin * 0.9,
                "capex": revenue * 0.05,
                "shares_outstanding": 100.0,
            }
        )
    return out


def _bars(start: date, days: int, price0: float, drift: float = 0.0):
    return [
        {"ts": (start + timedelta(days=i)).isoformat(), "close": price0 * (1 + drift) ** i}
        for i in range(days)
    ]


# ---------------------------------------------------------------------------
# Valoración contra su propia historia
# ---------------------------------------------------------------------------


def test_percentil_calculado_a_mano():
    valores = [10.0, 20.0, 30.0, 40.0]
    assert percentile_rank(valores, 5.0) == pytest.approx(0.0)
    assert percentile_rank(valores, 35.0) == pytest.approx(0.75)
    assert percentile_rank(valores, 50.0) == pytest.approx(1.0)
    # Empate: cuenta como medio.
    assert percentile_rank(valores, 20.0) == pytest.approx(0.375)


def test_serie_historica_de_multiplos():
    periods = _periods(6)
    filings = [{"type": "10-K", "filed_at": f"{2019 + i}-02-15"} for i in range(6)]
    bars = _bars(date(2019, 1, 1), 1800, 40.0, drift=0.0005)
    series = historical_multiples(periods, filings, bars, years=10)

    assert len(series["pe"]) >= 12  # una muestra por mes
    assert all(p["value"] > 0 for p in series["pe"])
    assert all(p["value"] > 0 for p in series["pb"])


def test_multiplos_omiten_eps_negativo():
    periods = _periods(6)
    for p in periods:
        p["eps_diluted"] = -1.0  # empresa en pérdidas
    filings = [{"type": "10-K", "filed_at": f"{2019 + i}-02-15"} for i in range(6)]
    series = historical_multiples(periods, filings, _bars(date(2019, 1, 1), 1500, 40.0), 10)
    assert series["pe"] == []  # un P/E negativo no es un múltiplo, es ruido


def test_precio_alto_hoy_cae_en_percentil_caro():
    periods = _periods(6)
    filings = [{"type": "10-K", "filed_at": f"{2019 + i}-02-15"} for i in range(6)]
    bars = _bars(date(2019, 1, 1), 1800, 40.0)  # precio plano durante la historia

    # Precio actual muy por encima de su rango → poco "barato".
    caro = valuation_vs_history(periods, filings, bars, current_price=500.0)
    assert caro["multiples"]["pe"]["available"] is True
    assert caro["cheapness_score"] < 0.3
    assert "parte alta" in caro["reading"]

    barato = valuation_vs_history(periods, filings, bars, current_price=5.0)
    assert barato["cheapness_score"] > 0.7
    assert "parte baja" in barato["reading"]


def test_serie_corta_no_publica_rango():
    periods = _periods(2)
    filings = [{"type": "10-K", "filed_at": "2019-02-15"}]
    bars = _bars(date(2019, 1, 1), 120, 40.0)  # ~4 meses
    result = valuation_vs_history(periods, filings, bars, current_price=40.0)
    assert result["multiples"]["pe"]["available"] is False
    assert "mínimo" in result["multiples"]["pe"]["reason"]


def test_advierte_del_value_trap():
    result = valuation_vs_history(_periods(6), [], _bars(date(2019, 1, 1), 1500, 40.0), 40.0)
    texto = " ".join(result["caveats"])
    assert "declive estructural" in texto
    assert "infravalorada" in texto


# ---------------------------------------------------------------------------
# Secciones del informe
# ---------------------------------------------------------------------------


def test_crecimiento_detecta_aceleracion():
    # Crecimiento uniforme del 10 %: 3A y 5A coinciden → estable.
    growth = growth_section(_periods(6, growth=0.10))
    assert growth["revenue_cagr"] == pytest.approx(0.10, abs=1e-6)
    assert growth["revenue_cagr_3y"] == pytest.approx(0.10, abs=1e-6)
    assert growth["acceleration"] == "estable"
    assert "crecimiento moderado" in growth["reading"]


def test_crecimiento_negativo_se_llama_por_su_nombre():
    growth = growth_section(_periods(6, growth=-0.08))
    assert growth["revenue_cagr"] < 0
    assert "contracción" in growth["reading"]


def test_margenes_detectan_deterioro():
    periods = _periods(8)
    # Márgenes que caen a lo largo del tiempo.
    for i, p in enumerate(periods):
        p["operating_income"] = p["revenue"] * (0.30 - i * 0.03)
    ratios = derive_ratio_series(periods)
    margins = margins_section(ratios)
    assert margins["trends"]["operating_margin"] == "deteriorándose"


def test_margenes_estables_no_dan_falsa_alarma():
    ratios = derive_ratio_series(_periods(8, margin=0.20))
    assert margins_section(ratios)["trends"]["operating_margin"] == "estable"


def test_deuda_reporta_cobertura_y_zona():
    periods = _periods(6)
    ratios = derive_ratio_series(periods)
    debt = debt_section(periods, ratios, market_cap=5000.0)
    assert debt["interest_coverage"] is not None
    assert debt["altman_z"]["score"] is not None
    assert "cobertura de intereses" in debt["reading"]


def test_flujo_de_caja_calcula_conversion():
    periods = _periods(6)
    ratios = derive_ratio_series(periods)
    cash = cash_flow_section(periods, ratios)
    latest = cash["current"]
    # CFO = ingresos×0.20×0.9 = 0.18·R; capex = 0.05·R → FCF = 0.13·R
    # Beneficio neto = 0.15·R → conversión = 0.13/0.15 ≈ 0.867
    assert latest["fcf_conversion"] == pytest.approx(0.13 / 0.15, rel=1e-6)
    assert latest["capex_intensity"] == pytest.approx(0.05, rel=1e-6)


def test_fcf_negativo_se_declara():
    periods = _periods(3)
    for p in periods:
        p["capex"] = p["revenue"] * 2  # capex desmedido
    cash = cash_flow_section(periods, derive_ratio_series(periods))
    assert cash["current"]["fcf"] < 0
    assert "consume caja" in cash["reading"]


# ---------------------------------------------------------------------------
# Riesgos y veredicto
# ---------------------------------------------------------------------------


def test_riesgos_detectan_apalancamiento_y_ordenan_por_gravedad():
    periods = _periods(6)
    for p in periods:
        p["long_term_debt"] = p["equity"] * 4  # muy apalancada
        p["interest_expense"] = p["operating_income"] * 0.9  # cobertura ~1.1×
    ratios = derive_ratio_series(periods)
    risks = risks_section(periods, ratios, None, {"cheapness_score": 0.5})

    tipos = {r["type"] for r in risks}
    assert "Apalancamiento" in tipos
    assert "Cobertura de intereses" in tipos
    assert risks[0]["severity"] == "alto"  # los graves van primero
    assert all(r["evidence"] and r["why"] for r in risks)


def test_empresa_sana_no_genera_riesgos_falsos():
    periods = _periods(6)
    for p in periods:
        p["long_term_debt"] = p["equity"] * 0.1
        p["short_term_debt"] = 0.0
        p["interest_expense"] = p["operating_income"] * 0.02
    ratios = derive_ratio_series(periods)
    risks = risks_section(periods, ratios, None, {"cheapness_score": 0.5})
    assert risks == []


def test_valoracion_exigente_es_un_riesgo():
    ratios = derive_ratio_series(_periods(6))
    risks = risks_section(_periods(6), ratios, None, {"cheapness_score": 0.1})
    assert any(r["type"] == "Valoración exigente" for r in risks)


def test_veredicto_constructivo_cuando_los_datos_acompanan():
    verdict = build_verdict(
        signal={"label": "favorable", "score": 1.2},
        valuation={"cheapness_score": 0.8},
        growth={"revenue_cagr": 0.12},
        debt={"interest_coverage": 12.0, "altman_z": {"zone": "segura"}},
        margins={"current": {"operating_margin": 0.25}, "trends": {"operating_margin": "estable"}},
    )
    assert verdict["stance"] == "constructiva"
    assert len(verdict["positives"]) > len(verdict["negatives"])


def test_veredicto_cauteloso_con_datos_malos():
    verdict = build_verdict(
        signal={"label": "desfavorable", "score": -1.1},
        valuation={"cheapness_score": 0.15},
        growth={"revenue_cagr": -0.05},
        debt={"interest_coverage": 1.2, "altman_z": {"zone": "riesgo"}},
        margins={
            "current": {"operating_margin": 0.03},
            "trends": {"operating_margin": "deteriorándose"},
        },
    )
    assert verdict["stance"] == "cautelosa"
    assert "contracción" in " ".join(verdict["negatives"])


def test_veredicto_no_es_una_orden_de_compra():
    verdict = build_verdict(
        None, {"cheapness_score": 0.9}, {"revenue_cagr": 0.2},
        {"interest_coverage": 20.0}, {"current": {"operating_margin": 0.3}, "trends": {}},
    )
    # Ni la postura ni el resumen usan lenguaje de orden.
    assert verdict["stance"] in {"constructiva", "cautelosa", "mixta"}
    texto = (verdict["summary"] + verdict["disclaimer"]).lower()
    assert "no una recomendación de compra o venta" in texto
    # Y advierte del error clásico: buena empresa ≠ buena compra a cualquier precio.
    assert "mala compra al precio equivocado" in texto
    # Y siempre viaja con lo que la invalidaría.
    assert len(verdict["what_would_change_it"]) >= 4


def test_veredicto_incluye_el_value_trap_si_parece_barata():
    verdict = build_verdict(
        None, {"cheapness_score": 0.85}, {"revenue_cagr": 0.05},
        {"interest_coverage": 10.0}, {"current": {"operating_margin": 0.2}, "trends": {}},
    )
    assert any("value trap" in c for c in verdict["what_would_change_it"])

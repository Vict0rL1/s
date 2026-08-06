"""Tests del motor de factores: orientación, z-scores y compuesto."""

import pytest

from app.analysis.factors import (
    DEFAULT_WEIGHTS,
    build_raw_factors,
    composite_score,
    family_scores,
    score_to_percentile,
    winsorize,
    zscores,
)


def test_multiplos_se_invierten_a_rendimientos():
    raw = build_raw_factors({"pe_ttm": 20.0, "pb": 4.0})
    assert raw["earnings_yield"] == pytest.approx(0.05)  # 1/20
    assert raw["book_yield"] == pytest.approx(0.25)  # 1/4


def test_pe_negativo_no_es_barato():
    # Una empresa en pérdidas tiene P/E negativo; tratarlo como rendimiento
    # altísimo la pondría en cabeza del ranking de valor. Debe ser None.
    raw = build_raw_factors({"pe_ttm": -8.0})
    assert raw["earnings_yield"] is None
    assert build_raw_factors({"pe_ttm": 0.0})["earnings_yield"] is None


def test_apalancamiento_se_invierte():
    # Más deuda debe puntuar peor: el factor se guarda negado.
    assert build_raw_factors({"debt_to_equity": 2.0})["low_leverage"] == pytest.approx(-2.0)
    assert build_raw_factors({"debt_to_equity": 0.1})["low_leverage"] == pytest.approx(-0.1)
    assert build_raw_factors({})["low_leverage"] is None


def test_zscore_calculado_a_mano():
    # Valores 10, 20, 30: media 20, desviación muestral 10.
    result = zscores({"A": 10.0, "B": 20.0, "C": 30.0})
    assert result["A"] == pytest.approx(-1.0)
    assert result["B"] == pytest.approx(0.0)
    assert result["C"] == pytest.approx(1.0)


def test_zscore_mantiene_ausentes_como_none():
    result = zscores({"A": 10.0, "B": 20.0, "C": 30.0, "D": None})
    assert result["D"] is None
    assert result["A"] is not None


def test_zscore_necesita_tres_observaciones():
    # Con dos empresas, "estar por encima de la media" no significa nada.
    result = zscores({"A": 10.0, "B": 20.0})
    assert all(v is None for v in result.values())


def test_zscore_sin_dispersion_es_cero():
    result = zscores({"A": 5.0, "B": 5.0, "C": 5.0})
    assert all(v == 0.0 for v in result.values())


def test_winsorize_recorta_extremos():
    values = [1.0] + [5.0] * 18 + [1000.0]
    clipped = winsorize(values, limit=0.05)
    assert max(clipped) < 1000.0  # el outlier queda recortado
    assert len(clipped) == len(values)


def test_winsorize_no_toca_muestras_pequenas():
    values = [1.0, 2.0, 100.0]
    assert winsorize(values) == values


def test_outlier_no_domina_el_zscore():
    # Sin winsorización, un P/E absurdo aplastaría al resto contra la media.
    con_outlier = zscores({f"S{i}": 5.0 for i in range(19)} | {"X": 10000.0})
    normales = [v for k, v in con_outlier.items() if k != "X"]
    assert all(abs(v) < 3 for v in normales)


def test_familia_promedia_solo_lo_disponible():
    factor_z = {
        "roe": {"A": 1.0},
        "operating_margin": {"A": -1.0},
        "interest_coverage": {"A": None},
        "low_leverage": {"A": None},
    }
    families = family_scores(factor_z)
    assert families["quality"]["A"] == pytest.approx(0.0)  # media de 1 y −1


def test_familia_sin_datos_es_none():
    families = family_scores({"roe": {"A": None}, "operating_margin": {"A": None}})
    assert families["quality"]["A"] is None


def test_compuesto_ponderado_a_mano():
    # Todas las familias a 1.0 → compuesto 1.0 con cobertura total.
    result = composite_score({"value": 1.0, "quality": 1.0, "momentum": 1.0, "sentiment": 1.0})
    assert result["score"] == pytest.approx(1.0)
    assert result["coverage"] == pytest.approx(1.0)


def test_compuesto_renormaliza_con_familias_ausentes():
    # Solo valor (0.30) y calidad (0.30) disponibles: pesos renormalizados a
    # 0.5 cada uno → (0.5×2) + (0.5×0) = 1.0. Cobertura 0.6.
    result = composite_score(
        {"value": 2.0, "quality": 0.0, "momentum": None, "sentiment": None}
    )
    assert result["score"] == pytest.approx(1.0)
    assert result["coverage"] == pytest.approx(0.6)


def test_atribucion_suma_el_compuesto():
    result = composite_score({"value": 1.5, "quality": -0.5, "momentum": 1.0, "sentiment": 0.0})
    assert sum(result["contributions"].values()) == pytest.approx(result["score"])


def test_compuesto_sin_datos_no_puntua():
    result = composite_score({"value": None, "quality": None, "momentum": None, "sentiment": None})
    assert result["score"] is None
    assert result["coverage"] == 0.0


def test_pesos_por_defecto_suman_uno():
    assert sum(DEFAULT_WEIGHTS.values()) == pytest.approx(1.0)


def test_percentil_de_z_cero_es_la_mitad():
    assert score_to_percentile(0.0) == pytest.approx(0.5)
    assert score_to_percentile(1.645) == pytest.approx(0.95, abs=1e-3)

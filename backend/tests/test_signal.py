"""Tests de la señal: etiquetas, intervalos de Wilson y la regla de calibración.

La regla que más importa: sin observaciones suficientes NO se publica
probabilidad. Si este test se rompe, la app estaría inventando porcentajes.
"""

import pytest

from app.analysis.signal import (
    MIN_OBSERVATIONS,
    bucket_of,
    build_signal,
    calibrate,
    label_for,
    rank_universe,
    wilson_interval,
)


def test_etiquetas_por_umbral():
    assert label_for(1.5) == "muy favorable"
    assert label_for(0.5) == "favorable"
    assert label_for(0.0) == "neutral"
    assert label_for(-0.5) == "desfavorable"
    assert label_for(-1.5) == "muy desfavorable"
    assert label_for(None) == "sin datos"


def test_etiquetas_no_dicen_comprar_ni_vender():
    # La señal describe la puntuación del modelo, no una orden de operación.
    todas = {label_for(z) for z in (-2.0, -0.5, 0.0, 0.5, 2.0)}
    prohibidas = {"comprar", "vender", "compra", "venta"}
    for etiqueta in todas:
        assert not any(p in etiqueta.lower() for p in prohibidas)


def test_wilson_calculado_a_mano():
    # 7 aciertos de 10, z = 1.96. Derivación paso a paso:
    #   denom  = 1 + z²/n            = 1 + 3.8416/10      = 1.38416
    #   centro = (p + z²/2n) / denom = (0.7 + 0.19208)/1.38416 = 0.644497
    #   margen = z·√(p(1−p)/n + z²/4n²) / denom
    #          = 1.96·√(0.021 + 0.0096040) / 1.38416       = 0.247717
    #   → (0.396780, 0.892214)
    low, high = wilson_interval(7, 10)
    assert low == pytest.approx(0.396780, abs=1e-5)
    assert high == pytest.approx(0.892214, abs=1e-5)
    # Con n=10 el intervalo abarca medio punto porcentual de rango: por eso
    # MIN_OBSERVATIONS existe.
    assert (high - low) > 0.45


def test_wilson_nunca_se_sale_de_cero_uno():
    # Con 10 de 10, la aproximación normal daría un límite superior > 1.
    low, high = wilson_interval(10, 10)
    assert 0.0 <= low <= high <= 1.0
    low, high = wilson_interval(0, 5)
    assert 0.0 <= low <= high <= 1.0


def test_wilson_se_estrecha_con_mas_muestra():
    # Misma proporción (70 %), muestras de 10, 100 y 1000: el intervalo debe
    # encogerse monótonamente.
    anchos = [
        wilson_interval(hits, n)[1] - wilson_interval(hits, n)[0]
        for hits, n in [(7, 10), (70, 100), (700, 1000)]
    ]
    assert anchos[0] > anchos[1] > anchos[2]


def test_wilson_sin_muestra_es_ignorancia_total():
    assert wilson_interval(0, 0) == (0.0, 1.0)


def test_cubos_por_puntuacion():
    assert bucket_of(1.5) == "muy_alto"
    assert bucket_of(0.5) == "alto"
    assert bucket_of(0.0) == "medio"
    assert bucket_of(-0.5) == "bajo"
    assert bucket_of(-1.5) == "muy_bajo"


def test_calibracion_cuenta_aciertos_por_cubo():
    observaciones = (
        [{"score": 1.5, "outperformed": True} for _ in range(6)]
        + [{"score": 1.2, "outperformed": False} for _ in range(4)]
    )
    tabla = calibrate(observaciones)
    assert tabla["muy_alto"]["n"] == 10
    assert tabla["muy_alto"]["hits"] == 6
    assert tabla["muy_alto"]["rate"] == pytest.approx(0.6)
    assert tabla["muy_alto"]["reliable"] is False  # 10 < MIN_OBSERVATIONS


def test_calibracion_marca_fiable_con_muestra_suficiente():
    observaciones = [
        {"score": 1.5, "outperformed": i % 2 == 0} for i in range(MIN_OBSERVATIONS)
    ]
    tabla = calibrate(observaciones)
    assert tabla["muy_alto"]["reliable"] is True


def test_calibracion_ignora_observaciones_incompletas():
    tabla = calibrate(
        [
            {"score": None, "outperformed": True},
            {"score": 1.5, "outperformed": None},
            {"score": 1.5, "outperformed": True},
        ]
    )
    assert tabla["muy_alto"]["n"] == 1


# ---------------------------------------------------------------------------
# La regla central: sin calibración fiable, no hay probabilidad
# ---------------------------------------------------------------------------


def test_sin_calibracion_no_se_publica_probabilidad():
    signal = build_signal("AAPL", {"score": 1.5, "coverage": 1.0}, calibration=None)
    assert signal["label"] == "muy favorable"
    assert signal["probability"] is None  # ← la regla que sostiene la honestidad
    assert "sin calibrar" in signal["probability_note"]


def test_muestra_insuficiente_tampoco_publica_probabilidad():
    calibracion = calibrate([{"score": 1.5, "outperformed": True} for _ in range(5)])
    signal = build_signal("AAPL", {"score": 1.5, "coverage": 1.0}, calibracion)
    assert signal["probability"] is None
    assert signal["sample_size"] == 5
    assert str(MIN_OBSERVATIONS) in signal["probability_note"]


def test_con_calibracion_fiable_si_publica_probabilidad_con_intervalo():
    observaciones = [
        {"score": 1.5, "outperformed": i < 24} for i in range(40)  # 24 de 40 = 60 %
    ]
    calibracion = calibrate(observaciones)
    signal = build_signal("AAPL", {"score": 1.5, "coverage": 1.0}, calibracion)

    assert signal["probability"] == pytest.approx(0.6)
    low, high = signal["probability_ci"]
    assert low < 0.6 < high  # la incertidumbre viaja con el número
    assert signal["sample_size"] == 40
    assert "No es una predicción sobre esta empresa" in signal["probability_note"]


def test_senal_sin_puntuacion_no_inventa_nada():
    signal = build_signal("XYZ", {"score": None, "coverage": 0.0})
    assert signal["label"] == "sin datos"
    assert signal["probability"] is None


def test_senal_se_marca_como_calculada_no_generada_por_ia():
    signal = build_signal("AAPL", {"score": 1.0, "coverage": 1.0})
    assert signal["computed_by"] == "modelo cuantitativo"


def test_ranking_ordena_y_deja_las_no_puntuables_al_final():
    signals = [
        build_signal("A", {"score": 0.5, "coverage": 1.0}),
        build_signal("B", {"score": 2.0, "coverage": 1.0}),
        build_signal("C", {"score": None, "coverage": 0.0}),
        build_signal("D", {"score": -1.0, "coverage": 1.0}),
    ]
    ranked = rank_universe(signals)
    assert [s["symbol"] for s in ranked] == ["B", "A", "D", "C"]
    assert ranked[0]["rank"] == 1

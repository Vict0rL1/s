"""Pruebas del modelo: propiedades básicas que SIEMPRE deben cumplirse."""

import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.model.elo import EloModel, davidson_probs, margin_multiplier
from backend.model.poisson import PoissonModel
from backend.model.predictor import LeaguePredictor

PARAMS = {
    "blend_weight_poisson": 0.5,
    "decay_half_life_days": 365,
    "poisson": {"prior_matches": 6, "max_goals": 10},
    "elo": {"k": 20, "initial_rating": 1500, "new_team_rating": 1450, "season_regression": 0.1},
}


def synthetic_season(seed: int = 7):
    """Liga sintética: 'Fuerte' anota mucho, 'Débil' concede mucho, resto promedio.
    Devuelve filas (date, season, home, away, hg, ag)."""
    rng = random.Random(seed)
    teams = {"Fuerte": (2.4, 0.7), "Medio A": (1.3, 1.3), "Medio B": (1.3, 1.3), "Débil": (0.7, 2.2)}

    def sample_goals(lam):
        # Muestreo Poisson simple (Knuth) para el generador de datos.
        L, k, p = 2.718281828 ** (-lam), 0, 1.0
        while p > L:
            k += 1
            p *= rng.random()
        return k - 1

    rows = []
    day = 0
    for _round in range(10):  # 10 vueltas para tener señal clara
        for home in teams:
            for away in teams:
                if home == away:
                    continue
                day += 1
                # Fechas estrictamente cronológicas: cada par aparece en todas
                # las rondas, así el decaimiento temporal no favorece a nadie.
                d = (date(2025, 1, 1) + timedelta(days=day * 2)).isoformat()
                atk_h, df_h = teams[home]
                atk_a, df_a = teams[away]
                hg = sample_goals(0.5 * (atk_h + df_a) * 1.15)  # +15% ventaja local
                ag = sample_goals(0.5 * (atk_a + df_h))
                rows.append((d, "2025", home, away, hg, ag))
    return sorted(rows)


def test_poisson_probs_sum_to_one_and_favor_stronger():
    rows = synthetic_season()
    model = PoissonModel()
    model.fit([(d, h, a, hg, ag) for d, _s, h, a, hg, ag in rows], as_of="2026-01-01")

    pred = model.predict("Fuerte", "Débil")
    assert abs(pred.p_home + pred.p_draw + pred.p_away - 1.0) < 1e-9
    assert pred.p_home > 0.6 > pred.p_away
    assert pred.lambda_home > pred.lambda_away
    # El multiplicador de ataque de 'Fuerte' debe superar al de 'Débil'.
    assert model.attack["Fuerte"] > 1.2 > model.attack["Débil"]


def test_poisson_home_advantage_between_equal_teams():
    # Propiedad del modelo, sin ruido de muestreo: dos equipos IDÉNTICOS
    # (multiplicadores 1.0) solo se distinguen por μ_home > μ_away.
    model = PoissonModel()
    model.mu_home, model.mu_away = 1.5, 1.15
    model.attack = {"X": 1.0, "Y": 1.0}
    model.defense = {"X": 1.0, "Y": 1.0}
    pred = model.predict("X", "Y")
    assert pred.p_home > pred.p_away  # misma fuerza → el local es favorito

    # Y el ajuste debe APRENDER μ de los datos: con un dataset determinista
    # donde todo partido termina 2-1 al local, μ_home→2 y μ_away→1.
    rows = []
    day = 0
    teams = ["A", "B", "C", "D"]
    for _ in range(3):
        for h in teams:
            for a in teams:
                if h != a:
                    day += 1
                    rows.append(((date(2025, 1, 1) + timedelta(days=day * 2)).isoformat(), h, a, 2, 1))
    fitted = PoissonModel()
    fitted.fit(rows, as_of="2026-01-01")
    assert abs(fitted.mu_home - 2.0) < 1e-9
    assert abs(fitted.mu_away - 1.0) < 1e-9


def test_poisson_unknown_team_is_average():
    rows = synthetic_season()
    model = PoissonModel()
    model.fit([(d, h, a, hg, ag) for d, _s, h, a, hg, ag in rows], as_of="2026-01-01")
    lam_h, lam_a = model.expected_goals("Nuevo FC", "Medio A")
    assert 0.3 < lam_h < 3.0 and 0.3 < lam_a < 3.0


def test_margin_multiplier_grows_with_goal_difference():
    assert margin_multiplier(1) == 1.0
    assert margin_multiplier(-2) == 1.5
    assert margin_multiplier(3) == 1.75
    assert margin_multiplier(5) > margin_multiplier(4) > margin_multiplier(3)


def test_davidson_probs_sum_to_one_and_are_monotonic():
    for d in (-300, -100, 0, 100, 300):
        ph, pd, pa = davidson_probs(d, nu=1.0)
        assert abs(ph + pd + pa - 1.0) < 1e-12
    assert davidson_probs(200, 1.0)[0] > davidson_probs(0, 1.0)[0] > davidson_probs(-200, 1.0)[0]
    # El empate es máximo cuando los equipos están parejos.
    assert davidson_probs(0, 1.0)[1] > davidson_probs(300, 1.0)[1]


def test_elo_winner_gains_rating_and_margin_matters():
    base = [("2025-01-01", "2025", "A", "B", 1, 0)]
    m1 = EloModel()
    m1.fit(base, as_of="2025-06-01")
    gain_small = m1.ratings["A"] - 1500

    m2 = EloModel()
    m2.fit([("2025-01-01", "2025", "A", "B", 4, 0)], as_of="2025-06-01")
    gain_big = m2.ratings["A"] - 1500

    assert gain_small > 0
    assert gain_big > gain_small  # golear mueve más el rating


def test_elo_calibration_matches_observed_rates():
    rows = synthetic_season()
    model = EloModel()
    model.fit(rows, as_of="2026-01-01")
    # La frecuencia media predicha debe parecerse a la observada (calibración).
    n = len(rows)
    obs_home = sum(1 for r in rows if r[4] > r[5]) / n
    obs_draw = sum(1 for r in rows if r[4] == r[5]) / n
    preds = [model.predict(h, a) for _d, _s, h, a, _hg, _ag in rows]
    mean_home = sum(p.p_home for p in preds) / n
    mean_draw = sum(p.p_draw for p in preds) / n
    # Tolerancia amplia: la calibración usa el estado PRE-partido, aquí usamos el final.
    assert abs(mean_home - obs_home) < 0.08
    assert abs(mean_draw - obs_draw) < 0.05


def test_blend_is_between_components_and_sums_to_one():
    rows = synthetic_season()
    pred = LeaguePredictor("test", rows, PARAMS, as_of="2026-01-01").predict("Fuerte", "Débil")
    # Tolerancias de 4 decimales: los campos del resultado vienen redondeados.
    assert abs(sum(pred.probs.values()) - 1.0) < 2e-4
    lo = min(pred.poisson_probs["home"], pred.elo_probs["home"])
    hi = max(pred.poisson_probs["home"], pred.elo_probs["home"])
    assert lo - 2e-4 <= pred.probs["home"] <= hi + 2e-4
    assert pred.most_likely_score.count("-") == 1


def test_new_team_notes_warn_about_reliability():
    rows = synthetic_season()
    predictor = LeaguePredictor("test", rows, PARAMS, as_of="2026-01-01")
    pred = predictor.predict("Recién Ascendido", "Fuerte")
    assert any("historial" in n for n in pred.notes)

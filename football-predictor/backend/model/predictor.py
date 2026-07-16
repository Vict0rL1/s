"""Fachada del modelo: carga datos de SQLite, ajusta Poisson + Elo y mezcla.

La probabilidad final de cada resultado es un promedio ponderado de los dos
modelos (blend_weight_poisson en config/leagues.json, 0.5 por defecto):

    P(resultado) = w · P_poisson(resultado) + (1 − w) · P_elo(resultado)

El marcador más probable y los goles esperados provienen del modelo de
Poisson (el Elo no modela goles). IMPORTANTE: esto es una estimación
estadística basada solo en resultados históricos; ver MODEL.md#limitaciones.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from .. import config
from .elo import EloModel
from .poisson import PoissonModel


@dataclass
class Prediction:
    league_id: str
    home: str
    away: str
    probs: dict            # {'home': .., 'draw': .., 'away': ..}  (mezcla final, suma 1)
    poisson_probs: dict
    elo_probs: dict
    expected_goals: dict   # {'home': λ_h, 'away': λ_a, 'total': λ_h+λ_a}
    most_likely_score: str          # p. ej. '2-1'
    top_scorelines: list            # [{'score': '2-1', 'prob': ..}, ...]
    elo_ratings: dict      # {'home': .., 'away': .., 'home_advantage': ..}
    notes: list = field(default_factory=list)  # avisos de fiabilidad


class LeaguePredictor:
    """Modelos ajustados de UNA liga, listos para predecir cualquier cruce."""

    def __init__(self, league_id: str, played_matches: list, params: dict,
                 as_of: str | date | None = None):
        """`played_matches`: filas (date, season, home, away, hg, ag) en orden
        cronológico. `params`: bloque "model" de config/leagues.json."""
        self.league_id = league_id
        self.blend_w = params.get("blend_weight_poisson", 0.5)
        half_life = params.get("decay_half_life_days", 365)
        p_cfg = params.get("poisson", {})
        e_cfg = params.get("elo", {})

        self.n_matches = len(played_matches)
        self.last_date = played_matches[-1][0] if played_matches else None

        self.poisson = PoissonModel(
            half_life_days=half_life,
            prior_matches=p_cfg.get("prior_matches", 6),
            max_goals=p_cfg.get("max_goals", 10),
        )
        self.poisson.fit([(d, h, a, hg, ag) for d, _s, h, a, hg, ag in played_matches], as_of=as_of)

        self.elo = EloModel(
            k=e_cfg.get("k", 20),
            initial_rating=e_cfg.get("initial_rating", 1500),
            new_team_rating=e_cfg.get("new_team_rating", 1450),
            season_regression=e_cfg.get("season_regression", 0.1),
            half_life_days=half_life,
        )
        self.elo.fit(played_matches, as_of=as_of)

        self.teams = sorted(self.elo.ratings.keys())

    def predict(self, home: str, away: str) -> Prediction:
        if home == away:
            raise ValueError("Un equipo no puede jugar contra sí mismo")

        pois = self.poisson.predict(home, away)
        elo = self.elo.predict(home, away)
        w = self.blend_w

        blended = {
            "home": w * pois.p_home + (1 - w) * elo.p_home,
            "draw": w * pois.p_draw + (1 - w) * elo.p_draw,
            "away": w * pois.p_away + (1 - w) * elo.p_away,
        }
        total = sum(blended.values())
        blended = {k: v / total for k, v in blended.items()}

        notes = []
        for team in (home, away):
            # ~5 partidos recientes de peso efectivo: por debajo, el equipo es
            # casi un desconocido para el modelo (típico recién ascendido).
            if self.poisson.matches_weight.get(team, 0.0) < 5.0:
                notes.append(f"{team} tiene poco historial en esta liga; su estimación es poco fiable.")

        best = pois.top_scorelines[0]
        return Prediction(
            league_id=self.league_id,
            home=home,
            away=away,
            probs={k: round(v, 4) for k, v in blended.items()},
            poisson_probs={"home": round(pois.p_home, 4), "draw": round(pois.p_draw, 4), "away": round(pois.p_away, 4)},
            elo_probs={"home": round(elo.p_home, 4), "draw": round(elo.p_draw, 4), "away": round(elo.p_away, 4)},
            expected_goals={
                "home": round(pois.lambda_home, 2),
                "away": round(pois.lambda_away, 2),
                "total": round(pois.lambda_home + pois.lambda_away, 2),
            },
            most_likely_score=f"{best[0]}-{best[1]}",
            top_scorelines=[{"score": f"{i}-{j}", "prob": round(p, 4)} for i, j, p in pois.top_scorelines],
            elo_ratings={
                "home": round(elo.home_rating, 0),
                "away": round(elo.away_rating, 0),
                "home_advantage": round(elo.home_advantage, 0),
            },
            notes=notes,
        )


def load_played_matches(conn, league_id: str, before: str | None = None) -> list:
    """Partidos jugados de una liga en orden cronológico.
    `before`: si se indica (ISO), solo partidos ANTERIORES a esa fecha —
    lo usa el backtest para no ver el futuro."""
    sql = """
        SELECT date, season, home_team, away_team, home_goals, away_goals
        FROM matches
        WHERE league_id = ? AND home_goals IS NOT NULL
    """
    args: list = [league_id]
    if before:
        sql += " AND date < ?"
        args.append(before)
    sql += " ORDER BY date, id"
    return [tuple(r) for r in conn.execute(sql, args).fetchall()]


def build_predictor(conn, league_id: str, as_of: str | date | None = None,
                    before: str | None = None) -> LeaguePredictor:
    if config.get_league(league_id) is None:
        raise KeyError(f"Liga desconocida: {league_id}")
    matches = load_played_matches(conn, league_id, before=before)
    if not matches:
        raise ValueError(f"No hay partidos jugados para la liga {league_id}; corre scripts/update_data.py")
    return LeaguePredictor(league_id, matches, config.model_params(), as_of=as_of)

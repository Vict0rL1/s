"""Modelo de Poisson para goles esperados.

Idea (ver MODEL.md para la explicación completa):

  goles esperados del local  λ_h = μ_home · ataque(local)  · defensa(visitante)
  goles esperados de visita  λ_a = μ_away · ataque(visita) · defensa(local)

donde μ_home/μ_away son los promedios de gol de la liga (la ventaja de local
queda capturada en que μ_home > μ_away) y ataque/defensa son multiplicadores
por equipo (1.0 = equipo promedio; ataque 1.3 = anota 30% más que el promedio;
defensa 0.8 = concede 20% menos).

Los parámetros se estiman del historial con DECAIMIENTO TEMPORAL: cada partido
pesa 0.5^(edad_en_días / half_life), así un partido de hace un año pesa la
mitad que uno de ayer y el modelo sigue la forma actual de los equipos.

Con λ_h y λ_a, el marcador (i, j) tiene probabilidad Poisson(i; λ_h)·Poisson(j; λ_a)
(independencia entre ambos marcadores: simplificación conocida del enfoque).
Sumando la matriz de marcadores se obtienen P(local), P(empate), P(visita).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime


def _to_date(value: str | date) -> date:
    if isinstance(value, date):
        return value
    return datetime.strptime(value, "%Y-%m-%d").date()


def poisson_pmf_row(lam: float, max_goals: int) -> list[float]:
    """P(X = 0..max_goals) para X ~ Poisson(lam), calculada iterativamente."""
    row = [math.exp(-lam)]
    for k in range(1, max_goals + 1):
        row.append(row[-1] * lam / k)
    return row


@dataclass
class PoissonPrediction:
    p_home: float
    p_draw: float
    p_away: float
    lambda_home: float
    lambda_away: float
    top_scorelines: list = field(default_factory=list)  # [(goles_local, goles_visita, prob), ...]


class PoissonModel:
    def __init__(self, half_life_days: float = 365.0, prior_matches: float = 6.0,
                 max_goals: int = 10, iterations: int = 30):
        self.half_life_days = half_life_days
        self.prior_matches = prior_matches   # regularización: nº de "partidos promedio" ficticios
        self.max_goals = max_goals
        self.iterations = iterations
        self.mu_home = 1.4
        self.mu_away = 1.1
        self.attack: dict[str, float] = {}
        self.defense: dict[str, float] = {}
        self.matches_weight: dict[str, float] = {}   # peso efectivo de datos por equipo

    # ------------------------------------------------------------------ fit
    def fit(self, matches, as_of: str | date | None = None) -> None:
        """`matches`: iterable de (date, home, away, home_goals, away_goals),
        solo partidos jugados. `as_of`: fecha de referencia del decaimiento."""
        ref = _to_date(as_of) if as_of else date.today()

        data = []
        for d, home, away, hg, ag in matches:
            age_days = max(0, (ref - _to_date(d)).days)
            w = 0.5 ** (age_days / self.half_life_days)
            data.append((w, home, away, hg, ag))
        if not data:
            raise ValueError("No hay partidos jugados para ajustar el modelo")

        total_w = sum(w for w, *_ in data)
        self.mu_home = sum(w * hg for w, _, _, hg, _ in data) / total_w
        self.mu_away = sum(w * ag for w, _, _, _, ag in data) / total_w
        mu_avg = (self.mu_home + self.mu_away) / 2

        teams = {t for _, h, a, _, _ in data for t in (h, a)}
        attack = {t: 1.0 for t in teams}
        defense = {t: 1.0 for t in teams}
        # Pseudo-goles del prior: equivalen a `prior_matches` partidos de un
        # equipo exactamente promedio, y encogen los multiplicadores hacia 1.0
        # cuando hay pocos datos (equipos recién ascendidos).
        pseudo = self.prior_matches * mu_avg

        for _ in range(self.iterations):
            goals_for = {t: pseudo for t in teams}
            exp_for = {t: pseudo for t in teams}
            goals_against = {t: pseudo for t in teams}
            exp_against = {t: pseudo for t in teams}
            for w, h, a, hg, ag in data:
                lam_h = self.mu_home * attack[h] * defense[a]
                lam_a = self.mu_away * attack[a] * defense[h]
                goals_for[h] += w * hg;  exp_for[h] += w * lam_h
                goals_for[a] += w * ag;  exp_for[a] += w * lam_a
                goals_against[h] += w * ag;  exp_against[h] += w * lam_a
                goals_against[a] += w * hg;  exp_against[a] += w * lam_h
            # Actualización multiplicativa: si un equipo anota más de lo que el
            # modelo espera, su ataque sube en proporción (ídem defensa).
            for t in teams:
                attack[t] *= goals_for[t] / exp_for[t]
                defense[t] *= goals_against[t] / exp_against[t]
            # Normalización (identifiabilidad): el multiplicador promedio es 1.
            mean_a = sum(attack.values()) / len(teams)
            mean_d = sum(defense.values()) / len(teams)
            for t in teams:
                attack[t] /= mean_a
                defense[t] /= mean_d

        self.attack, self.defense = attack, defense
        self.matches_weight = {t: 0.0 for t in teams}
        for w, h, a, *_ in data:
            self.matches_weight[h] += w
            self.matches_weight[a] += w

    # -------------------------------------------------------------- predict
    def expected_goals(self, home: str, away: str) -> tuple[float, float]:
        """Equipos sin historial usan multiplicadores 1.0 (equipo promedio)."""
        lam_h = self.mu_home * self.attack.get(home, 1.0) * self.defense.get(away, 1.0)
        lam_a = self.mu_away * self.attack.get(away, 1.0) * self.defense.get(home, 1.0)
        clamp = lambda x: min(max(x, 0.05), 6.0)
        return clamp(lam_h), clamp(lam_a)

    def predict(self, home: str, away: str, top_n: int = 5) -> PoissonPrediction:
        lam_h, lam_a = self.expected_goals(home, away)
        row_h = poisson_pmf_row(lam_h, self.max_goals)
        row_a = poisson_pmf_row(lam_a, self.max_goals)

        p_home = p_draw = p_away = 0.0
        scorelines = []
        for i, ph in enumerate(row_h):
            for j, pa in enumerate(row_a):
                p = ph * pa
                scorelines.append((i, j, p))
                if i > j:
                    p_home += p
                elif i == j:
                    p_draw += p
                else:
                    p_away += p
        # Renormalizamos la (pequeña) masa perdida al truncar en max_goals.
        total = p_home + p_draw + p_away
        scorelines.sort(key=lambda s: s[2], reverse=True)
        top = [(i, j, p / total) for i, j, p in scorelines[:top_n]]
        return PoissonPrediction(
            p_home=p_home / total, p_draw=p_draw / total, p_away=p_away / total,
            lambda_home=lam_h, lambda_away=lam_a, top_scorelines=top,
        )

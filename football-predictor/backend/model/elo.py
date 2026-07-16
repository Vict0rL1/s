"""Rating Elo ajustado por margen de gol + conversión a probabilidades 1X2.

Cada equipo arranca en `initial_rating` (los que aparecen a mitad del
historial, p. ej. ascendidos, arrancan en `new_team_rating`, algo por debajo
del promedio). Tras cada partido:

    delta = K · M · (S − E)

donde S es el resultado (1 gana local, 0.5 empate, 0 gana visita), E es el
resultado esperado según la diferencia de ratings (con ventaja de local) y
M es el multiplicador por margen de gol de eloratings.net: ganar por 2 goles
mueve 1.5× más el rating, por 3 goles 1.75×, etc. Entre temporadas los
ratings regresan un poco hacia la media (las plantillas cambian en verano).

Para convertir la diferencia de ratings d en (P_local, P_empate, P_visita)
usamos el modelo de Davidson (1970), una extensión del Elo clásico que trata
el empate explícitamente:

    γ = 10^(d/400)
    P_local = γ / (γ + 1 + ν·√γ)
    P_empate = ν·√γ / (γ + 1 + ν·√γ)
    P_visita = 1 / (γ + 1 + ν·√γ)

ν (propensión al empate) y HA (ventaja de local en puntos Elo) NO se inventan:
se CALIBRAN con el propio historial de la liga, buscando por bisección los
valores con los que la frecuencia media predicha de victorias locales y de
empates coincide con la observada (ponderada con el mismo decaimiento temporal
que el modelo de Poisson). Ver MODEL.md.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime


def _to_date(value: str | date) -> date:
    if isinstance(value, date):
        return value
    return datetime.strptime(value, "%Y-%m-%d").date()


def margin_multiplier(goal_diff: int) -> float:
    """Multiplicador por margen de gol (convención de eloratings.net)."""
    gd = abs(goal_diff)
    if gd <= 1:
        return 1.0
    if gd == 2:
        return 1.5
    return (11 + gd) / 8  # 3 goles → 1.75, 4 → 1.875, ...


def davidson_probs(diff: float, nu: float) -> tuple[float, float, float]:
    """(P_local, P_empate, P_visita) según Davidson para una diferencia
    efectiva de rating `diff` (ya incluida la ventaja de local)."""
    gamma = 10 ** (diff / 400.0)
    sqrt_gamma = 10 ** (diff / 800.0)
    denom = gamma + 1.0 + nu * sqrt_gamma
    return gamma / denom, nu * sqrt_gamma / denom, 1.0 / denom


@dataclass
class EloPrediction:
    p_home: float
    p_draw: float
    p_away: float
    home_rating: float
    away_rating: float
    home_advantage: float
    nu: float


class EloModel:
    def __init__(self, k: float = 20.0, initial_rating: float = 1500.0,
                 new_team_rating: float = 1450.0, season_regression: float = 0.1,
                 half_life_days: float = 365.0):
        self.k = k
        self.initial_rating = initial_rating
        self.new_team_rating = new_team_rating
        self.season_regression = season_regression
        self.half_life_days = half_life_days
        self.ratings: dict[str, float] = {}
        self.home_advantage = 65.0   # valor inicial; se calibra en fit()
        self.nu = 1.0                # ídem

    # ------------------------------------------------------------------ fit
    def fit(self, matches, as_of: str | date | None = None) -> None:
        """`matches`: iterable de (date, season, home, away, hg, ag) SOLO
        jugados y EN ORDEN CRONOLÓGICO. Ajusta ratings y calibra HA y ν."""
        ref = _to_date(as_of) if as_of else date.today()
        self.ratings = {}
        history: list[tuple[float, float, int]] = []  # (diff_sin_HA, peso, resultado 0/1/2)
        current_season = None

        for d, season, home, away, hg, ag in matches:
            if current_season is not None and season != current_season:
                # Cambio de temporada: regresión suave hacia la media
                # (fichajes, ascensos... los equipos no son los mismos).
                for t in self.ratings:
                    self.ratings[t] += self.season_regression * (self.initial_rating - self.ratings[t])
            current_season = season

            first_seen = self.initial_rating if not self.ratings else self.new_team_rating
            rh = self.ratings.setdefault(home, first_seen)
            ra = self.ratings.setdefault(away, first_seen)

            # Guardamos el estado PREVIO al partido para calibrar después.
            age_days = max(0, (ref - _to_date(d)).days)
            w = 0.5 ** (age_days / self.half_life_days)
            outcome = 0 if hg > ag else (1 if hg == ag else 2)  # 0=local,1=empate,2=visita
            history.append((rh - ra, w, outcome))

            # Actualización Elo con una ventaja de local estándar fija (65):
            # el valor exacto afecta poco a la dinámica de los ratings; la HA
            # que sí importa (la de predicción) se calibra abajo con datos.
            expected_home = 1.0 / (1.0 + 10 ** (-((rh + 65.0) - ra) / 400.0))
            score_home = 1.0 if outcome == 0 else (0.5 if outcome == 1 else 0.0)
            delta = self.k * margin_multiplier(hg - ag) * (score_home - expected_home)
            self.ratings[home] = rh + delta
            self.ratings[away] = ra - delta

        if history:
            self._calibrate(history)

    def _calibrate(self, history) -> None:
        """Busca (HA, ν) tales que las frecuencias medias predichas igualen a
        las observadas (ponderadas por recencia). Ambas relaciones son
        monótonas → bisección por coordenadas, 4 rondas bastan."""
        total_w = sum(w for _, w, _ in history)
        target_home = sum(w for _, w, o in history if o == 0) / total_w
        target_draw = sum(w for _, w, o in history if o == 1) / total_w

        def mean_probs(ha: float, nu: float) -> tuple[float, float]:
            sh = sd = 0.0
            for diff, w, _ in history:
                ph, pd, _ = davidson_probs(diff + ha, nu)
                sh += w * ph
                sd += w * pd
            return sh / total_w, sd / total_w

        ha, nu = 65.0, 1.0
        for _ in range(4):
            lo, hi = -100.0, 300.0          # P(local) media crece con HA
            for _ in range(35):
                ha = (lo + hi) / 2
                if mean_probs(ha, nu)[0] < target_home:
                    lo = ha
                else:
                    hi = ha
            lo, hi = 0.05, 4.0              # P(empate) media crece con ν
            for _ in range(35):
                nu = (lo + hi) / 2
                if mean_probs(ha, nu)[1] < target_draw:
                    lo = nu
                else:
                    hi = nu
        self.home_advantage, self.nu = ha, nu

    # -------------------------------------------------------------- predict
    def rating(self, team: str) -> float:
        return self.ratings.get(team, self.new_team_rating)

    def predict(self, home: str, away: str) -> EloPrediction:
        diff = self.rating(home) + self.home_advantage - self.rating(away)
        p_home, p_draw, p_away = davidson_probs(diff, self.nu)
        return EloPrediction(
            p_home=p_home, p_draw=p_draw, p_away=p_away,
            home_rating=self.rating(home), away_rating=self.rating(away),
            home_advantage=self.home_advantage, nu=self.nu,
        )

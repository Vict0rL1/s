#!/usr/bin/env python3
"""Backtest honesto del modelo sobre la última temporada completa de cada liga.

Para cada partido de la temporada de evaluación se reajusta el modelo usando
ÚNICAMENTE partidos anteriores a su fecha (sin ver el futuro) y se compara la
predicción con el resultado real. Métricas:

  - accuracy : % de aciertos eligiendo el resultado más probable.
  - Brier    : error cuadrático de las probabilidades (0 = perfecto,
               0.6667 = repartir 1/3-1/3-1/3 siempre). Castiga estar seguro
               y equivocado; premia probabilidades bien calibradas.

Baselines para contexto: 'uniforme' (1/3 a cada resultado) y 'frecuencias'
(las tasas históricas de local/empate/visita de la liga, sin mirar equipos).
El objetivo del backtest es DIMENSIONAR la incertidumbre: en fútbol, ~50-55%
de acierto es lo esperable para modelos de este tipo. Ver MODEL.md.

Uso: python scripts/backtest.py [--league liga-mx]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config, db  # noqa: E402
from backend.model.predictor import LeaguePredictor, load_played_matches  # noqa: E402

OUTCOMES = ("home", "draw", "away")


def outcome_of(hg: int, ag: int) -> str:
    return "home" if hg > ag else ("draw" if hg == ag else "away")


def brier(probs: dict, real: str) -> float:
    return sum((probs[o] - (1.0 if o == real else 0.0)) ** 2 for o in OUTCOMES)


def eval_league(conn, league_id: str) -> dict | None:
    """Devuelve métricas por variante de modelo para la última temporada."""
    all_matches = load_played_matches(conn, league_id)
    seasons = sorted({m[1] for m in all_matches})
    eval_season = seasons[-1]
    eval_matches = [m for m in all_matches if m[1] == eval_season]
    train_before = [m for m in all_matches if m[1] != eval_season]
    if len(eval_matches) < 50 or len(train_before) < 300:
        return None

    params = config.model_params()
    stats = {v: {"brier": 0.0, "hits": 0} for v in
             ("mezcla", "poisson", "elo", "baseline_frecuencias", "baseline_uniforme")}
    n = 0

    # Reajustamos el modelo una vez por fecha de jornada (los partidos del
    # mismo día comparten el mismo "pasado").
    predictor = None
    current_date = None
    for m in eval_matches:
        d, _season, home, away, hg, ag = m
        if d != current_date:
            predictor = LeaguePredictor(
                league_id,
                [x for x in all_matches if x[0] < d],
                params,
                as_of=d,
            )
            current_date = d
        real = outcome_of(hg, ag)
        n += 1

        pred = predictor.predict(home, away)
        for variant, probs in (("mezcla", pred.probs),
                               ("poisson", pred.poisson_probs),
                               ("elo", pred.elo_probs)):
            stats[variant]["brier"] += brier(probs, real)
            stats[variant]["hits"] += max(probs, key=probs.get) == real

        # Baseline de frecuencias históricas de la liga (previas al partido).
        past = [x for x in train_before if x[0] < d] or train_before
        freq = {o: 0.0 for o in OUTCOMES}
        for x in past:
            freq[outcome_of(x[4], x[5])] += 1
        freq = {o: v / len(past) for o, v in freq.items()}
        stats["baseline_frecuencias"]["brier"] += brier(freq, real)
        stats["baseline_frecuencias"]["hits"] += max(freq, key=freq.get) == real

        uni = {o: 1 / 3 for o in OUTCOMES}
        stats["baseline_uniforme"]["brier"] += brier(uni, real)
        stats["baseline_uniforme"]["hits"] += max(uni, key=uni.get) == real

    return {
        "season": eval_season,
        "n": n,
        "results": {v: {"accuracy": s["hits"] / n, "brier": s["brier"] / n}
                    for v, s in stats.items()},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", help="evaluar solo esta liga")
    args = parser.parse_args()

    conn = db.connect()
    grand = {}
    print(f"{'liga':<16}{'temporada':<11}{'n':>5}   {'variante':<22}{'accuracy':>9}{'Brier':>8}")
    print("-" * 75)
    for lg in config.leagues():
        if args.league and lg["id"] != args.league:
            continue
        res = eval_league(conn, lg["id"])
        if res is None:
            print(f"{lg['id']:<16} (datos insuficientes para backtest)")
            continue
        for variant, m in res["results"].items():
            print(f"{lg['id']:<16}{res['season']:<11}{res['n']:>5}   {variant:<22}"
                  f"{m['accuracy']:>8.1%}{m['brier']:>8.3f}")
            g = grand.setdefault(variant, {"acc": 0.0, "brier": 0.0, "n": 0})
            g["acc"] += m["accuracy"] * res["n"]
            g["brier"] += m["brier"] * res["n"]
            g["n"] += res["n"]
        print()
    if grand:
        print("PROMEDIO PONDERADO (todas las ligas evaluadas):")
        for variant, g in grand.items():
            print(f"   {variant:<22}{g['acc'] / g['n']:>8.1%}{g['brier'] / g['n']:>8.3f}")
    conn.close()


if __name__ == "__main__":
    main()

"""API REST (FastAPI) + servidor del frontend estático.

Arranque (desde football-predictor/):
    uvicorn backend.main:app --reload
Documentación interactiva autogenerada: http://localhost:8000/docs

Los modelos se ajustan en memoria por liga la primera vez que se piden y se
re-ajustan automáticamente cuando la base de datos cambia (p. ej. tras correr
scripts/update_data.py). El ajuste tarda < 1 s por liga.
"""

from __future__ import annotations

import difflib
from datetime import date

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from . import config, db
from .model.predictor import LeaguePredictor, build_predictor

DISCLAIMER = (
    "Estimación estadística basada únicamente en resultados históricos. "
    "No incorpora lesiones, fichajes, alineaciones ni contexto actual. "
    "NO usar como base para apuestas."
)

app = FastAPI(
    title="Football Predictor",
    description="Predicción de resultados de fútbol con Poisson + Elo. " + DISCLAIMER,
    version="1.0.0",
)


# --------------------------------------------------------------------------
# Caché de predictores: se invalida sola cuando cambia data/football.db
# --------------------------------------------------------------------------
_predictors: dict[str, tuple[float, LeaguePredictor]] = {}


def _db_version() -> float:
    try:
        return config.DB_PATH.stat().st_mtime
    except FileNotFoundError:
        raise HTTPException(503, "Base de datos no encontrada. Corre: python scripts/update_data.py")


def get_predictor(league_id: str) -> LeaguePredictor:
    _require_league(league_id)
    version = _db_version()
    cached = _predictors.get(league_id)
    if cached and cached[0] == version:
        return cached[1]
    conn = db.connect()
    try:
        predictor = build_predictor(conn, league_id)
    except ValueError as exc:
        raise HTTPException(503, str(exc))
    finally:
        conn.close()
    _predictors[league_id] = (version, predictor)
    return predictor


def _require_league(league_id: str) -> dict:
    league = config.get_league(league_id)
    if league is None:
        valid = [lg["id"] for lg in config.leagues()]
        raise HTTPException(404, f"Liga desconocida '{league_id}'. Disponibles: {valid}")
    return league


def _require_team(predictor: LeaguePredictor, team: str) -> str:
    """Valida el nombre de equipo; si no existe, sugiere los más parecidos."""
    if team in predictor.teams:
        return team
    close = difflib.get_close_matches(team, predictor.teams, n=3, cutoff=0.4)
    hint = f" ¿Quisiste decir {close}?" if close else ""
    raise HTTPException(404, f"Equipo desconocido '{team}' en {predictor.league_id}.{hint} "
                             f"Lista completa en /api/leagues/{predictor.league_id}/teams")


def _prediction_payload(pred) -> dict:
    return {
        "league": pred.league_id,
        "home": pred.home,
        "away": pred.away,
        "probs": pred.probs,                     # mezcla final (suma 1)
        "components": {"poisson": pred.poisson_probs, "elo": pred.elo_probs},
        "expected_goals": pred.expected_goals,
        "most_likely_score": pred.most_likely_score,
        "top_scorelines": pred.top_scorelines,
        "elo_ratings": pred.elo_ratings,
        "notes": pred.notes,
    }


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------

@app.get("/api/meta", tags=["meta"])
def meta():
    """Estado de los datos y parámetros del modelo (transparencia)."""
    conn = db.connect()
    overview = db.leagues_overview(conn)
    conn.close()
    return {
        "disclaimer": DISCLAIMER,
        "model": config.model_params(),
        "data": overview,
        "today": date.today().isoformat(),
    }


@app.get("/api/leagues", tags=["ligas"])
def list_leagues():
    conn = db.connect()
    overview = {row["id"]: row for row in db.leagues_overview(conn)}
    conn.close()
    # Se devuelven en el orden del config (es el orden de presentación).
    return [overview[lg["id"]] for lg in config.leagues() if lg["id"] in overview]


@app.get("/api/leagues/{league_id}/teams", tags=["ligas"])
def list_teams(league_id: str, all: bool = Query(False, description="incluir equipos históricos")):
    _require_league(league_id)
    conn = db.connect()
    teams = db.teams_for_league(conn, league_id, all_teams=all)
    conn.close()
    return {"league": league_id, "teams": teams}


@app.get("/api/leagues/{league_id}/fixtures", tags=["partidos"])
def list_fixtures(league_id: str, limit: int = Query(20, ge=1, le=100)):
    """Próximos partidos según la fuente de datos (vacío fuera de temporada
    o hasta que la fuente publique el calendario nuevo)."""
    _require_league(league_id)
    conn = db.connect()
    fixtures = db.upcoming_fixtures(conn, league_id, date.today().isoformat(), limit)
    conn.close()
    return {"league": league_id, "fixtures": fixtures, "count": len(fixtures)}


@app.get("/api/leagues/{league_id}/predictions", tags=["predicciones"])
def predict_fixtures(league_id: str, limit: int = Query(10, ge=1, le=50)):
    """Predicción para los próximos partidos de la liga."""
    predictor = get_predictor(league_id)
    conn = db.connect()
    fixtures = db.upcoming_fixtures(conn, league_id, date.today().isoformat(), limit)
    conn.close()
    results = []
    for fx in fixtures:
        pred = predictor.predict(fx["home_team"], fx["away_team"])
        results.append({"fixture": fx, "prediction": _prediction_payload(pred)})
    return {"league": league_id, "count": len(results), "disclaimer": DISCLAIMER,
            "predictions": results}


@app.get("/api/predict", tags=["predicciones"])
def predict_matchup(
    league: str = Query(..., description="id de liga, p. ej. liga-mx"),
    home: str = Query(..., description="equipo local"),
    away: str = Query(..., description="equipo visitante"),
):
    """Predicción de un cruce cualquiera (simulador) + head-to-head + forma
    reciente. Funciona para cualquier par de equipos de la liga."""
    predictor = get_predictor(league)
    home = _require_team(predictor, home)
    away = _require_team(predictor, away)
    if home == away:
        raise HTTPException(400, "El local y el visitante no pueden ser el mismo equipo")

    pred = predictor.predict(home, away)
    conn = db.connect()
    h2h = db.head_to_head(conn, league, home, away, limit=10)
    form = {"home": db.recent_form(conn, league, home), "away": db.recent_form(conn, league, away)}
    conn.close()
    return {"prediction": _prediction_payload(pred), "h2h": h2h, "form": form,
            "disclaimer": DISCLAIMER}


@app.get("/api/h2h", tags=["partidos"])
def h2h(
    league: str = Query(...),
    home: str = Query(..., description="equipo A"),
    away: str = Query(..., description="equipo B"),
    limit: int = Query(10, ge=1, le=50),
):
    predictor = get_predictor(league)
    team_a = _require_team(predictor, home)
    team_b = _require_team(predictor, away)
    conn = db.connect()
    result = db.head_to_head(conn, league, team_a, team_b, limit)
    conn.close()
    return result


# El frontend se sirve al final para que /api/* tenga prioridad.
app.mount("/", StaticFiles(directory=config.PROJECT_ROOT / "frontend", html=True), name="frontend")

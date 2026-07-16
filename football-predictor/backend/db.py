"""Acceso a SQLite.

Esquema deliberadamente mínimo: una tabla de ligas y una de partidos.
`home_goals`/`away_goals` en NULL significa "partido aún no jugado" (fixture),
lo que permite guardar calendario futuro y resultados en la misma tabla.
"""

import sqlite3

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS leagues (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    country TEXT NOT NULL,
    flag    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS matches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id  TEXT NOT NULL REFERENCES leagues(id),
    season     TEXT NOT NULL,              -- '2024-25'
    stage      TEXT NOT NULL DEFAULT '',   -- 'Matchday 3', 'Apertura, Matchday 1', 'Clausura - Liguilla', ...
    date       TEXT NOT NULL,              -- ISO 'YYYY-MM-DD'
    time       TEXT NOT NULL DEFAULT '',
    home_team  TEXT NOT NULL,
    away_team  TEXT NOT NULL,
    home_goals INTEGER,                    -- NULL = no jugado todavía
    away_goals INTEGER,
    source     TEXT NOT NULL,              -- adapter del que vino la fila
    UNIQUE (league_id, season, date, home_team, away_team)
);

CREATE INDEX IF NOT EXISTS idx_matches_league_date ON matches (league_id, date);
"""


def connect() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def replace_league(conn: sqlite3.Connection, league_cfg: dict, rows: list) -> None:
    """Reconstruye una liga completa desde los archivos crudos (idempotente).

    Borrar y reinsertar evita quedarnos con filas obsoletas cuando la fuente
    corrige resultados o cambia el calendario.
    """
    conn.execute(
        "INSERT INTO leagues (id, name, country, flag) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, country=excluded.country, flag=excluded.flag",
        (league_cfg["id"], league_cfg["name"], league_cfg["country"], league_cfg.get("flag", "")),
    )
    conn.execute("DELETE FROM matches WHERE league_id = ?", (league_cfg["id"],))
    conn.executemany(
        "INSERT OR IGNORE INTO matches "
        "(league_id, season, stage, date, time, home_team, away_team, home_goals, away_goals, source) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                league_cfg["id"], r.season, r.stage, r.date, r.time,
                r.home, r.away, r.home_goals, r.away_goals, r.source,
            )
            for r in rows
        ],
    )
    conn.commit()


# --------------------------------------------------------------------------
# Consultas de lectura para la API
# --------------------------------------------------------------------------

def leagues_overview(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT l.id, l.name, l.country, l.flag,
               COUNT(m.id)                          AS total_matches,
               SUM(m.home_goals IS NOT NULL)        AS played_matches,
               MIN(m.season)                        AS first_season,
               MAX(m.season)                        AS last_season,
               MAX(CASE WHEN m.home_goals IS NOT NULL THEN m.date END) AS last_played_date
        FROM leagues l LEFT JOIN matches m ON m.league_id = l.id
        GROUP BY l.id
        ORDER BY l.name
        """
    ).fetchall()
    return [dict(r) for r in rows]


def teams_for_league(conn: sqlite3.Connection, league_id: str, all_teams: bool = False) -> list[str]:
    """Por defecto, los equipos de la temporada MÁS RECIENTE con datos (los
    'vigentes'); con all_teams=True, todos los que aparecen en el historial."""
    if all_teams:
        sql = """
            SELECT DISTINCT name FROM (
                SELECT home_team AS name FROM matches WHERE league_id = :id
                UNION SELECT away_team FROM matches WHERE league_id = :id
            ) ORDER BY name
        """
    else:
        sql = """
            WITH last AS (SELECT MAX(season) AS s FROM matches WHERE league_id = :id)
            SELECT DISTINCT name FROM (
                SELECT home_team AS name FROM matches, last WHERE league_id = :id AND season = last.s
                UNION SELECT away_team FROM matches, last WHERE league_id = :id AND season = last.s
            ) ORDER BY name
        """
    return [r["name"] for r in conn.execute(sql, {"id": league_id}).fetchall()]


def upcoming_fixtures(conn: sqlite3.Connection, league_id: str, from_date: str, limit: int = 20) -> list[dict]:
    """Partidos con fecha futura y sin marcador (el calendario aparece aquí
    en cuanto la fuente publica la temporada nueva y se corre update_data)."""
    rows = conn.execute(
        """
        SELECT season, stage, date, time, home_team, away_team
        FROM matches
        WHERE league_id = ? AND home_goals IS NULL AND date >= ?
        ORDER BY date, time, id
        LIMIT ?
        """,
        (league_id, from_date, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def head_to_head(conn: sqlite3.Connection, league_id: str, team_a: str, team_b: str,
                 limit: int = 10) -> dict:
    """Enfrentamientos directos recientes (cualquier estadio) + resumen."""
    rows = conn.execute(
        """
        SELECT season, stage, date, home_team, away_team, home_goals, away_goals
        FROM matches
        WHERE league_id = :lid AND home_goals IS NOT NULL
          AND ((home_team = :a AND away_team = :b) OR (home_team = :b AND away_team = :a))
        ORDER BY date DESC
        LIMIT :lim
        """,
        {"lid": league_id, "a": team_a, "b": team_b, "lim": limit},
    ).fetchall()
    summary = {"team_a": team_a, "team_b": team_b, "wins_a": 0, "draws": 0, "wins_b": 0,
               "goals_a": 0, "goals_b": 0}
    matches = []
    for r in rows:
        ga = r["home_goals"] if r["home_team"] == team_a else r["away_goals"]
        gb = r["away_goals"] if r["home_team"] == team_a else r["home_goals"]
        summary["goals_a"] += ga
        summary["goals_b"] += gb
        if ga > gb:
            summary["wins_a"] += 1
        elif ga == gb:
            summary["draws"] += 1
        else:
            summary["wins_b"] += 1
        matches.append(dict(r))
    return {"summary": summary, "matches": matches}


def recent_form(conn: sqlite3.Connection, league_id: str, team: str, n: int = 5) -> list[dict]:
    """Últimos n partidos del equipo: W/D/L desde su perspectiva."""
    rows = conn.execute(
        """
        SELECT date, home_team, away_team, home_goals, away_goals
        FROM matches
        WHERE league_id = :lid AND home_goals IS NOT NULL AND (home_team = :t OR away_team = :t)
        ORDER BY date DESC LIMIT :lim
        """,
        {"lid": league_id, "t": team, "lim": n},
    ).fetchall()
    form = []
    for r in rows:
        is_home = r["home_team"] == team
        gf = r["home_goals"] if is_home else r["away_goals"]
        ga = r["away_goals"] if is_home else r["home_goals"]
        form.append({
            "date": r["date"],
            "opponent": r["away_team"] if is_home else r["home_team"],
            "venue": "local" if is_home else "visita",
            "score": f"{r['home_goals']}-{r['away_goals']}",
            "result": "W" if gf > ga else ("D" if gf == ga else "L"),
        })
    return form


def league_seasons_summary(conn: sqlite3.Connection, league_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT season,
               COUNT(*)                                   AS partidos,
               SUM(home_goals IS NOT NULL)                AS jugados,
               COUNT(DISTINCT home_team)                  AS equipos,
               MIN(date)                                  AS desde,
               MAX(date)                                  AS hasta,
               GROUP_CONCAT(DISTINCT source)              AS fuentes
        FROM matches
        WHERE league_id = ?
        GROUP BY season
        ORDER BY season
        """,
        (league_id,),
    ).fetchall()

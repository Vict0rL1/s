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

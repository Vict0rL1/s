// La NHL en sombra (Fase 8.1): partidos jugados. Historia: se vuelve a bajar.
//
// `final_period` es NULL cuando la fuente no dice cómo acabó (el calendario de sportsdataverse trae el
// marcador final pero no si hubo prórroga o tanda): se deja sin dato, no se supone «REG». `fuente`
// dice de dónde salió cada fila.
export const NHL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS nhl_games (
    id           INTEGER PRIMARY KEY,   -- el id de partido de la NHL
    season       INTEGER NOT NULL,      -- año de inicio: 2023 para la 2023-24
    game_type    INTEGER NOT NULL,      -- 2 temporada regular, 3 playoffs
    game_date    TEXT NOT NULL,         -- YYYY-MM-DD
    home_id      TEXT NOT NULL,         -- abreviatura (TOR, BOS…)
    away_id      TEXT NOT NULL,
    home_name    TEXT,
    away_name    TEXT,
    home_goals   INTEGER NOT NULL,
    away_goals   INTEGER NOT NULL,
    final_period TEXT CHECK (final_period IS NULL OR final_period IN ('REG', 'OT', 'SO')),
    fuente       TEXT,
    ingested_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nhl_fecha ON nhl_games (game_date);
`;

// La NHL publicada (seguimiento: NHL y UFC). Historia: los equipos y los próximos partidos, que se
// vuelven a bajar (el calendario de la temporada y, con clave, las cuotas de The Odds API).
export const NHL_PUBLICADA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS nhl_teams (
    id      TEXT PRIMARY KEY,           -- abreviatura (TOR, BOS…)
    league  TEXT NOT NULL DEFAULT 'nhl',
    name    TEXT NOT NULL,              -- nombre completo («Toronto Maple Leafs»)
    city    TEXT,
    active  INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS nhl_upcoming (
    id            TEXT PRIMARY KEY,     -- 'nhl-<id de la NHL>' (calendario) u 'odds-<id>' (cuotas)
    league        TEXT NOT NULL DEFAULT 'nhl',
    season        INTEGER,              -- año de inicio
    game_id       INTEGER,              -- id de la NHL, si viene del calendario
    commence_time TEXT NOT NULL,
    home_name     TEXT NOT NULL,
    away_name     TEXT NOT NULL,
    home_id       TEXT,
    away_id       TEXT,
    odds_home     REAL,                 -- moneyline: prórroga y tanda incluidas
    odds_away     REAL,
    total_line    REAL,
    odds_over     REAL,
    odds_under    REAL,
    books         INTEGER NOT NULL DEFAULT 0,
    source        TEXT NOT NULL CHECK (source IN ('live', 'schedule')),
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nhl_upcoming_commence ON nhl_upcoming (commence_time);
  CREATE INDEX IF NOT EXISTS idx_nhl_home ON nhl_games (home_id, game_date);
  CREATE INDEX IF NOT EXISTS idx_nhl_away ON nhl_games (away_id, game_date);
`;

// Libro mayor: lo que el modelo dijo antes de cada partido. Como los otros cinco registros, no se
// borra y la predicción no se reescribe (los triggers, en paper/schema.ts): se anotan el resultado y,
// una vez, la probabilidad enseñada y las versiones.
export const NHL_REGISTRO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS nhl_prediction_log (
    match_key           TEXT PRIMARY KEY,   -- nhl|fecha en Nueva York|visitante|local
    league              TEXT NOT NULL DEFAULT 'nhl',
    upcoming_id         TEXT,
    commence_time       TEXT,
    season              INTEGER,
    home_id             TEXT NOT NULL,
    away_id             TEXT NOT NULL,
    home_name           TEXT,
    away_name           TEXT,
    prob_home           REAL NOT NULL,      -- gana el local, prórroga y tanda incluidas
    prob_draw60         REAL,               -- empate a los 60 minutos
    shown_home          REAL,
    market_prob_home    REAL,
    expected_home_goals REAL,
    expected_away_goals REAL,
    total_line          REAL,
    prob_over           REAL,
    reliability         TEXT,
    predicted_at        TEXT NOT NULL,
    home_goals          INTEGER,
    away_goals          INTEGER,
    game_id             INTEGER,
    resolved_at         TEXT,
    model_version        TEXT,
    model_config_version TEXT,
    calibration_version  TEXT,
    data_version         TEXT,
    git_commit           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_nhl_predlog_commence ON nhl_prediction_log (league, commence_time);
  CREATE INDEX IF NOT EXISTS idx_nhl_predlog_upcoming ON nhl_prediction_log (upcoming_id);
  CREATE INDEX IF NOT EXISTS idx_nhl_predlog_pendientes ON nhl_prediction_log (commence_time) WHERE resolved_at IS NULL;
`;

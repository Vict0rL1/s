// La UFC en sombra (seguimiento: NHL y UFC). Historia: se vuelve a bajar.
//
// Las peleas guardan a los dos luchadores en el orden de la fuente (A y B) y quién ganó. Ese orden NO
// es información para el modelo: medido en octubre de 2026, hasta ~2009 la fuente pone siempre primero
// al ganador y después, la esquina roja. El modelo es simétrico y no lo mira.
//
// `ambigua` = 1 cuando alguno de los dos nombres lo comparten varios luchadores (ufcstats solo da
// nombres en las peleas): esas peleas no se atribuyen a nadie ni se puntúan.
export const UFC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ufc_events (
    id        TEXT PRIMARY KEY,          -- id de ufcstats (de la URL del evento)
    nombre    TEXT NOT NULL,
    fecha     TEXT NOT NULL,             -- YYYY-MM-DD
    lugar     TEXT
  );
  CREATE TABLE IF NOT EXISTS ufc_fighters (
    id          TEXT PRIMARY KEY,        -- id de ufcstats (de la URL del luchador)
    nombre      TEXT NOT NULL,
    apodo       TEXT,
    altura_cm   REAL,
    alcance_cm  REAL,
    guardia     TEXT,
    nacimiento  TEXT,                    -- YYYY-MM-DD o NULL
    ambiguo     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ufc_fights (
    id          TEXT PRIMARY KEY,        -- id de ufcstats (de la URL de la pelea)
    evento_id   TEXT NOT NULL,
    fecha       TEXT NOT NULL,
    orden       INTEGER NOT NULL,        -- posición en la cartelera de la fuente: 0 = la estelar (la última)
    luchador_a  TEXT,                    -- id del luchador, NULL si el nombre es ambiguo o desconocido
    luchador_b  TEXT,
    nombre_a    TEXT NOT NULL,
    nombre_b    TEXT NOT NULL,
    resultado   TEXT NOT NULL CHECK (resultado IN ('A', 'B', 'EMPATE', 'NC')),
    categoria   TEXT,
    metodo      TEXT,
    asalto      INTEGER,
    tiempo      TEXT,
    ambigua     INTEGER NOT NULL DEFAULT 0,
    ingested_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ufc_fecha ON ufc_fights (fecha, orden);
`;

// La UFC publicada (docs/plans/ufc-combinado.md: pasó la prueba). Historia: las peleas que vienen, que
// se vuelven a bajar de The Odds API.
//
// LOS NOMBRES DE COLUMNA SON LOS DE LOS DEPORTES DE EQUIPO A PROPÓSITO: `home_*` es el luchador A y
// `away_*` el B, para que Hoy, ¿Acertó?, el banco, la confianza y el resto de piezas comunes las lean
// igual que las de la NHL. NO hay local: el modelo es simétrico, y A es el de id de ufcstats menor (un
// orden que no sabe nada de la pelea), no el que la casa puso primero. Así, si la casa da la vuelta a
// los dos entre una actualización y otra, la pelea sigue siendo la misma fila con las mismas cuotas
// en el mismo lado.
export const UFC_PUBLICADA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ufc_upcoming (
    id            TEXT PRIMARY KEY,     -- 'odds-<id de The Odds API>'
    league        TEXT NOT NULL DEFAULT 'ufc',
    commence_time TEXT NOT NULL,
    home_name     TEXT NOT NULL,        -- luchador A (ver arriba): nombre como lo da la casa
    away_name     TEXT NOT NULL,        -- luchador B
    home_id       TEXT,                 -- id de ufcstats; NULL si no ha peleado en la UFC o el nombre es ambiguo
    away_id       TEXT,
    odds_home     REAL,                 -- ganador a dos vías: empate y «sin resultado» devuelven la apuesta
    odds_away     REAL,
    books         INTEGER NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live')),
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ufc_upcoming_commence ON ufc_upcoming (commence_time);
  CREATE INDEX IF NOT EXISTS idx_ufc_a ON ufc_fights (luchador_a, fecha);
  CREATE INDEX IF NOT EXISTS idx_ufc_b ON ufc_fights (luchador_b, fecha);
`;

// Libro mayor: lo que el modelo dijo antes de cada pelea. Como los otros seis registros, no se borra y
// la predicción no se reescribe (los triggers, en paper/schema.ts): se anotan el resultado y, una vez,
// la probabilidad enseñada y las versiones. `home_score`/`away_score` son 1-0 o 0-1 para quien ganó y
// 0-0 para el empate o el «sin resultado» (`outcome` dice cuál): así el banco devuelve la apuesta en
// los dos casos y ¿Acertó? no puntúa ninguno, como con un empate en la NFL.
export const UFC_REGISTRO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ufc_prediction_log (
    match_key           TEXT PRIMARY KEY,   -- ufc|fecha en Nueva York|id A|id B
    league              TEXT NOT NULL DEFAULT 'ufc',
    upcoming_id         TEXT,
    commence_time       TEXT,
    home_id             TEXT NOT NULL,      -- luchador A (id de ufcstats)
    away_id             TEXT NOT NULL,      -- luchador B
    home_name           TEXT,
    away_name           TEXT,
    prob_home           REAL NOT NULL,      -- gana A
    shown_home          REAL,
    market_prob_home    REAL,
    rasgos              TEXT,               -- JSON: los cinco rasgos con los que se predijo
    reliability         TEXT,
    predicted_at        TEXT NOT NULL,
    home_score          INTEGER,
    away_score          INTEGER,
    outcome             TEXT CHECK (outcome IS NULL OR outcome IN ('A', 'B', 'EMPATE', 'NC')),
    metodo              TEXT,
    fight_id            TEXT,
    resolved_at         TEXT,
    model_version        TEXT,
    model_config_version TEXT,
    calibration_version  TEXT,
    data_version         TEXT,
    git_commit           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ufc_predlog_commence ON ufc_prediction_log (league, commence_time);
  CREATE INDEX IF NOT EXISTS idx_ufc_predlog_upcoming ON ufc_prediction_log (upcoming_id);
  CREATE INDEX IF NOT EXISTS idx_ufc_predlog_pendientes ON ufc_prediction_log (commence_time) WHERE resolved_at IS NULL;
`;

// Esquema de los snapshots de mercado. Sin imports a propósito: lo carga db.ts al abrir la
// base, y el módulo que lo usa (snapshots.ts) importa db.ts — ponerlo allí sería un ciclo.
//
// ===========================================================================
// LAS TRES TABLAS
// ===========================================================================
// odds_snapshots          APPEND-ONLY. Una fila por cambio de cuota: evento, mercado,
//                         selección, casa, cuota, línea, cuándo se vio. Nunca se edita ni
//                         se borra — lo impiden los triggers de abajo, no la buena voluntad.
// odds_event_observations APPEND-ONLY. Cada vez que un evento aparece en una descarga. Es lo
//                         que dice «a las 18:40 el precio SEGUÍA siendo 1,67», aunque no
//                         cambiara y por tanto no generara snapshot: sin esto, la cuota de
//                         cierre no sabría decir cuándo se observó por última vez.
// odds_quote_state        CACHÉ, derivable de las otras dos: la última cuota de cada casa y
//                         selección, para decidir en O(1) si la nueva es un cambio. Se
//                         actualiza en el sitio y se puede reconstruir en cualquier momento.
//
// ===========================================================================
// CUÁNDO SE GUARDA UN SNAPSHOT (la decisión que pide documentar)
// ===========================================================================
// Solo si la cuota o la línea CAMBIÓ respecto al último snapshot de esa misma
// (evento, mercado, selección, casa). Guardar la misma cuota en cada refresco multiplica
// la tabla sin añadir información: el estado del mercado en cualquier instante se
// reconstruye igual con «el último snapshot anterior a ese instante», y la prueba de que
// seguía vigente la da odds_event_observations.
//
// Dos casos especiales:
//   · Si una casa DEJA de ofrecer una selección que ofrecía (el evento sigue en la
//     descarga, esa cuota ya no), se escribe un snapshot con `withdrawn = 1` y cuota NULL.
//     Sin él, al reconstruir el mercado esa cuota vieja seguiría «viva» para siempre.
//   · Si el EVENTO entero desaparece de la descarga (empezó, terminó, se canceló), no se
//     escribe nada: el mercado cerró, y su último estado es el de cierre.
export const ODDS_SNAPSHOT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS odds_snapshots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id          TEXT NOT NULL,        -- id del evento en The Odds API
    sport             TEXT NOT NULL,        -- football | basketball | baseball | nfl | tennis
    league            TEXT NOT NULL,        -- clave de competición del proveedor (soccer_epl…)
    market            TEXT NOT NULL,        -- h2h | spreads | totals
    selection         TEXT NOT NULL,        -- nombre del resultado tal cual lo da el proveedor
    bookmaker         TEXT NOT NULL,
    odds_decimal      REAL,                 -- NULL solo si withdrawn = 1
    line              REAL,                 -- hándicap o total; NULL en h2h
    home_team         TEXT,
    away_team         TEXT,
    commence_time     TEXT,
    observed_at       TEXT NOT NULL,        -- cuándo LO VIMOS (UTC)
    source_updated_at TEXT,                 -- cuándo lo publicó la casa, si lo dice
    source            TEXT NOT NULL DEFAULT 'the-odds-api',
    is_live           INTEGER NOT NULL DEFAULT 0,  -- visto con el evento ya empezado
    withdrawn         INTEGER NOT NULL DEFAULT 0,
    CHECK (withdrawn = 1 OR odds_decimal > 1)
  );
  CREATE INDEX IF NOT EXISTS idx_snap_event ON odds_snapshots (event_id, market, selection, observed_at);
  CREATE INDEX IF NOT EXISTS idx_snap_time ON odds_snapshots (observed_at);

  CREATE TRIGGER IF NOT EXISTS odds_snapshots_no_update
    BEFORE UPDATE ON odds_snapshots
    BEGIN SELECT RAISE(ABORT, 'odds_snapshots es append-only: no se edita'); END;
  CREATE TRIGGER IF NOT EXISTS odds_snapshots_no_delete
    BEFORE DELETE ON odds_snapshots
    BEGIN SELECT RAISE(ABORT, 'odds_snapshots es append-only: no se borra'); END;

  CREATE TABLE IF NOT EXISTS odds_event_observations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT NOT NULL,
    sport         TEXT NOT NULL,
    league        TEXT NOT NULL,
    markets       TEXT NOT NULL,
    commence_time TEXT,
    observed_at   TEXT NOT NULL,
    bookmakers    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_obs_event ON odds_event_observations (event_id, observed_at);
  CREATE TRIGGER IF NOT EXISTS odds_observations_no_update
    BEFORE UPDATE ON odds_event_observations
    BEGIN SELECT RAISE(ABORT, 'odds_event_observations es append-only: no se edita'); END;
  CREATE TRIGGER IF NOT EXISTS odds_observations_no_delete
    BEFORE DELETE ON odds_event_observations
    BEGIN SELECT RAISE(ABORT, 'odds_event_observations es append-only: no se borra'); END;

  CREATE TABLE IF NOT EXISTS odds_quote_state (
    event_id     TEXT NOT NULL,
    market       TEXT NOT NULL,
    selection    TEXT NOT NULL,
    bookmaker    TEXT NOT NULL,
    odds_decimal REAL,
    line         REAL,
    withdrawn    INTEGER NOT NULL DEFAULT 0,
    snapshot_id  INTEGER NOT NULL,
    PRIMARY KEY (event_id, market, selection, bookmaker)
  );
`;

// SQLite storage layer built on Node's built-in `node:sqlite` (no native build
// step required). Data is cached locally in data/tennis.db so we never depend on
// repeated network calls once ingested.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from './config.ts';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  // Default (rollback-journal) mode + a busy timeout keeps cross-process reads
  // always up to date: if the running API and an external `update-data` process
  // both touch the DB, each read sees the latest committed state (WAL can leave
  // a long-lived writer connection with a stale view). Writes here are small and
  // fast, so blocking briefly is fine for a local single-user app.
  db.exec('PRAGMA journal_mode = DELETE;'); // convert any pre-existing WAL db back
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  createSchema(db);
  migrateSchema(db);
  return db;
}

function createSchema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id        INTEGER NOT NULL,
      tour      TEXT NOT NULL,
      name      TEXT NOT NULL,
      hand      TEXT,
      country   TEXT,
      birthdate TEXT,
      PRIMARY KEY (tour, id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tour         TEXT NOT NULL,
      tourney_id   TEXT,
      tourney_name TEXT,
      tourney_date TEXT NOT NULL,
      surface      TEXT,
      level        TEXT,
      round        TEXT,
      best_of      INTEGER,
      winner_id    INTEGER NOT NULL,
      loser_id     INTEGER NOT NULL,
      score        TEXT,
      -- Official ranking of each player AT THE TIME of the match. Kept so the
      -- backtest can score a "higher-ranked player wins" baseline honestly.
      winner_rank  INTEGER,
      loser_rank   INTEGER,
      w_ace INTEGER, w_df INTEGER, w_svpt INTEGER, w_1stIn INTEGER,
      w_1stWon INTEGER, w_2ndWon INTEGER, w_bpSaved INTEGER, w_bpFaced INTEGER,
      l_ace INTEGER, l_df INTEGER, l_svpt INTEGER, l_1stIn INTEGER,
      l_1stWon INTEGER, l_2ndWon INTEGER, l_bpSaved INTEGER, l_bpFaced INTEGER,
      -- Closing decimal odds for the winner / loser, when the source carries
      -- them (tennis-data.co.uk does; TML does not). Historical odds are what
      -- make it possible to ask whether the model beats the market at all --
      -- see the --market flag of the backtest script.
      w_odds REAL, l_odds REAL
    );
    CREATE INDEX IF NOT EXISTS idx_matches_tour_date ON matches (tour, tourney_date);
    CREATE INDEX IF NOT EXISTS idx_matches_winner ON matches (tour, winner_id);
    CREATE INDEX IF NOT EXISTS idx_matches_loser  ON matches (tour, loser_id);
    -- Surface appended so the per-player+surface lookups (surface record,
    -- tournament history, head-to-head) can be served by a MULTI-INDEX OR
    -- instead of scanning every match of that tour. Measured on 62k ATP
    -- matches: getSurfaceRecord 96 ms → 0.1 ms, getTournamentHistory 180 ms →
    -- 0.1 ms, a full prediction 612 ms → ~5 ms. Without these, a tournament page
    -- with 30 matches spends ~18 s building predictions.
    CREATE INDEX IF NOT EXISTS idx_matches_w_surface ON matches (tour, winner_id, surface);
    CREATE INDEX IF NOT EXISTS idx_matches_l_surface ON matches (tour, loser_id, surface);

    CREATE TABLE IF NOT EXISTS player_ratings (
      player_id      INTEGER NOT NULL,
      tour           TEXT NOT NULL,
      overall        REAL NOT NULL,
      hard           REAL NOT NULL,
      clay           REAL NOT NULL,
      grass          REAL NOT NULL,
      matches_played INTEGER NOT NULL,
      last_date      TEXT,
      PRIMARY KEY (tour, player_id)
    );

    -- Official ATP/WTA ranking snapshots (source: Sackmann rankings files).
    -- Only the most recent snapshot per player is kept.
    CREATE TABLE IF NOT EXISTS player_rankings (
      player_id     INTEGER NOT NULL,
      tour          TEXT NOT NULL,
      rank          INTEGER NOT NULL,
      points        INTEGER,
      ranking_date  TEXT NOT NULL,
      PRIMARY KEY (tour, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rankings_rank ON player_rankings (tour, rank);

    CREATE TABLE IF NOT EXISTS upcoming_matches (
      id              TEXT PRIMARY KEY,
      tour            TEXT NOT NULL,
      tournament_id   TEXT,
      tournament_name TEXT,
      surface         TEXT,
      commence_time   TEXT,
      p1_name         TEXT NOT NULL,
      p2_name         TEXT NOT NULL,
      p1_id           INTEGER,
      p2_id           INTEGER,
      p1_odds         REAL,
      p2_odds         REAL,
      books           INTEGER DEFAULT 0,
      source          TEXT,
      updated_at      TEXT
    );

    -- ------------------------------------------------------------------
    -- The app's own track record.
    --
    -- Every prediction shown for an upcoming match is stored here the FIRST
    -- time it is served, and never rewritten afterwards: that is the number
    -- the user actually saw before the match was played, so it can be scored
    -- honestly later. Once the real result lands in the matches table (on the
    -- next update-data run), the row is resolved with the actual winner.
    --
    -- This is deliberately NOT cleared by resetData(): re-ingesting the
    -- history must not erase the record of how the model has been doing.
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS prediction_log (
      -- Stable identity of the fixture, independent of the odds-feed event id
      -- (which changes between providers/refreshes): tour|loId|hiId|YYYYMMDD.
      match_key       TEXT PRIMARY KEY,
      tour            TEXT NOT NULL,
      upcoming_id     TEXT,
      tournament_name TEXT,
      surface         TEXT,
      commence_time   TEXT,
      p1_id           INTEGER NOT NULL,
      p2_id           INTEGER NOT NULL,
      p1_name         TEXT,
      p2_name         TEXT,
      -- Model probability that p1 wins, exactly as displayed.
      prob1           REAL NOT NULL,
      -- Vig-free market probability for p1 at that moment (null without odds),
      -- so the model can be scored against the market on the same matches.
      market_prob1    REAL,
      reliability     TEXT,
      predicted_at    TEXT NOT NULL,
      -- Filled in when the real result arrives:
      winner_id       INTEGER,
      match_id        INTEGER,
      resolved_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_predlog_tour ON prediction_log (tour, resolved_at);

    -- ------------------------------------------------------------------
    -- Stable numeric ids for sources that don't provide any.
    --
    -- TML/Sackmann rows carry a player id, so ids survive a re-ingest for free.
    -- tennis-data.co.uk identifies players only by name ("Alcaraz C."), and
    -- handing out sequential ids per run would renumber everyone as soon as one
    -- new name appears -- silently invalidating prediction_log, which stores
    -- player ids and is meant to outlive re-ingestion. So a name keeps its id
    -- forever, recorded here and never reset.
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS player_ids (
      tour TEXT NOT NULL,
      name TEXT NOT NULL,
      id   INTEGER NOT NULL,
      PRIMARY KEY (tour, name)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/**
 * Bring an existing database up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * database created by an earlier version keeps its old columns. Ingestion then
 * wipes the rows and fails on the first INSERT ("table matches has no column
 * named …"), leaving an empty database. Adding the missing columns here means an
 * upgrade never needs the user to delete their data by hand.
 */
function migrateSchema(d: DatabaseSync): void {
  const columnsOf = (table: string): Set<string> => {
    try {
      const rows = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
      return new Set(rows.map((r) => r.name));
    } catch {
      return new Set();
    }
  };

  // table -> column -> definition
  const wanted: Record<string, Record<string, string>> = {
    matches: {
      winner_rank: 'INTEGER',
      loser_rank: 'INTEGER',
      w_odds: 'REAL',
      l_odds: 'REAL',
    },
  };

  for (const [table, cols] of Object.entries(wanted)) {
    const existing = columnsOf(table);
    if (existing.size === 0) continue; // table not created yet — schema handles it
    for (const [col, def] of Object.entries(cols)) {
      if (!existing.has(col)) {
        d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def};`);
      }
    }
  }
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value);
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Wipe all ingested data (used before a fresh seed or full re-ingest).
 *
 * `prediction_log` and `player_ids` are intentionally absent from this list.
 * The first holds the app's own track record (what it predicted, before the
 * match), which is earned over time and must survive a history re-ingest. The
 * second keeps a name's numeric id stable across runs, which is what makes those
 * logged predictions still refer to the same players afterwards. Everything else
 * is re-derivable from the sources.
 */
export function resetData(): void {
  const d = getDb();
  for (const t of [
    'upcoming_matches',
    'player_ratings',
    'player_rankings',
    'matches',
    'players',
    'meta',
  ]) {
    d.exec(`DELETE FROM ${t};`);
  }
}

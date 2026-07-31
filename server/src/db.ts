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
      l_1stWon INTEGER, l_2ndWon INTEGER, l_bpSaved INTEGER, l_bpFaced INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_matches_tour_date ON matches (tour, tourney_date);
    CREATE INDEX IF NOT EXISTS idx_matches_winner ON matches (tour, winner_id);
    CREATE INDEX IF NOT EXISTS idx_matches_loser  ON matches (tour, loser_id);

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

/** Wipe all ingested data (used before a fresh seed or full re-ingest). */
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

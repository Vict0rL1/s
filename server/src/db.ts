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

    -- ==================================================================
    -- BASKETBALL
    --
    -- Separate tables rather than a shared "sport" abstraction over the
    -- tennis ones. The two sports disagree on exactly the fields a model
    -- cares about: basketball has a home court and a score margin worth
    -- modelling and no surface; tennis is the reverse. One schema over both
    -- would make every column nullable and every query conditional. The
    -- pieces that genuinely generalise (market maths, reliability, the
    -- prediction log) are reused as-is.
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS bb_teams (
      id           TEXT NOT NULL,   -- slug, unique within the league
      league       TEXT NOT NULL,
      name         TEXT NOT NULL,
      abbreviation TEXT,
      location     TEXT,
      conference   TEXT,
      division     TEXT,
      logo         TEXT,
      PRIMARY KEY (league, id)
    );

    CREATE TABLE IF NOT EXISTS bb_games (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      league     TEXT NOT NULL,
      season     INTEGER NOT NULL,
      game_date  TEXT NOT NULL,     -- YYYYMMDD
      home_id    TEXT NOT NULL,
      away_id    TEXT NOT NULL,
      home_pts   INTEGER NOT NULL,
      away_pts   INTEGER NOT NULL,
      -- Neutral venue (finals, cup ties, the 2020 bubble): the home-court
      -- bonus must NOT be applied to these, and ~5% of games are like this.
      neutral    INTEGER DEFAULT 0,
      is_playoff INTEGER DEFAULT 0,
      overtimes  INTEGER,
      UNIQUE (league, game_date, home_id, away_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bb_games_date ON bb_games (league, game_date);
    -- Per-team lookups, as two indexed halves (same reason as the tennis
    -- indexes: an OR over two columns lets SQLite pick a full scan).
    CREATE INDEX IF NOT EXISTS idx_bb_games_home ON bb_games (league, home_id, game_date);
    CREATE INDEX IF NOT EXISTS idx_bb_games_away ON bb_games (league, away_id, game_date);

    CREATE TABLE IF NOT EXISTS bb_team_ratings (
      team_id       TEXT NOT NULL,
      league        TEXT NOT NULL,
      elo           REAL NOT NULL,
      games_played  INTEGER NOT NULL,
      last_date     TEXT,
      ppg           REAL,
      papg          REAL,
      PRIMARY KEY (league, team_id)
    );

    -- The basketball track record. Same contract as prediction_log (written
    -- before the game, never rewritten, survives re-ingestion) but with TEXT team
    -- ids, which is why it is a separate table rather than a nullable column
    -- bolted onto the tennis one.
    CREATE TABLE IF NOT EXISTS bb_prediction_log (
      game_key      TEXT PRIMARY KEY,   -- league|home|away|YYYYMMDD
      league        TEXT NOT NULL,
      upcoming_id   TEXT,
      commence_time TEXT,
      home_id       TEXT NOT NULL,
      away_id       TEXT NOT NULL,
      home_name     TEXT,
      away_name     TEXT,
      prob_home     REAL NOT NULL,
      market_prob_home REAL,
      -- What the model expected the margin to be, so spread accuracy is
      -- measurable after the fact and not just the moneyline.
      predicted_margin REAL,
      reliability   TEXT,
      predicted_at  TEXT NOT NULL,
      -- Filled in once the real result arrives:
      home_pts      INTEGER,
      away_pts      INTEGER,
      game_id       INTEGER,
      resolved_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bb_predlog ON bb_prediction_log (league, resolved_at);

    CREATE TABLE IF NOT EXISTS bb_upcoming (
      id            TEXT PRIMARY KEY,
      league        TEXT NOT NULL,
      commence_time TEXT,
      home_name     TEXT NOT NULL,
      away_name     TEXT NOT NULL,
      home_id       TEXT,
      away_id       TEXT,
      home_odds     REAL,
      away_odds     REAL,
      books         INTEGER DEFAULT 0,
      source        TEXT,
      updated_at    TEXT
    );

    -- ==================================================================
    -- FOOTBALL (soccer)
    --
    -- Its own tables, like basketball. The distinguishing feature is the
    -- DRAW: roughly a quarter of matches end level, so the result is a
    -- three-way outcome and the result column is stored rather than derived
    -- from a comparison. Goals are kept because in a low-scoring sport the goal
    -- distribution IS the model: 1X2, over/under and both-teams-to-score all
    -- come out of it, which is also what keeps those markets consistent.
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS fb_teams (
      id     TEXT NOT NULL,
      league TEXT NOT NULL,
      name   TEXT NOT NULL,
      PRIMARY KEY (league, id)
    );

    CREATE TABLE IF NOT EXISTS fb_matches (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      league     TEXT NOT NULL,
      season     INTEGER NOT NULL,
      match_date TEXT NOT NULL,
      home_id    TEXT NOT NULL,
      away_id    TEXT NOT NULL,
      home_goals INTEGER NOT NULL,
      away_goals INTEGER NOT NULL,
      result     TEXT NOT NULL,   -- H | D | A
      -- Closing 1X2 odds where the source has them, so the model can be scored
      -- against the market on identical matches.
      odds_home  REAL, odds_draw REAL, odds_away REAL,
      -- Half-time score, from openfootball. Stored and NOT yet modelled: it is the
      -- one piece of data that would make "wins either half" — a market this app's
      -- reader actually bets — possible rather than invented. Ingesting it now means
      -- the history is there whenever that gets measured, instead of starting from
      -- zero the day someone wants it.
      ht_home_goals INTEGER, ht_away_goals INTEGER,
      UNIQUE (league, match_date, home_id, away_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fb_date ON fb_matches (league, match_date);
    CREATE INDEX IF NOT EXISTS idx_fb_home ON fb_matches (league, home_id, match_date);
    CREATE INDEX IF NOT EXISTS idx_fb_away ON fb_matches (league, away_id, match_date);

    CREATE TABLE IF NOT EXISTS fb_team_ratings (
      team_id         TEXT NOT NULL,
      league          TEXT NOT NULL,
      elo             REAL NOT NULL,
      matches_played  INTEGER NOT NULL,
      last_date       TEXT,
      gf              REAL,
      ga              REAL,
      PRIMARY KEY (league, team_id)
    );

    -- ------------------------------------------------------------------
    -- Football squads.
    --
    -- The one thing the team model provably cannot see. Elo, goals and the
    -- calendar were all measured and none of them knew whether the striker was
    -- playing; this table is what makes that answerable. Per player: how much he
    -- plays, how much attacking output he produces per 90 minutes, and whether he
    -- is currently injured or suspended.
    --
    -- Deliberately NOT wiped by resetData(): squads survive a re-ingestion of
    -- results, and the availability flags are the freshest thing in the app.
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS fb_players (
      id            TEXT NOT NULL,     -- source id, unique within the league
      league        TEXT NOT NULL,
      team_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      position      TEXT NOT NULL,     -- GK | DEF | MID | FWD
      minutes       INTEGER NOT NULL DEFAULT 0,
      starts        INTEGER NOT NULL DEFAULT 0,
      -- Expected goal involvements (goals + assists) per 90 minutes. The
      -- player-specific quantity the attack side of the model is built on.
      xgi90         REAL,
      goals         INTEGER NOT NULL DEFAULT 0,
      assists       INTEGER NOT NULL DEFAULT 0,
      -- Availability as the source reports it right now.
      status        TEXT,              -- a | d | i | s | u
      chance_next   INTEGER,           -- 0..100, NULL when the source says nothing
      news          TEXT,
      season        TEXT,
      updated_at    TEXT,
      PRIMARY KEY (league, id)
    );
    CREATE INDEX IF NOT EXISTS idx_fb_players_team ON fb_players (league, team_id, minutes DESC);

    CREATE TABLE IF NOT EXISTS fb_upcoming (
      id            TEXT PRIMARY KEY,
      league        TEXT NOT NULL,
      commence_time TEXT,
      home_name     TEXT NOT NULL,
      away_name     TEXT NOT NULL,
      home_id       TEXT,
      away_id       TEXT,
      odds_home     REAL,
      odds_draw     REAL,
      odds_away     REAL,
      books         INTEGER DEFAULT 0,
      source        TEXT,
      updated_at    TEXT
    );

    -- Football track record. Stores the full three-way forecast, because
    -- scoring a 1X2 prediction with a two-outcome metric would throw away the
    -- draw — the hardest part to get right.
    CREATE TABLE IF NOT EXISTS fb_prediction_log (
      match_key      TEXT PRIMARY KEY,   -- league|home|away|YYYYMMDD
      league         TEXT NOT NULL,
      upcoming_id    TEXT,
      commence_time  TEXT,
      home_id        TEXT NOT NULL,
      away_id        TEXT NOT NULL,
      home_name      TEXT,
      away_name      TEXT,
      prob_home      REAL NOT NULL,
      prob_draw      REAL NOT NULL,
      prob_away      REAL NOT NULL,
      market_prob_home REAL,
      market_prob_draw REAL,
      market_prob_away REAL,
      expected_home_goals REAL,
      expected_away_goals REAL,
      reliability    TEXT,
      predicted_at   TEXT NOT NULL,
      home_goals     INTEGER,
      away_goals     INTEGER,
      match_id       INTEGER,
      resolved_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fb_predlog ON fb_prediction_log (league, resolved_at);

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

    -- ==================================================================
    -- BASEBALL
    --
    -- A fourth namespace, like the other three. Prefixed bsb_ and not bb_
    -- because basketball got there first -- and CREATE TABLE IF NOT EXISTS does
    -- nothing to a table that already exists, so a clash would not have errored,
    -- it would have quietly written baseball games into the basketball table.
    -- The one table the other sports have no equivalent of is bsb_pitchers: in baseball a single announced
    -- player moves the forecast more than anything except the teams themselves,
    -- and unlike a football lineup he is known the day before.
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS bsb_teams (
      id     TEXT NOT NULL,
      league TEXT NOT NULL,
      name   TEXT NOT NULL,
      PRIMARY KEY (league, id)
    );

    CREATE TABLE IF NOT EXISTS bsb_games (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      league      TEXT NOT NULL,
      season      INTEGER NOT NULL,
      game_date   TEXT NOT NULL,   -- YYYYMMDD
      -- 0 for a single game; 1 and 2 for the halves of a doubleheader. Part of
      -- the unique key, because two teams really can meet twice in one day.
      game_number INTEGER NOT NULL DEFAULT 0,
      home_id     TEXT NOT NULL,
      away_id     TEXT NOT NULL,
      home_runs   INTEGER NOT NULL,
      away_runs   INTEGER NOT NULL,
      home_sp     TEXT,
      away_sp     TEXT,
      site        TEXT,
      UNIQUE (league, game_date, game_number, home_id, away_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bb_date ON bsb_games (league, game_date);
    CREATE INDEX IF NOT EXISTS idx_bb_home ON bsb_games (league, home_id, game_date);
    CREATE INDEX IF NOT EXISTS idx_bb_away ON bsb_games (league, away_id, game_date);

    CREATE TABLE IF NOT EXISTS bsb_team_ratings (
      team_id      TEXT NOT NULL,
      league       TEXT NOT NULL,
      elo          REAL NOT NULL,
      games_played INTEGER NOT NULL,
      last_date    TEXT,
      rs           REAL,
      ra           REAL,
      PRIMARY KEY (league, team_id)
    );

    -- How much each STADIUM moves the run total, measured against what the model
    -- expected there. Coors Field comes out at 1.23, Seattle at 0.90 — see
    -- baseball/parkFactors.ts for the measurement and its validation.
    CREATE TABLE IF NOT EXISTS bsb_park_factors (
      league     TEXT NOT NULL,
      site       TEXT NOT NULL,   -- Retrosheet park id, e.g. DEN02
      factor     REAL NOT NULL,
      games      INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (league, site)
    );

    -- Runs allowed, not EARNED runs: the model predicts the scoreboard, and the
    -- scoreboard does not care whose error it was.
    CREATE TABLE IF NOT EXISTS bsb_pitchers (
      id           TEXT NOT NULL,
      league       TEXT NOT NULL,
      name         TEXT NOT NULL,
      team_id      TEXT,
      starts       INTEGER NOT NULL DEFAULT 0,
      outs         INTEGER NOT NULL DEFAULT 0,
      runs_allowed INTEGER NOT NULL DEFAULT 0,
      runs_per_9   REAL,
      rating       REAL,
      last_date    TEXT,
      season       INTEGER,
      PRIMARY KEY (league, id)
    );
    CREATE INDEX IF NOT EXISTS idx_bb_pitchers_team ON bsb_pitchers (league, team_id, starts DESC);

    CREATE TABLE IF NOT EXISTS bsb_upcoming (
      id            TEXT PRIMARY KEY,
      league        TEXT NOT NULL,
      commence_time TEXT,
      home_name     TEXT NOT NULL,
      away_name     TEXT NOT NULL,
      home_id       TEXT,
      away_id       TEXT,
      home_sp       TEXT,
      away_sp       TEXT,
      odds_home     REAL,
      odds_away     REAL,
      books         INTEGER DEFAULT 0,
      source        TEXT,
      updated_at    TEXT
    );

    -- Write-once, like the other three sports': re-ingesting results must never
    -- erase the record of what the model actually said beforehand.
    CREATE TABLE IF NOT EXISTS bsb_prediction_log (
      match_key      TEXT PRIMARY KEY,   -- league|away|home|YYYYMMDD|number
      league         TEXT NOT NULL,
      upcoming_id    TEXT,
      commence_time  TEXT,
      home_id        TEXT NOT NULL,
      away_id        TEXT NOT NULL,
      home_name      TEXT,
      away_name      TEXT,
      home_sp        TEXT,
      away_sp        TEXT,
      prob_home      REAL NOT NULL,
      market_prob_home REAL,
      expected_home_runs REAL,
      expected_away_runs REAL,
      reliability    TEXT,
      predicted_at   TEXT NOT NULL,
      home_runs      INTEGER,
      away_runs      INTEGER,
      game_id        INTEGER,
      resolved_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bb_predlog ON bsb_prediction_log (league, resolved_at);

    -- ==================================================================
    -- AMERICAN FOOTBALL
    --
    -- The fifth namespace, prefixed naf_ (football owns fb_, basketball bb_,
    -- baseball bsb_). Two columns exist here that no other sport has:
    --
    --   close_spread / close_total on naf_games. This is the ONLY sport in the
    --   app with a free archive of the closing betting line on every historical
    --   game. Storing it turns "is the model any good?" from a comparison
    --   against itself into a comparison against the sharpest price in sports.
    --   Nothing in the model reads these columns -- the backtest does, and the
    --   audit checks the model never peeks at them.
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS naf_teams (
      id     TEXT NOT NULL,
      league TEXT NOT NULL,
      name   TEXT NOT NULL,
      PRIMARY KEY (league, id)
    );

    CREATE TABLE IF NOT EXISTS naf_games (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      league       TEXT NOT NULL,
      season       INTEGER NOT NULL,
      week         INTEGER NOT NULL,
      game_date    TEXT NOT NULL,   -- YYYYMMDD
      home_id      TEXT NOT NULL,
      away_id      TEXT NOT NULL,
      home_points  INTEGER NOT NULL,
      away_points  INTEGER NOT NULL,
      -- 1 for a neutral site (London, the Super Bowl): no home advantage.
      neutral      INTEGER NOT NULL DEFAULT 0,
      playoff      INTEGER NOT NULL DEFAULT 0,
      -- Days since each side last played. Measured and found worthless, kept
      -- because the measurement should stay reproducible. See docs/NFL.md.
      home_rest    INTEGER,
      away_rest    INTEGER,
      -- The STARTING QUARTERBACK on each side, which nflverse fills for all
      -- 7,276 games. 52% of team-seasons start more than one quarterback, so a
      -- team rating alone silently averages a starter and his backup together
      -- and cannot move when the starter is out -- the single largest roster
      -- fact in the sport, invisible to plain Elo.
      home_qb_id   TEXT,
      away_qb_id   TEXT,
      home_qb_name TEXT,
      away_qb_name TEXT,
      -- Conditions. Wind is the one that matters for scoring; the roof column
      -- says whether it can matter at all (indoors wind is absent, not zero, and
      -- that difference is why these are nullable).
      roof         TEXT,
      temp         REAL,
      wind         REAL,
      -- Closing line, home-positive. Backtest only, never the model.
      close_spread REAL,
      close_total  REAL,
      close_ml_home REAL,
      close_ml_away REAL,
      UNIQUE (league, season, week, home_id, away_id)
    );
    CREATE INDEX IF NOT EXISTS idx_naf_date ON naf_games (league, game_date);
    CREATE INDEX IF NOT EXISTS idx_naf_home ON naf_games (league, home_id, game_date);
    CREATE INDEX IF NOT EXISTS idx_naf_away ON naf_games (league, away_id, game_date);

    CREATE TABLE IF NOT EXISTS naf_team_ratings (
      team_id      TEXT NOT NULL,
      league       TEXT NOT NULL,
      elo          REAL NOT NULL,
      games_played INTEGER NOT NULL,
      last_date    TEXT,
      -- Points scored / allowed per game, the EWMA the total model reads.
      pf           REAL,
      pa           REAL,
      -- The quarterback who started this team's most recent game. nflverse names
      -- the starter for played games but not for scheduled ones, so "who is
      -- playing on Sunday" is answered with "whoever played last Sunday".
      current_qb   TEXT,
      PRIMARY KEY (league, team_id)
    );

    -- One row per quarterback who has ever started. The adjustment is Elo points
    -- added to whatever team he starts for, so it compares across teams: +40 is a
    -- quarterback worth two points of margin more than a league-average starter.
    CREATE TABLE IF NOT EXISTS naf_qb_ratings (
      qb_id       TEXT NOT NULL,
      league      TEXT NOT NULL,
      name        TEXT,
      adjustment  REAL NOT NULL,
      starts      INTEGER NOT NULL,
      last_season INTEGER,
      last_date   TEXT,
      PRIMARY KEY (league, qb_id)
    );

    CREATE TABLE IF NOT EXISTS naf_upcoming (
      id            TEXT PRIMARY KEY,
      league        TEXT NOT NULL,
      season        INTEGER,
      week          INTEGER,
      commence_time TEXT,
      home_name     TEXT NOT NULL,
      away_name     TEXT NOT NULL,
      home_id       TEXT,
      away_id       TEXT,
      neutral       INTEGER DEFAULT 0,
      odds_home     REAL,
      odds_away     REAL,
      spread_line   REAL,
      total_line    REAL,
      books         INTEGER DEFAULT 0,
      source        TEXT,
      updated_at    TEXT
    );

    -- Write-once, like the other four: re-ingesting results must never erase
    -- the record of what the model actually said beforehand.
    CREATE TABLE IF NOT EXISTS naf_prediction_log (
      match_key       TEXT PRIMARY KEY,   -- league|season|week|away|home
      league          TEXT NOT NULL,
      upcoming_id     TEXT,
      commence_time   TEXT,
      home_id         TEXT NOT NULL,
      away_id         TEXT NOT NULL,
      home_name       TEXT,
      away_name       TEXT,
      prob_home       REAL NOT NULL,
      market_prob_home REAL,
      expected_margin REAL,
      expected_total  REAL,
      reliability     TEXT,
      predicted_at    TEXT NOT NULL,
      home_points     INTEGER,
      away_points     INTEGER,
      game_id         INTEGER,
      resolved_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_naf_predlog ON naf_prediction_log (league, resolved_at);

    -- ==================================================================
    -- THE BET LOG
    --
    -- Everything above this line is the app's own forecasts and how they
    -- scored. This table is the other half: what the PERSON actually staked.
    -- The two are deliberately separate — a model prediction is a claim about
    -- the world and exists whether or not anyone backs it, and conflating them
    -- would make "the model's accuracy" depend on which games someone felt like
    -- betting.
    --
    -- They are LINKED though, by model_prob and market_prob captured at the
    -- moment the bet was logged. That is what lets the tracker answer the one
    -- question a bettor actually has and no bookmaker's app can: when I agreed
    -- with the model, did I do better than when I did not?
    --
    -- WHAT IS NOT STORED: profit. It is derived from status, stake, odds and
    -- payout every time it is read (see profitOf in bets.ts). A stored profit is
    -- a second source of truth that goes stale the moment a status is corrected,
    -- and correcting a status is the single most common edit here.
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS bets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL,
      -- The day the bet counts for, as a local YYYY-MM-DD. Separate from
      -- created_at because a bet placed at 01:00 on a game earlier that evening
      -- belongs to the evening, and because a bet can be logged after the fact.
      placed_on   TEXT NOT NULL,
      sport       TEXT NOT NULL,   -- football | basketball | baseball | nfl | tennis | other
      league      TEXT,
      event       TEXT NOT NULL,   -- "Seattle Seahawks vs New England Patriots"
      market      TEXT NOT NULL,   -- moneyline | spread | total | btts | other
      selection   TEXT NOT NULL,   -- "Seahawks -3.5"
      -- Decimal odds. One format only, converted at the edge if needed: storing
      -- "either decimal or American" is how a 2.50 becomes a +250.
      odds        REAL NOT NULL,
      stake       REAL NOT NULL,
      status      TEXT NOT NULL,   -- pending | won | lost | void | half_won | half_lost | cashout
      -- Only for cashout, where the returned amount is not a function of the odds.
      payout      REAL,
      settled_at  TEXT,
      notes       TEXT,
      -- The app's own numbers at the time of the bet, for the agreement report.
      model_prob  REAL,
      market_prob REAL,
      match_key   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bets_day ON bets (placed_on);
    CREATE INDEX IF NOT EXISTS idx_bets_status ON bets (status);

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
    // Starting quarterback and conditions. These columns were always in the
    // nflverse file we download; the parser simply ignored them until the model
    // learned to use the quarterback.
    naf_games: {
      home_qb_id: 'TEXT',
      away_qb_id: 'TEXT',
      home_qb_name: 'TEXT',
      away_qb_name: 'TEXT',
      roof: 'TEXT',
      temp: 'REAL',
      wind: 'REAL',
    },
    naf_upcoming: {
      home_qb_name: 'TEXT',
      away_qb_name: 'TEXT',
      roof: 'TEXT',
    },
    naf_team_ratings: {
      current_qb: 'TEXT',
    },
    fb_matches: {
      // Arrived with the openfootball source — see the note on the schema above.
      ht_home_goals: 'INTEGER',
      ht_away_goals: 'INTEGER',
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
/**
 * The `meta` keys that belong to TENNIS, and therefore the only ones resetData may
 * touch.
 *
 * Listed explicitly because `meta` is the one table shared by all five sports, and
 * this function used to end with `DELETE FROM meta` — so `npm run update-data`, which
 * is the TENNIS command, silently erased every other sport's provenance:
 *
 *   · fb_data_source / fb_updated_at / fb_squads_*  → the football tab went back to
 *     showing "origen sin registrar" and no refresh time,
 *   · bb_ / bsb_ / naf: the same for the other three,
 *   · and `bb_margin_sigma_nba`, so basketball dropped from its measured σ (14.14)
 *     back to the frozen fallback of 11.7 — the one that covers 61 % of games where
 *     a normal says 68 %. A model got quietly worse because a different sport was
 *     updated.
 *
 * Nothing failed and nothing was logged. Every sport keeps its own tables precisely
 * so that updating one cannot disturb another; this was the single place that broke
 * that promise.
 *
 * Tennis keys are the UNPREFIXED ones, for historical reasons — tennis came first and
 * the other four adopted a prefix afterwards. A new tennis key must be added here, or
 * it will survive a reset and go stale.
 */
const TENNIS_META_KEYS = [
  'data_source',
  'updated_at',
  'odds_source',
  'odds_refreshed_at',
  'seeded_at',
  'history_through',
];

export function resetData(): void {
  const d = getDb();
  for (const t of ['upcoming_matches', 'player_ratings', 'player_rankings', 'matches', 'players']) {
    d.exec(`DELETE FROM ${t};`);
  }
  const del = d.prepare('DELETE FROM meta WHERE key = ?');
  for (const k of TENNIS_META_KEYS) del.run(k);
}

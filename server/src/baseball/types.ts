// Domain types for the baseball side of the app.
//
// The fourth sport, and the one that least resembles the other three. Two things
// drive every design decision here:
//
//   1. THE STARTING PITCHER. In no other sport does one player who is not on the
//      field for most of the contest matter this much. A great team behind a
//      replacement-level starter and a poor team behind an ace are genuinely
//      close to even. Crucially the starters are ANNOUNCED a day ahead, so unlike
//      a football lineup this is information the model can have in advance —
//      which is why it belongs in the model rather than in a "what if" panel.
//
//   2. THERE ARE NO DRAWS, BUT THERE ARE TIES ON THE SCORECARD. Nine innings can
//      end level; extra innings then decide it. So a run distribution has real
//      mass on the diagonal that has to be resolved rather than ignored — the
//      opposite problem to football, where the draw is a result in itself.

export type LeagueId = string; // "mlb" | "npb" | … (config-driven)

export interface LeagueConfig {
  id: LeagueId;
  name: string;
  label: string;
  country: string;
  /** The Odds API sport keys for upcoming games + prices. */
  oddsSportKeys: string[];
  /** True where a real game-by-game results archive exists (MLB only). */
  retrosheet: boolean;
  innings: number;
}

export interface BaseballConfig {
  history: {
    seasons: number;
    retrosheetBase: string;
    gamelogVerifyUrl: string;
    mlbStatsApi: string;
  };
  leagues: LeagueConfig[];
}

export interface BsbTeamRow {
  id: string; // Retrosheet code (NYA, BOS…) or a slug for other leagues
  league: LeagueId;
  name: string;
}

export interface BsbGameRow {
  id: number;
  league: LeagueId;
  season: number;
  game_date: string; // YYYYMMDD
  /** 0 for a single game, 1/2 for the halves of a doubleheader. */
  game_number: number;
  home_id: string;
  away_id: string;
  home_runs: number;
  away_runs: number;
  /** Retrosheet player id of each starting pitcher, when known. */
  home_sp: string | null;
  away_sp: string | null;
  /** Park code, kept because a handful of "home" games are played elsewhere. */
  site: string | null;
}

export interface BsbTeamRatingRow {
  team_id: string;
  league: LeagueId;
  elo: number;
  games_played: number;
  last_date: string | null;
  /** Runs scored / allowed per game over the recent window. */
  rs: number | null;
  ra: number | null;
}

/**
 * A starting pitcher's rating.
 *
 * `runs_per_9` is what the model actually uses: runs allowed per nine innings in
 * the games he started, which is deliberately RUNS and not earned runs. The model
 * is predicting the scoreboard, and the scoreboard does not care whose error it
 * was.
 */
export interface BsbPitcherRow {
  id: string;
  league: LeagueId;
  name: string;
  team_id: string | null;
  starts: number;
  outs: number;
  runs_allowed: number;
  runs_per_9: number | null;
  /** Shrunk toward the league average — the number the prediction reads. */
  rating: number | null;
  last_date: string | null;
  season: number | null;
}

export interface BsbUpcomingRow {
  id: string;
  league: LeagueId;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  /** Announced starters, where a probables feed supplied them. */
  home_sp: string | null;
  away_sp: string | null;
  odds_home: number | null;
  odds_away: number | null;
  books: number;
  source: 'live' | 'fixture';
  updated_at: string;
}

export interface BsbRecord {
  wins: number;
  losses: number;
}

export interface BsbTeamInfo {
  id: string;
  league: LeagueId;
  name: string;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  record: BsbRecord;
  homeRecord: BsbRecord;
  awayRecord: BsbRecord;
  rs: number | null;
  ra: number | null;
  /**
   * Expected win rate from runs scored and allowed (Bill James' Pythagorean
   * formula with the modern 1.83 exponent). Shown next to the real record
   * because the gap between them is the standard read on how much of a team's
   * season is luck.
   */
  pythagorean: number | null;
  form: {
    date: string;
    opponentId: string;
    opponentName: string | null;
    home: boolean;
    result: 'W' | 'L';
    runsFor: number;
    runsAgainst: number;
  }[];
  rotation: {
    id: string;
    name: string;
    starts: number;
    runsPer9: number | null;
    rating: number | null;
  }[];
}

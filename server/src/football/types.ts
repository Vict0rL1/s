// Domain types for the football (soccer) side of the app.
//
// Separate from tennis and basketball for the same reason those two are separate
// from each other: football disagrees with both on the fields a model needs. It
// is the only one of the three with a DRAW — about a quarter of all matches — so
// its prediction is a three-way distribution, not two numbers that sum to one.
// It is also low-scoring, which makes the goal distribution itself worth
// modelling (over/under, both-teams-to-score, exact scores) rather than a
// side-effect of the win probability.

export type LeagueId = string; // "epl" | "laliga" | … (config-driven)

export interface LeagueConfig {
  id: LeagueId;
  name: string;
  label: string;
  country: string;
  tier: number;
  /** The Odds API sport keys for upcoming fixtures + prices. */
  oddsSportKeys: string[];
  /**
   * football-data.co.uk location. `main` leagues have one CSV per season
   * (mmz4281/{season}/{div}.csv); `extra` leagues share one multi-season file
   * per country with a different column layout.
   */
  footballData:
    | { kind: 'main'; div: string }
    | { kind: 'extra'; file: string; league: string }
    | null;
  /**
   * The PRIMARY results source: openfootball/football.json on GitHub.
   *
   * `key` is its league file name ("en.1" = Premier League, "it.1" = Serie A). This
   * is the only source that reaches the current season, and the only one that gives
   * Serie A, Ligue 1, Eredivisie, Primeira, Liga MX and Argentina any results at
   * all — they were configured as tabs with nothing behind them.
   */
  openfootball?: { key: string } | null;
  /**
   * GitHub mirror of older seasons. A MIRROR of openfootball, abandoned after
   * 2020-21, kept as a fallback for anything the upstream is missing.
   */
  footballcsv: { repo: string; div: string } | null;
}

export interface FootballConfig {
  history: {
    seasons: number;
    footballDataBase: string;
    footballDataExtraBase: string;
    footballCsvBase: string;
    openfootballBase: string;
  };
  leagues: LeagueConfig[];
}

export interface FbTeamRow {
  id: string; // slug, unique within the league
  league: LeagueId;
  name: string;
}

export interface FbMatchRow {
  id: number;
  league: LeagueId;
  season: number; // season the match belongs to (2019-20 → 2020)
  match_date: string; // YYYYMMDD
  home_id: string;
  away_id: string;
  home_goals: number;
  away_goals: number;
  /** 'H' | 'D' | 'A' — stored so queries never have to recompute it. */
  result: string;
  /** Closing decimal odds, when the source carries them (football-data.co.uk). */
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
}

/** Elo plus the scoring rates the goal model needs. */
export interface FbTeamRatingRow {
  team_id: string;
  league: LeagueId;
  elo: number;
  matches_played: number;
  last_date: string | null;
  /** Goals scored / conceded per match, over the recent window. */
  gf: number | null;
  ga: number | null;
}

export interface FbUpcomingRow {
  id: string;
  league: LeagueId;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
  books: number;
  source: 'live' | 'fixture';
  updated_at: string;
}

export interface FbRecord {
  wins: number;
  draws: number;
  losses: number;
}

export interface FbTeamInfo {
  id: string;
  league: LeagueId;
  name: string;
  elo: number;
  eloRank: number;
  matchesInDb: number;
  record: FbRecord;
  homeRecord: FbRecord;
  awayRecord: FbRecord;
  gf: number | null;
  ga: number | null;
  /** Points as the league table counts them (3 for a win, 1 for a draw). */
  points: number;
  form: {
    date: string;
    opponentId: string;
    opponentName: string | null;
    home: boolean;
    result: 'W' | 'D' | 'L';
    goalsFor: number;
    goalsAgainst: number;
  }[];
}

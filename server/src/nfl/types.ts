// Domain types for the American football side of the app.
//
// The fifth sport, and the one that forced the biggest change of method. Three
// facts about the NFL drive everything below:
//
//   1. THE MARGIN IS NOT SMOOTH. A touchdown is 7, a field goal 3, and the
//      scoreboard can only move in those steps. The result is that a final
//      margin of 3 happens in 15.1% of games and a margin of 9 in 1.6% —
//      neighbours on the number line that differ by a factor of nine. Every
//      other sport in this app prices its handicap off a normal curve; here that
//      would misprice the two lines bettors actually use.
//
//   2. THE HOME EDGE MOVED. It was +2.75 points a game in 1999-2007 and is
//      +1.92 in 2020-2025 — and in 2020, with empty stadiums, it briefly
//      vanished (+0.30). A constant fitted over 27 seasons describes no season.
//      So the home advantage here is a tracked quantity, not a setting.
//
//   3. THE CLOSING LINE IS AVAILABLE. nflverse publishes the closing spread and
//      total on every game since 1999 and the moneylines since 2006. In the
//      other four sports "does the model beat the market?" was a question no
//      data could answer; here it can be answered, and the honest answer is
//      published in the backtest rather than assumed.

export type LeagueId = string; // "nfl" | "ncaaf" | … (config-driven)

export interface LeagueConfig {
  id: LeagueId;
  name: string;
  label: string;
  country: string;
  /** The Odds API sport keys for upcoming games + prices. */
  oddsSportKeys: string[];
  /** True where a real game-by-game archive exists (NFL only). */
  nflverse: boolean;
}

export interface NafConfig {
  history: {
    gamesUrl: string;
    teamsUrl: string;
    fromSeason: number;
  };
  leagues: LeagueConfig[];
}

export interface NafTeamRow {
  id: string; // nflverse abbreviation, franchise-folded (LV, LAC, LA…)
  league: LeagueId;
  name: string;
}

export interface NafGameRow {
  id: number;
  league: LeagueId;
  season: number;
  week: number;
  game_date: string; // YYYYMMDD
  home_id: string;
  away_id: string;
  home_points: number;
  away_points: number;
  neutral: number;
  playoff: number;
  home_rest: number | null;
  away_rest: number | null;
  /** Closing line, home-positive. Read by the backtest, never by the model. */
  close_spread: number | null;
  close_total: number | null;
  close_ml_home: number | null;
  close_ml_away: number | null;
}

export interface NafTeamRatingRow {
  team_id: string;
  league: LeagueId;
  elo: number;
  games_played: number;
  last_date: string | null;
  pf: number | null;
  pa: number | null;
}

export interface NafUpcomingRow {
  id: string;
  league: LeagueId;
  season: number | null;
  week: number | null;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  neutral: number;
  odds_home: number | null;
  odds_away: number | null;
  /** Bookmaker handicap and total, when a price feed supplied them. */
  spread_line: number | null;
  total_line: number | null;
  books: number;
  source: 'live' | 'schedule' | 'fixture';
  updated_at: string;
}

export interface NafRecord {
  wins: number;
  losses: number;
  ties: number;
}

export interface NafTeamInfo {
  id: string;
  league: LeagueId;
  name: string;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  record: NafRecord;
  homeRecord: NafRecord;
  awayRecord: NafRecord;
  pf: number | null;
  pa: number | null;
  /**
   * Expected win rate from points scored and allowed. The football version of
   * Bill James' formula, with the 2.37 exponent Football Outsiders fitted for
   * the NFL — the gap against the real record is the standard read on how much
   * of a season is luck.
   */
  pythagorean: number | null;
  form: {
    date: string;
    season: number;
    week: number;
    opponentId: string;
    opponentName: string | null;
    home: boolean;
    result: 'W' | 'L' | 'D';
    pointsFor: number;
    pointsAgainst: number;
  }[];
}

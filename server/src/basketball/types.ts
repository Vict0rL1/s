// Domain types for the basketball side of the app.
//
// Deliberately SEPARATE from the tennis types (../types.ts) rather than a shared
// abstraction. The two sports differ in the ways that matter to a model: tennis
// has no home court and no score margin worth modelling, basketball has both and
// no surface; tennis matches are between individuals, basketball games between
// rosters that turn over every season. Forcing one schema over both would make
// every field optional and every query full of special cases. What IS shared is
// reused directly: the market/vig maths, the reliability idea and the prediction
// log all work unchanged.

export type LeagueId = string; // "nba" | "euroleague" | … (config-driven)

export interface LeagueConfig {
  id: LeagueId;
  name: string;
  label: string;
  country: string;
  /** The Odds API sport keys for upcoming games + bookmaker odds. */
  oddsSportKeys: string[];
  /** ESPN slugs for results and team info; null when ESPN has no feed for it. */
  espn: { sport: string; league: string } | null;
  quarters: number;
  minutes: number;
}

export interface BasketballConfig {
  history: {
    seasons: number;
    espnBase: string;
    fivethirtyeightUrl: string;
  };
  leagues: LeagueConfig[];
}

export interface TeamRow {
  id: string; // stable slug, unique within the league
  league: LeagueId;
  name: string; // "Boston Celtics"
  abbreviation: string | null; // "BOS"
  location: string | null; // "Boston"
  conference: string | null;
  division: string | null;
  logo: string | null;
}

export interface GameRow {
  id: number;
  league: LeagueId;
  season: number; // season the game belongs to (NBA 2024-25 → 2025)
  game_date: string; // YYYYMMDD
  /** Home and away are NOT interchangeable here: see homeAdvantage in model.ts. */
  home_id: string;
  away_id: string;
  home_pts: number;
  away_pts: number;
  /** True when the game was played at neither team's arena (finals, cup, bubble). */
  neutral: number;
  is_playoff: number;
  /** Overtime periods, when the source reports them. */
  overtimes: number | null;
}

/** Elo ratings for one team after replaying every game chronologically. */
export interface TeamRatingRow {
  team_id: string;
  league: LeagueId;
  elo: number;
  /** Elo restricted to home games / away games — some teams travel badly. */
  games_played: number;
  last_date: string | null;
  /** Points scored / allowed per game, for the pace and total-points estimate. */
  ppg: number | null;
  papg: number | null;
}

/** An upcoming game with market odds (The Odds API or local fixtures). */
export interface UpcomingGameRow {
  id: string;
  league: LeagueId;
  commence_time: string; // ISO 8601
  home_name: string;
  away_name: string;
  home_id: string | null; // resolved team slug, when the name matched
  away_id: string | null;
  home_odds: number | null; // decimal odds
  away_odds: number | null;
  books: number;
  source: 'live' | 'fixture';
  updated_at: string;
}

/** Win/loss record, optionally split by venue. */
export interface TeamRecord {
  wins: number;
  losses: number;
}

/** Everything we can say about a team without reference to a specific game. */
export interface TeamInfo {
  id: string;
  league: LeagueId;
  name: string;
  abbreviation: string | null;
  conference: string | null;
  division: string | null;
  logo: string | null;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  record: TeamRecord;
  homeRecord: TeamRecord;
  awayRecord: TeamRecord;
  ppg: number | null;
  papg: number | null;
  /** Most recent results, newest first. */
  form: {
    date: string;
    opponentId: string;
    opponentName: string | null;
    home: boolean;
    won: boolean;
    pts: number;
    oppPts: number;
  }[];
}

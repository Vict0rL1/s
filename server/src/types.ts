// Shared domain types used across ingestion, the model, and the API.

export type TourId = string; // "atp" | "wta" (kept open so tours are config-driven)

/** Surfaces the surface-specific Elo tracks. Carpet / unknown only affect overall Elo. */
export type Surface = 'Hard' | 'Clay' | 'Grass';

export interface PlayerRow {
  id: number;
  tour: TourId;
  name: string;
  hand: string | null;
  country: string | null;
  birthdate: string | null; // YYYYMMDD as text
}

export interface MatchRow {
  id: number;
  tour: TourId;
  tourney_id: string;
  tourney_name: string;
  tourney_date: string; // YYYYMMDD
  surface: string; // raw surface (Hard/Clay/Grass/Carpet/…)
  level: string | null;
  round: string | null;
  best_of: number | null;
  winner_id: number;
  loser_id: number;
  score: string | null;
  // Serve/return stats (nullable — not present for every match)
  w_ace: number | null;
  w_df: number | null;
  w_svpt: number | null;
  w_1stIn: number | null;
  w_1stWon: number | null;
  w_2ndWon: number | null;
  w_bpSaved: number | null;
  w_bpFaced: number | null;
  l_ace: number | null;
  l_df: number | null;
  l_svpt: number | null;
  l_1stIn: number | null;
  l_1stWon: number | null;
  l_2ndWon: number | null;
  l_bpSaved: number | null;
  l_bpFaced: number | null;
}

/** Final Elo ratings for a player after processing every match chronologically. */
export interface RatingRow {
  player_id: number;
  tour: TourId;
  overall: number;
  hard: number;
  clay: number;
  grass: number;
  matches_played: number;
  last_date: string | null;
}

/** An upcoming match with market odds (from The Odds API or local fixtures). */
/** Aggregated serve / return stats for a player (from stored match stats). */
export interface ServeStats {
  matches: number; // matches that had stats
  acePct: number | null; // aces / service points
  dfPct: number | null; // double faults / service points
  firstInPct: number | null; // 1st serves in / service points
  firstWonPct: number | null; // points won on 1st serve in / 1st serves in
  secondWonPct: number | null; // points won on 2nd serve / 2nd serve points
  bpSavedPct: number | null; // break points saved / faced
  acesPerMatch: number | null;
}

/** Win/loss record on a given surface. */
export interface SurfaceRecord {
  wins: number;
  losses: number;
}

export interface UpcomingRow {
  id: string;
  tour: TourId;
  tournament_id: string;
  tournament_name: string;
  surface: string;
  commence_time: string; // ISO 8601
  p1_name: string;
  p2_name: string;
  p1_id: number | null; // resolved Sackmann id, if the name matched a known player
  p2_id: number | null;
  p1_odds: number | null; // decimal odds (consensus across books)
  p2_odds: number | null;
  books: number; // how many bookmakers contributed
  source: 'live' | 'fixture';
  updated_at: string;
}

export interface TourConfig {
  id: TourId;
  name: string;
  label: string;
  sackmann: { repo: string; matchesFile: string; playersFile: string };
}

export interface ToursConfig {
  history: { startYear: number; rawBaseUrl: string };
  tours: TourConfig[];
}

export interface TournamentConfig {
  id: string;
  name: string;
  category: string;
  surface: Surface;
  tours: TourId[];
  oddsSportKeys: Record<string, string>;
  sackmannMatch: string[];
}

export interface TournamentsConfig {
  categories: Record<string, string>;
  tournaments: TournamentConfig[];
}

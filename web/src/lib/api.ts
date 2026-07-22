// Typed client for the Tennis Predictor REST API. Types mirror the server's
// response shapes (server/src/types.ts + model/predict.ts).

export interface Tour {
  id: string;
  name: string;
  label: string;
  players: number;
  matches: number;
}

export interface Rating {
  player_id: number;
  tour: string;
  overall: number;
  hard: number;
  clay: number;
  grass: number;
  matches_played: number;
  last_date: string | null;
}

export interface RecentMatch {
  date: string;
  tourney_name: string | null;
  surface: string | null;
  round: string | null;
  score: string | null;
  won: boolean;
  opponent_id: number;
  opponent_name: string | null;
}

export interface Player {
  id: number;
  tour: string;
  name: string;
  hand: string | null;
  country: string | null;
  birthdate: string | null;
}

export interface ServeStats {
  matches: number;
  acePct: number | null;
  dfPct: number | null;
  firstInPct: number | null;
  firstWonPct: number | null;
  secondWonPct: number | null;
  bpSavedPct: number | null;
  acesPerMatch: number | null;
}

export interface SurfaceRecord {
  wins: number;
  losses: number;
}

export interface Profile extends Player {
  rating: Rating;
  eloRank: number;
  serve: ServeStats;
  recent: RecentMatch[];
}

export interface FormSignal {
  sampleSize: number;
  winRate: number;
  weightedWinRate: number;
  streak: number;
  delta: number;
}

export interface H2HMeeting {
  date: string;
  winnerId: number;
  tourney_name: string | null;
  surface: string | null;
  round: string | null;
  score: string | null;
}

export interface H2HSignal {
  total: number;
  p1Wins: number;
  p2Wins: number;
  delta: number;
  recent: H2HMeeting[];
}

export interface EffectiveRating {
  overall: number;
  surface: number | null;
  surfaceKey: string | null;
  effective: number;
}

export interface MarketProbabilities {
  odds1: number;
  odds2: number;
  implied1: number;
  implied2: number;
  overround: number;
}

export interface MarketComparison {
  market: MarketProbabilities | null;
  edge1: number | null;
  verdict: 'value_p1' | 'value_p2' | 'agree' | 'no_market';
}

export interface PlayerLite {
  id: number;
  name: string;
  country: string | null;
}

export interface ReasoningFactor {
  key: 'rating' | 'form' | 'h2h';
  label: string;
  pointsForP1: number;
}

export interface Reasoning {
  factors: ReasoningFactor[];
  topFactor: ReasoningFactor | null;
  text: string;
}

export interface ExpectedScore {
  favoredSide: 1 | 2 | null;
  likelySets: string;
  note: string;
}

export interface Prediction {
  tour: string;
  surface: string;
  players: { p1: PlayerLite; p2: PlayerLite };
  ratings: { p1: EffectiveRating; p2: EffectiveRating };
  ranks: { p1: number; p2: number };
  form: { p1: FormSignal; p2: FormSignal };
  last5: { p1: boolean[]; p2: boolean[] };
  surfaceRecord: { p1: SurfaceRecord; p2: SurfaceRecord };
  serve: { p1: ServeStats; p2: ServeStats };
  h2h: H2HSignal;
  adjustedRatings: { p1: number; p2: number };
  model: { prob1: number; prob2: number };
  market: MarketComparison;
  reasoning: Reasoning;
  expectedScore: ExpectedScore;
  verdict: {
    favoredSide: 1 | 2 | null;
    favoredName: string | null;
    confidence: 'toss_up' | 'slight' | 'clear' | 'strong';
    marginPct: number;
  };
  disclaimer: string;
}

export interface UpcomingMatch {
  id: string;
  tour: string;
  tournament_id: string;
  tournament_name: string;
  surface: string;
  commence_time: string;
  p1_name: string;
  p2_name: string;
  p1_id: number | null;
  p2_id: number | null;
  p1_odds: number | null;
  p2_odds: number | null;
  books: number;
  source: 'live' | 'fixture';
}

export interface UpcomingWithPrediction {
  match: UpcomingMatch;
  prediction: Prediction | null;
}

export interface TournamentInfo {
  id: string;
  name: string;
  category: string;
  surface: string;
  tours: string[];
  hasUpcoming: boolean;
  upcomingCount: number;
}

export interface TournamentsResponse {
  categories: Record<string, string>;
  tournaments: TournamentInfo[];
}

export interface Meta {
  dataSource: string;
  seededAt: string | null;
  updatedAt: string | null;
  oddsSource: string | null;
  oddsRefreshedAt: string | null;
  autoRefreshMinutes: number;
  hasOddsKey: boolean;
  counts: { players: number; matches: number; ratings: number; upcoming: number };
}

export interface RefreshResult {
  ok: boolean;
  source: 'live' | 'fixture';
  count: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  meta: () => get<Meta>('/meta'),
  tours: () => get<Tour[]>('/tours'),
  tournaments: (tour?: string) =>
    get<TournamentsResponse>(`/tournaments${tour ? `?tour=${encodeURIComponent(tour)}` : ''}`),
  upcoming: (tour?: string, tournament?: string) => {
    const q = new URLSearchParams();
    if (tour) q.set('tour', tour);
    if (tournament) q.set('tournament', tournament);
    return get<UpcomingWithPrediction[]>(`/matches/upcoming?${q.toString()}`);
  },
  prediction: (id: string) => get<UpcomingWithPrediction>(`/predictions/${encodeURIComponent(id)}`),
  profile: (tour: string, id: number) => get<Profile>(`/players/${tour}/${id}`),
  refresh: () => post<RefreshResult>('/refresh'),
};

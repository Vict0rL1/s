// Cliente tipado de la NHL (/api/nhl/*). Una liga; el moneyline incluye prórroga y tanda.

import type { MatchOutcome } from './outcome';

export interface NhlRecord {
  wins: number;
  losses: number;
}

export interface NhlTeamInfo {
  id: string;
  name: string;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  season: number | null;
  record: NhlRecord;
  homeRecord: NhlRecord;
  awayRecord: NhlRecord;
  goalsFor: number | null;
  goalsAgainst: number | null;
  lastDate: string | null;
  form: { date: string; opponentId: string; opponentName: string; home: boolean; result: 'W' | 'L'; goalsFor: number; goalsAgainst: number }[];
}

export interface NhlSide extends NhlTeamInfo {
  last5: ('W' | 'L')[];
  expectedGoals: number;
}

export interface NhlPrediction {
  league: 'nhl';
  teams: { home: NhlSide; away: NhlSide };
  model: { home: number; away: number };
  final: { home: number; away: number };
  postprocess: { calibrator: 'platt' | 'isotonic' | 'ninguno'; weight: number | null; disagreement: number | null; note?: string };
  /** A 60 minutos: gana el local, empate (va a la prórroga) o gana el visitante. */
  regulation: { home: number; draw: number; away: number };
  goals: { home: number; away: number; total: number };
  total: { line: number; over: number; under: number; push: number; fromMarket: boolean; odds: { over: number; under: number } | null };
  scorelines: { home: number; away: number; label: string; probability: number }[];
  h2h: { total: number; homeWins: number; awayWins: number; recent: { date: string; homeId: string; awayId: string; homeGoals: number; awayGoals: number }[] };
  market: {
    market: { odds: { home: number; away: number }; home: number; away: number; overround: number } | null;
    edge: { home: number; away: number } | null;
    verdict: 'differs_home' | 'differs_away' | 'agree' | 'no_market';
  };
  reasoning: { factors: { key: string; label: string; pointsForHome: number }[] };
  reliability: { level: 'high' | 'medium' | 'low'; label: string; marginPp: number; reasons: string[]; gamesBehind: { home: number; away: number } };
  verdict: { label: string; close: boolean; marginPp: number };
  summary: { headline: string; bullets: string[] };
  context: { homeAdvantageElo: number; k: number; leagueGoals: number };
  disclaimer: string;
}

export interface NhlGameRow {
  id: string;
  league: string;
  season: number | null;
  game_id: number | null;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  odds_home: number | null;
  odds_away: number | null;
  total_line: number | null;
  odds_over: number | null;
  odds_under: number | null;
  books: number;
  source: 'live' | 'schedule';
  updated_at: string;
}

export interface NhlGameWithPrediction {
  confianza?: import('./trust').EvaluacionConfianza | null;
  prePartido?: import('./trust').PrePartidoRef | null;
  game: NhlGameRow;
  outcome: MatchOutcome;
  prediction: NhlPrediction | null;
  teams: { home: NhlTeamInfo | null; away: NhlTeamInfo | null };
  linesFromMarket: boolean;
}

export interface NhlMeta {
  updatedAt: string | null;
  calendarAt: string | null;
  oddsRefreshedAt: string | null;
  oddsFallbackReason: string | null;
  oddsFallbackDetail: string | null;
  hasOddsKey: boolean;
  autoRefreshMinutes: number;
  bands: { desde: number; n: number; acierto: number }[] | null;
  counts: { teams: number; games: number };
  historyThrough: string | null;
  league: { homeAdvantageElo: number; k: number; goalsPerGame: number };
}

export interface NhlTrackRecord {
  resolved: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  totalMae: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  vsMarket: { n: number; modelBrier: number; marketBrier: number; modelAccuracy: number; marketAccuracy: number } | null;
  recent: { date: string | null; home: string | null; away: string | null; probHome: number; homeGoals: number; awayGoals: number; hit: boolean }[];
}

const BASE = '/api/nhl';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const nhlApi = {
  meta: () => get<NhlMeta>('/meta'),
  upcoming: (limit = 24) => get<NhlGameWithPrediction[]>(`/games/upcoming?limit=${limit}`),
  game: (id: string) => get<NhlGameWithPrediction>(`/games/${encodeURIComponent(id)}`),
  team: (id: string) => get<NhlTeamInfo>(`/teams/${encodeURIComponent(id)}`),
  power: () => get<{ teams: { id: string; name: string; elo: number; games: number }[] }>('/power'),
  trackRecord: () => get<NhlTrackRecord>('/track-record'),
  refresh: async () => {
    const res = await fetch(`${BASE}/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; stored: number }>;
  },
};

// Cliente tipado de la UFC (/api/ufc/*). `home_*` es el luchador A y `away_*` el B: no hay local
// (A es el de id de ufcstats menor). Ganador a dos vías: el empate y el «sin resultado» devuelven.

import type { MatchOutcome } from './outcome';

export type ResultadoPelea = 'W' | 'L' | 'D' | 'NC';

export interface UfcFighterInfo {
  id: string;
  name: string;
  nickname: string | null;
  elo: number;
  eloRank: number | null;
  fightsInDb: number;
  record: { wins: number; losses: number; draws: number; noContests: number };
  smoothedRecord: number;
  age: number | null;
  birthDate: string | null;
  heightCm: number | null;
  reachCm: number | null;
  stance: string | null;
  weightClass: string | null;
  lastDate: string | null;
  form: { date: string; opponentId: string | null; opponentName: string; result: ResultadoPelea; method: string | null; round: number | null }[];
}

export interface UfcSide extends UfcFighterInfo {
  last5: ResultadoPelea[];
}

export type RasgoUfc = 'elo' | 'record' | 'edad' | 'alcance' | 'experiencia';

export interface UfcFactor {
  key: RasgoUfc;
  label: string;
  diff: number | null;
  logit: number;
  /** Puntos de probabilidad para A (negativo: para B). */
  pp: number;
}

export interface UfcPrediction {
  league: 'ufc';
  fighters: { home: UfcSide; away: UfcSide };
  model: { home: number; away: number };
  final: { home: number; away: number };
  rasgos: Record<RasgoUfc, number>;
  factors: UfcFactor[];
  h2h: { date: string; result: ResultadoPelea; method: string | null; round: number | null }[];
  market: {
    market: { odds: { home: number; away: number }; home: number; away: number; overround: number } | null;
    edge: { home: number; away: number } | null;
    verdict: 'differs_home' | 'differs_away' | 'agree' | 'no_market';
  };
  reliability: { level: 'high' | 'medium' | 'low'; label: string; marginPp: number; reasons: string[]; fightsBehind: { home: number; away: number } };
  verdict: { label: string; close: boolean; marginPp: number };
  summary: { headline: string; bullets: string[] };
  context: { modelo: string; pesos: Record<string, number>; ajustadaCon: number; holdoutDesde: number };
  disclaimer: string;
}

export interface UfcFightRow {
  id: string;
  league: string;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  odds_home: number | null;
  odds_away: number | null;
  books: number;
  source: 'live';
  updated_at: string;
}

export interface UfcFightWithPrediction {
  confianza?: import('./trust').EvaluacionConfianza | null;
  prePartido?: import('./trust').PrePartidoRef | null;
  fight: UfcFightRow;
  outcome: MatchOutcome;
  prediction: UfcPrediction | null;
  /** Por qué una pelea de la cartelera no tiene número (debut o nombre compartido). */
  sinPrediccion: string | null;
  fighters: { home: UfcFighterInfo | null; away: UfcFighterInfo | null };
}

export interface UfcMeta {
  updatedAt: string | null;
  oddsRefreshedAt: string | null;
  oddsFallbackReason: string | null;
  oddsFallbackDetail: string | null;
  hasOddsKey: boolean;
  autoRefreshMinutes: number;
  bands: { desde: number; n: number; acierto: number }[] | null;
  counts: { fighters: number; fights: number };
  historyThrough: string | null;
  descartadas: number;
  sinIdentificar: number;
  model: { candidato: string; rasgos: RasgoUfc[]; holdoutDesde: number };
}

export interface UfcTrackRecord {
  resolved: number;
  sinGanador: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  vsMarket: { n: number; modelBrier: number; marketBrier: number; modelAccuracy: number; marketAccuracy: number } | null;
  recent: { date: string | null; home: string | null; away: string | null; probHome: number; outcome: 'A' | 'B'; method: string | null; hit: boolean }[];
}

const BASE = '/api/ufc';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const ufcApi = {
  meta: () => get<UfcMeta>('/meta'),
  upcoming: (limit = 40) => get<UfcFightWithPrediction[]>(`/fights/upcoming?limit=${limit}`),
  fight: (id: string) => get<UfcFightWithPrediction>(`/fights/${encodeURIComponent(id)}`),
  fighter: (id: string) => get<UfcFighterInfo>(`/fighters/${encodeURIComponent(id)}`),
  power: (limit = 40) => get<{ fighters: { id: string; name: string; elo: number; fights: number }[] }>(`/power?limit=${limit}`),
  trackRecord: () => get<UfcTrackRecord>('/track-record'),
  refresh: async () => {
    const res = await fetch(`${BASE}/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; stored: number }>;
  },
};

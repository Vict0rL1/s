// Types and client for the bet log.
//
// Money is left unlabelled on purpose — no €, no $. The same numbers work whether
// you stake euros, pesos or units, and inventing a currency the user never chose
// would be wrong on most installs.

export type BetStatus = 'pending' | 'won' | 'lost' | 'void' | 'half_won' | 'half_lost' | 'cashout';

export interface Bet {
  id: number;
  created_at: string;
  placed_on: string;
  sport: string;
  league: string | null;
  event: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  status: BetStatus;
  payout: number | null;
  settled_at: string | null;
  notes: string | null;
  model_prob: number | null;
  market_prob: number | null;
  match_key: string | null;
  /** null while pending — never 0, which would claim a settled break-even. */
  profit: number | null;
  risked: number;
  withModel: boolean | null;
}

export interface BetGroupSummary {
  key: string;
  bets: number;
  settled: number;
  staked: number;
  risked: number;
  profit: number;
  roi: number | null;
  wins: number;
  losses: number;
  hitRate: number | null;
}

export interface BetSummary {
  totals: BetGroupSummary;
  pending: { bets: number; staked: number };
  bySport: BetGroupSummary[];
  byMarket: BetGroupSummary[];
  daily: { day: string; profit: number; bets: number; settled: number; staked: number }[];
  cumulative: { day: string; profit: number }[];
  modelAgreement: { with: BetGroupSummary; against: BetGroupSummary } | null;
  best: Bet | null;
  worst: Bet | null;
  longestWinStreak: number;
  longestLoseStreak: number;
}

export interface BetCandidateSide {
  label: string;
  modelProb: number | null;
  marketProb: number | null;
  odds: number | null;
}

export interface BetCandidate {
  sport: string;
  league: string | null;
  event: string;
  commenceTime: string;
  matchKey: string;
  sides: BetCandidateSide[];
}

export interface BetInput {
  placed_on?: string;
  sport: string;
  league?: string | null;
  event: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  status?: BetStatus;
  payout?: number | null;
  notes?: string | null;
  model_prob?: number | null;
  market_prob?: number | null;
  match_key?: string | null;
}

export interface FieldError {
  field: string;
  message: string;
}

const BASE = '/api/bets';

/**
 * A failed write carries the server's per-field messages.
 *
 * Thrown rather than returned so a caller cannot forget to check, and typed so the
 * form can put each message under the field it belongs to instead of showing one
 * generic "something went wrong".
 */
export class BetRequestError extends Error {
  constructor(public errors: FieldError[]) {
    super(errors.map((e) => e.message).join(' '));
    this.name = 'BetRequestError';
  }
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (res.status === 204) return undefined as T;
  const body = res.status === 400 || res.ok ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (body && Array.isArray((body as { errors?: FieldError[] }).errors)) {
      throw new BetRequestError((body as { errors: FieldError[] }).errors);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return body as T;
}

export const fetchBets = (q: Record<string, string> = {}) =>
  send<{ bets: Bet[] }>(`${BASE}?${new URLSearchParams(q)}`).then((r) => r.bets);

export const fetchBetSummary = (q: Record<string, string> = {}) =>
  send<BetSummary>(`${BASE}/summary?${new URLSearchParams(q)}`);

export const fetchBetCandidates = () =>
  send<{ candidates: BetCandidate[] }>(`${BASE}/candidates`).then((r) => r.candidates);

export const createBet = (input: BetInput) =>
  send<Bet>(BASE, { method: 'POST', body: JSON.stringify(input) });

export const patchBet = (id: number, patch: Partial<BetInput>) =>
  send<Bet>(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteBet = (id: number) => send<void>(`${BASE}/${id}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Labels and formatting
// ---------------------------------------------------------------------------
export const STATUS_LABEL: Record<BetStatus, string> = {
  pending: 'Pendiente',
  won: 'Ganada',
  lost: 'Perdida',
  void: 'Anulada',
  half_won: 'Media ganada',
  half_lost: 'Media perdida',
  cashout: 'Cashout',
};

export const MARKET_LABEL: Record<string, string> = {
  moneyline: 'Ganador',
  spread: 'Hándicap',
  total: 'Total',
  btts: 'Ambos marcan',
  score: 'Marcador',
  other: 'Otro',
};

export const SPORT_LABEL: Record<string, string> = {
  football: 'Fútbol',
  basketball: 'Baloncesto',
  baseball: 'Béisbol',
  nfl: 'NFL',
  tennis: 'Tenis',
  other: 'Otro',
};

/** A signed amount, always with its sign — so colour is never the only cue. */
export function signed(n: number, digits = 2): string {
  const s = n.toFixed(digits).replace(/\.00$/, '');
  return n > 0 ? `+${s}` : s;
}

export function money(n: number, digits = 2): string {
  return n.toFixed(digits).replace(/\.00$/, '');
}

export function pctSigned(n: number): string {
  const s = (n * 100).toFixed(1);
  return n > 0 ? `+${s}%` : `${s}%`;
}

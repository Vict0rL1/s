// The bet log: what was actually staked, and what it returned.
//
// ===========================================================================
// WHY THIS IS SEPARATE FROM THE PREDICTION LOG
// ===========================================================================
// The five prediction logs record what the MODEL claimed. This records what the
// PERSON did. Keeping them apart matters: a model's accuracy must not depend on
// which games somebody felt like backing, and a bettor's profit must not be
// flattered by only counting the games the model happened to like.
//
// They meet in one place — `model_prob` and `market_prob`, captured at the moment
// a bet is logged. That is what lets this answer the question a bookmaker's own
// app never will: WHEN I AGREED WITH THE MODEL, DID I DO BETTER?
//
// ===========================================================================
// PROFIT IS DERIVED, NEVER STORED
// ===========================================================================
// Correcting a status ("actually that was void") is the most common edit here,
// and a stored profit column would go stale on every one of them. So profit is a
// pure function of (status, stake, odds, payout), computed on read. One source of
// truth, and no migration needed the day a new status appears.

import { getDb } from './db.ts';

export type BetStatus = 'pending' | 'won' | 'lost' | 'void' | 'half_won' | 'half_lost' | 'cashout';

export const BET_STATUSES: BetStatus[] = [
  'pending',
  'won',
  'lost',
  'void',
  'half_won',
  'half_lost',
  'cashout',
];

/** Markets a bet can be on. `other` exists so nothing is unloggable. */
export const BET_MARKETS = ['moneyline', 'spread', 'total', 'btts', 'score', 'other'] as const;
export const BET_SPORTS = ['football', 'basketball', 'baseball', 'nfl', 'tennis', 'other'] as const;

export interface BetRow {
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
}

export interface Bet extends BetRow {
  /** Net result. null while pending — 0 would claim a settled break-even. */
  profit: number | null;
  /** Stake at risk, i.e. 0 once a bet is void. Denominator for ROI. */
  risked: number;
  /** True when the bet backed the side the model preferred. */
  withModel: boolean | null;
}

/**
 * What a bet returned, net of the stake.
 *
 * `null` for pending is deliberate and load-bearing: 0 would mean "settled at
 * break-even", and averaging a pile of not-yet-known results as zeroes is how a
 * tracker quietly reports a 0% ROI on an unfinished week.
 */
export function profitOf(b: Pick<BetRow, 'status' | 'stake' | 'odds' | 'payout'>): number | null {
  const win = b.stake * (b.odds - 1);
  switch (b.status) {
    case 'pending':
      return null;
    case 'won':
      return win;
    case 'lost':
      return -b.stake;
    // A void bet is refunded: no profit, and — see `riskedOf` — no stake risked
    // either, or every push would drag ROI toward zero.
    case 'void':
      return 0;
    // Asian handicaps and quarter-goal lines settle half the stake.
    case 'half_won':
      return win / 2;
    case 'half_lost':
      return -b.stake / 2;
    // Cashing out breaks the link between odds and return, so the amount that
    // came back is the only thing that can be believed.
    case 'cashout':
      return b.payout != null ? b.payout - b.stake : null;
    default:
      return null;
  }
}

/** Stake that was genuinely at risk. Void returns nothing, so it risks nothing. */
export function riskedOf(b: Pick<BetRow, 'status' | 'stake'>): number {
  if (b.status === 'void') return 0;
  if (b.status === 'half_won' || b.status === 'half_lost') return b.stake / 2;
  return b.stake;
}

/**
 * Did this bet back the side the model liked?
 *
 * Only answerable when both probabilities were captured AND they disagree enough
 * to mean anything. A bet on a side the model gave 50.2% is not "with the model",
 * it is a coin flip the model also called a coin flip, and counting it either way
 * would just add noise to the comparison.
 */
const AGREEMENT_THRESHOLD = 0.02;

function withModelOf(b: Pick<BetRow, 'model_prob' | 'market_prob'>): boolean | null {
  if (b.model_prob == null || b.market_prob == null) return null;
  const edge = b.model_prob - b.market_prob;
  if (Math.abs(edge) < AGREEMENT_THRESHOLD) return null;
  return edge > 0;
}

function decorate(r: BetRow): Bet {
  return { ...r, profit: profitOf(r), risked: riskedOf(r), withModel: withModelOf(r) };
}

const SELECT = `SELECT id, created_at, placed_on, sport, league, event, market, selection,
                       odds, stake, status, payout, settled_at, notes,
                       model_prob, market_prob, match_key
                  FROM bets`;

export interface BetFilter {
  from?: string;
  to?: string;
  sport?: string;
  status?: string;
}

/** What node:sqlite accepts as a bound parameter. */
type SqlParam = string | number | null;

export function listBets(f: BetFilter = {}): Bet[] {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (f.from) {
    where.push('placed_on >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('placed_on <= ?');
    params.push(f.to);
  }
  if (f.sport) {
    where.push('sport = ?');
    params.push(f.sport);
  }
  if (f.status) {
    where.push('status = ?');
    params.push(f.status);
  }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY placed_on DESC, id DESC`;
  return (getDb().prepare(sql).all(...params) as unknown as BetRow[]).map(decorate);
}

export function getBet(id: number): Bet | null {
  const r = getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as BetRow | undefined;
  return r ? decorate(r) : null;
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

/** Today in the SERVER's local zone, which is where the user is. */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createBet(input: BetInput): Bet {
  const status = input.status ?? 'pending';
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO bets (created_at, placed_on, sport, league, event, market, selection,
                         odds, stake, status, payout, settled_at, notes,
                         model_prob, market_prob, match_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now,
      input.placed_on || today(),
      input.sport,
      input.league ?? null,
      input.event,
      input.market,
      input.selection,
      input.odds,
      input.stake,
      status,
      input.payout ?? null,
      status === 'pending' ? null : now,
      input.notes ?? null,
      input.model_prob ?? null,
      input.market_prob ?? null,
      input.match_key ?? null,
    );
  return getBet(Number(info.lastInsertRowid)) as Bet;
}

/** Patch a bet. Only the fields present are touched. */
export function updateBet(id: number, patch: Partial<BetInput>): Bet | null {
  const existing = getBet(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: SqlParam[] = [];
  const put = (col: string, value: SqlParam) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };

  for (const col of [
    'placed_on', 'sport', 'league', 'event', 'market', 'selection',
    'odds', 'stake', 'status', 'payout', 'notes', 'model_prob', 'market_prob', 'match_key',
  ] as const) {
    if (col in patch) put(col, ((patch as Record<string, unknown>)[col] ?? null) as SqlParam);
  }
  // Settling stamps the time; un-settling clears it, so a status corrected back
  // to pending does not keep a settlement date it no longer has.
  if (patch.status) {
    put('settled_at', patch.status === 'pending' ? null : new Date().toISOString());
  }
  if (sets.length === 0) return existing;

  params.push(id);
  getDb().prepare(`UPDATE bets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getBet(id);
}

export function deleteBet(id: number): boolean {
  return getDb().prepare('DELETE FROM bets WHERE id = ?').run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
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
  /** Daily net profit, for the calendar. Only days with settled bets appear. */
  daily: { day: string; profit: number; bets: number; settled: number; staked: number }[];
  /** Running profit in chronological order, for the curve. */
  cumulative: { day: string; profit: number }[];
  /**
   * Did agreeing with the model help? Split only over bets where the question
   * is answerable — both probabilities captured and a real disagreement.
   */
  modelAgreement: { with: BetGroupSummary; against: BetGroupSummary } | null;
  /** Biggest single win and loss, because they explain a lot of any ROI. */
  best: Bet | null;
  worst: Bet | null;
  longestWinStreak: number;
  longestLoseStreak: number;
}

function emptyGroup(key: string): BetGroupSummary {
  return { key, bets: 0, settled: 0, staked: 0, risked: 0, profit: 0, roi: null, wins: 0, losses: 0, hitRate: null };
}

function accumulate(group: BetGroupSummary, b: Bet): void {
  group.bets++;
  group.staked += b.stake;
  if (b.profit == null) return; // pending contributes nothing but the count
  group.settled++;
  group.risked += b.risked;
  group.profit += b.profit;
  if (b.profit > 0) group.wins++;
  else if (b.profit < 0) group.losses++;
}

function finish(group: BetGroupSummary): BetGroupSummary {
  // ROI is profit over stake AT RISK, not over everything ever staked: a refunded
  // void neither won nor lost, and letting it inflate the denominator would make
  // a run of pushes look like a slow bleed.
  group.roi = group.risked > 0 ? group.profit / group.risked : null;
  const decided = group.wins + group.losses;
  group.hitRate = decided > 0 ? group.wins / decided : null;
  // Round money at the edge, once, so the UI never has to.
  group.staked = round2(group.staked);
  group.risked = round2(group.risked);
  group.profit = round2(group.profit);
  return group;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarizeBets(f: BetFilter = {}): BetSummary {
  const bets = listBets(f);

  const totals = emptyGroup('total');
  const pending = { bets: 0, staked: 0 };
  const bySport = new Map<string, BetGroupSummary>();
  const byMarket = new Map<string, BetGroupSummary>();
  const days = new Map<string, { profit: number; bets: number; settled: number; staked: number }>();
  const withModel = emptyGroup('with');
  const againstModel = emptyGroup('against');
  let answerable = 0;

  for (const b of bets) {
    accumulate(totals, b);
    if (b.profit == null) {
      pending.bets++;
      pending.staked += b.stake;
    }

    const sport = bySport.get(b.sport) ?? emptyGroup(b.sport);
    accumulate(sport, b);
    bySport.set(b.sport, sport);

    const market = byMarket.get(b.market) ?? emptyGroup(b.market);
    accumulate(market, b);
    byMarket.set(b.market, market);

    const day = days.get(b.placed_on) ?? { profit: 0, bets: 0, settled: 0, staked: 0 };
    day.bets++;
    day.staked += b.stake;
    if (b.profit != null) {
      day.profit += b.profit;
      day.settled++;
    }
    days.set(b.placed_on, day);

    if (b.withModel != null) {
      answerable++;
      accumulate(b.withModel ? withModel : againstModel, b);
    }
  }

  const daily = [...days.entries()]
    .map(([day, d]) => ({ day, profit: round2(d.profit), bets: d.bets, settled: d.settled, staked: round2(d.staked) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  let running = 0;
  const cumulative = daily.map((d) => {
    running += d.profit;
    return { day: d.day, profit: round2(running) };
  });

  // Streaks over settled bets in chronological order. Void breaks nothing — it
  // is not a result — so it is skipped rather than counted as a loss.
  const chrono = bets
    .filter((b) => b.profit != null && b.status !== 'void')
    .sort((a, b) => a.placed_on.localeCompare(b.placed_on) || a.id - b.id);
  let win = 0;
  let lose = 0;
  let bestWin = 0;
  let worstLose = 0;
  for (const b of chrono) {
    if ((b.profit as number) > 0) {
      win++;
      lose = 0;
    } else if ((b.profit as number) < 0) {
      lose++;
      win = 0;
    }
    bestWin = Math.max(bestWin, win);
    worstLose = Math.max(worstLose, lose);
  }

  const settled = bets.filter((b) => b.profit != null);
  const best = settled.reduce<Bet | null>((m, b) => (!m || (b.profit as number) > (m.profit as number) ? b : m), null);
  const worst = settled.reduce<Bet | null>((m, b) => (!m || (b.profit as number) < (m.profit as number) ? b : m), null);

  return {
    totals: finish(totals),
    pending: { bets: pending.bets, staked: round2(pending.staked) },
    bySport: [...bySport.values()].map(finish).sort((a, b) => b.bets - a.bets),
    byMarket: [...byMarket.values()].map(finish).sort((a, b) => b.bets - a.bets),
    daily,
    cumulative,
    // Below a handful of answerable bets the split is noise dressed as a finding,
    // so it is withheld rather than shown with a caveat nobody reads.
    modelAgreement:
      answerable >= 10 ? { with: finish(withModel), against: finish(againstModel) } : null,
    best,
    worst,
    longestWinStreak: bestWin,
    longestLoseStreak: worstLose,
  };
}

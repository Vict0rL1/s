// The Odds API quota: how much is left, and refusing to spend what isn't there.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// The free plan is 500 requests a month, and this app burned through it in two
// and a half days. The arithmetic, which nothing in the code was doing:
//
//   The Odds API charges 1 credit PER MARKET PER REGION on every /odds call.
//   A single call asking for h2h,spreads,totals across eu,uk is 3 × 2 = SIX
//   credits, not one. The /sports listing is free.
//
// Per auto-refresh cycle, before this file:
//
//   tennis        ~4 active tournaments × 1 market × 2 regions =  8
//   basketball     7 leagues            × 1        × 2         = 14
//   football      13 leagues            × 1        × 2         = 26
//                                                          ──────
//                                                              48 credits
//
//   × 4 cycles a day (the 6-hour default) × 30 days      = 5,760 a month
//
// Against a 500 quota. Changing the API key buys another two days and then the
// same thing happens, which is why the fix is here and not in the .env.
//
// ===========================================================================
// WHAT CHANGED
// ===========================================================================
//   1. ONE REGION by default instead of two. `eu,uk` doubled the price of every
//      single call for a second opinion on the same prices. Halves everything.
//   2. The quota is READ and REMEMBERED. Every response carries
//      x-requests-remaining and x-requests-used; those are now stored, shown in
//      the app, and checked before spending.
//   3. A RESERVE. Below it, requests are refused rather than attempted, so the
//      last few credits stay available for a refresh you actually asked for
//      instead of being eaten by a background timer at 4am.
//   4. The /sports listing is fetched ONCE and shared. It is free, but five
//      sports were each making their own call every cycle.
//
// After: one region, active leagues only, a 12-hour default — about 8 credits a
// cycle, twice a day, ~480 a month. Inside the free plan, with the reserve as
// the backstop if a month runs long.

import { getMeta, setMeta } from './db.ts';
import { env } from './config.ts';

export const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

/**
 * Credits held back for the ↻ button.
 *
 * A background timer that spends the last credit means the refresh a person
 * actually asked for is the one that fails. Manual refreshes may dip into the
 * reserve; automatic ones may not.
 */
const RESERVE_FLOOR = 25;
const RESERVE_SHARE = 0.02;

/**
 * Credits held back for the ↻ button, as a share of the plan.
 *
 * A background timer that spends the last credit means the refresh a person
 * actually asked for is the one that fails. Manual refreshes may dip into the
 * reserve; automatic ones may not.
 *
 * It scales because it has to: 25 credits was a meaningful cushion on the 500
 * free plan and is less than one refresh cycle on a 20,000 one. Two per cent —
 * 25 on the free plan, 400 on 20,000 — keeps it worth roughly the same number of
 * manual refreshes on any plan.
 */
export function quotaReserve(): number {
  const total = planTotal();
  if (total == null) return RESERVE_FLOOR;
  return Math.max(RESERVE_FLOOR, Math.round(total * RESERVE_SHARE));
}

const KEY_REMAINING = 'odds:requestsRemaining';
const KEY_USED = 'odds:requestsUsed';
const KEY_CHECKED = 'odds:quotaCheckedAt';
/** Largest remaining+used ever seen — i.e. the size of the plan. */
const KEY_PLAN = 'odds:planTotal';
/** Credits the last completed auto-refresh cycle spent. */
const KEY_CYCLE = 'odds:lastCycleCredits';
/** Set when a key is rejected, so the UI can say WHY rather than "0 partidos". */
const KEY_ERROR = 'odds:lastError';

export interface OddsQuota {
  remaining: number | null;
  used: number | null;
  checkedAt: string | null;
  /** The message from the last refusal or rejected key, if any. */
  lastError: string | null;
}

export function getQuota(): OddsQuota {
  const num = (k: string) => {
    const v = getMeta(k);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    remaining: num(KEY_REMAINING),
    used: num(KEY_USED),
    checkedAt: getMeta(KEY_CHECKED),
    lastError: getMeta(KEY_ERROR),
  };
}

/**
 * Record what the API just told us about the quota.
 *
 * These headers come back on every /odds response, including failed ones, so
 * this is the cheapest possible way to know where we stand — no extra request.
 */
export function recordQuota(res: Response): void {
  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  if (remaining != null) setMeta(KEY_REMAINING, remaining);
  if (used != null) setMeta(KEY_USED, used);
  if (remaining != null || used != null) setMeta(KEY_CHECKED, new Date().toISOString());

  // LEARN THE SIZE OF THE PLAN instead of being told it.
  //
  // remaining + used is the plan's monthly allowance, and it arrives free on
  // every response. Nothing else in the app has to be configured when the plan
  // changes — going from 500 to 20,000 credits is noticed on the first call, and
  // the reserve and the refresh interval follow from it.
  //
  // The maximum is kept rather than the latest: mid-month the two numbers still
  // add up to the plan, but a reset can be observed between two responses and a
  // momentary low reading should not shrink the plan permanently.
  const r = Number(remaining);
  const u = Number(used);
  if (Number.isFinite(r) && Number.isFinite(u)) {
    const total = r + u;
    const known = planTotal();
    if (total > 0 && (known == null || total > known)) setMeta(KEY_PLAN, String(total));
  }
}

/** The plan's monthly credit allowance, learned from the response headers. */
export function planTotal(): number | null {
  const v = Number(getMeta(KEY_PLAN));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Remember what a full refresh cycle cost, so the interval can be derived. */
export function recordCycleSpend(credits: number): void {
  if (credits > 0) setMeta(KEY_CYCLE, String(credits));
}

export function lastCycleCredits(): number | null {
  const v = Number(getMeta(KEY_CYCLE));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Target share of the plan to spend on automatic refreshes.
 *
 * The rest absorbs what a straight-line estimate cannot see coming: leagues
 * arriving in season (thirteen football leagues are configured and maybe five
 * play in any given week), and manual refreshes.
 */
const AUTO_BUDGET_SHARE = 0.6;

/** Half an hour. These markets do not move fast enough to justify closer. */
const MIN_REFRESH_MINUTES = 30;
/**
 * A week.
 *
 * It has to be longer than a day, and that is not hypothetical: on the 500-credit
 * free plan a 34-credit cycle can only run about nine times a month, so the
 * honest interval is roughly every three days. Clamping at 24 h instead made the
 * arithmetic recommend 1,020 credits a month against a 500 plan — 204% of it —
 * and quietly handed the job of not overspending to the pace guard, which is a
 * backstop and should not be load-bearing.
 */
const MAX_REFRESH_MINUTES = 10_080;

/**
 * How often to refresh, derived from the plan rather than guessed.
 *
 * A hardcoded interval is wrong the moment the plan or the number of leagues
 * changes — the same failure as any constant that describes something else. This
 * divides the month's automatic budget by what a cycle actually costs, measured
 * on the last cycle:
 *
 *     cycles a month = plan × 0.6 / credits per cycle
 *     minutes apart  = 43,200 / cycles a month
 *
 * With 34 credits a cycle: the 500 free plan lands on ~24 h, a 20,000 plan on
 * ~1 h. Returns null until a cycle has been measured, so the caller keeps its
 * configured default for the first run.
 */
export function recommendedRefreshMinutes(): number | null {
  const total = planTotal();
  const perCycle = lastCycleCredits();
  if (total == null || perCycle == null) return null;
  const cyclesPerMonth = (total * AUTO_BUDGET_SHARE) / perCycle;
  if (!Number.isFinite(cyclesPerMonth) || cyclesPerMonth <= 0) return null;
  const minutes = Math.round(43_200 / cyclesPerMonth);
  return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, minutes));
}

/**
 * Are we ahead of a straight-line burn for the month?
 *
 * The interval above sets the pace; this is the backstop for when reality
 * disagrees with it — a dozen leagues coming into season at once, or a day of
 * enthusiastic manual refreshing. Automatic spending stops until the calendar
 * catches up; manual refreshes are never blocked by it.
 *
 * The plan's reset date is not published, so this assumes the calendar month.
 * If the real reset falls mid-month the guard is merely conservative early and
 * relaxes afterwards, which is the right way round to be wrong.
 */
export function withinMonthlyPace(credits: number): { ok: true } | { ok: false; reason: string } {
  const total = planTotal();
  const { used } = getQuota();
  if (total == null || used == null) return { ok: true };

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  // +1 so the first day of the month has a day's worth of budget, not zero.
  const elapsed = Math.min(daysInMonth, now.getDate());
  const allowedSoFar = (total * AUTO_BUDGET_SHARE * elapsed) / daysInMonth;

  if (used + credits > allowedSoFar) {
    return {
      ok: false,
      reason:
        `ritmo mensual: llevas ${used} de las ${Math.round(allowedSoFar)} peticiones que tocan a día ` +
        `${elapsed} de ${daysInMonth} (presupuesto automático ${Math.round(total * AUTO_BUDGET_SHARE)} de ${total}). ` +
        'Las actualizaciones manuales siguen disponibles.',
    };
  }
  return { ok: true };
}

export function setOddsError(message: string | null): void {
  setMeta(KEY_ERROR, message ?? '');
}

/** How many credits a call for these markets costs, given the configured regions. */
export function creditCost(markets: string): number {
  const m = markets.split(',').filter(Boolean).length || 1;
  const r = env.oddsRegions.split(',').filter(Boolean).length || 1;
  return m * r;
}

/**
 * May we spend this many credits?
 *
 * `manual` marks a refresh a person clicked, which is allowed into the reserve.
 * Returns a reason when the answer is no, so callers can log something useful
 * instead of failing silently.
 */
export function canSpend(credits: number, manual = false): { ok: true } | { ok: false; reason: string } {
  const { remaining } = getQuota();
  if (remaining == null) return { ok: true }; // never called yet — find out by trying
  const reserve = quotaReserve();
  const floor = manual ? 0 : reserve;
  if (remaining - credits < floor) {
    return {
      ok: false,
      reason:
        `quedan ${remaining} peticiones del plan de The Odds API y esta operación cuesta ${credits}` +
        (manual ? '' : ` (se reservan ${reserve} para las actualizaciones manuales)`),
    };
  }
  // The reserve protects the END of the plan; the pace guard protects the middle
  // of the month, which is where a plan forty times bigger actually gets lost —
  // not by running to zero but by spending three weeks' worth in three days.
  if (!manual) {
    const pace = withinMonthlyPace(credits);
    if (!pace.ok) return pace;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The free /sports listing, fetched once
// ---------------------------------------------------------------------------
export interface SportListing {
  key: string;
  active: boolean;
  has_outrights: boolean;
  title?: string;
  description?: string;
}

let cache: { at: number; sports: SportListing[] } | null = null;
/** Long enough that one refresh cycle makes one call; short enough to notice a
 *  tournament starting. The listing is free either way. */
const CACHE_MS = 10 * 60_000;

/**
 * Which sports are in season right now.
 *
 * FREE — it does not touch the quota, which is exactly why it is worth calling:
 * skipping a request for a league that is not playing costs nothing and saves
 * however many credits that request would have cost. Thirteen football leagues
 * are configured and maybe five are in season in any given week.
 */
export async function listSports(): Promise<SportListing[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.sports;
  const res = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${encodeURIComponent(env.oddsApiKey)}`);
  recordQuota(res);
  if (res.status === 401) {
    const msg = 'The Odds API rechazó la clave (401). Revisa ODDS_API_KEY en tu .env.';
    setOddsError(msg);
    throw new Error(msg);
  }
  if (res.status === 429) {
    const msg = 'The Odds API: cupo agotado (429). El plan gratuito son 500 peticiones al mes.';
    setOddsError(msg);
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(`Odds API /sports: HTTP ${res.status}`);
  const sports = (await res.json()) as SportListing[];
  setOddsError(null);
  cache = { at: Date.now(), sports };
  return sports;
}

/** The subset of `wanted` that is actually in season. */
export async function activeKeys(wanted: Iterable<string>): Promise<Set<string>> {
  const want = new Set(wanted);
  const active = new Set<string>();
  for (const s of await listSports()) {
    if (s.active && !s.has_outrights && want.has(s.key)) active.add(s.key);
  }
  return active;
}

/**
 * One /odds request, quota-aware.
 *
 * Returns null when the call was skipped — out of season, or no credits — rather
 * than throwing, because "this league is not playing" is the normal case and not
 * an error. `skipped` says which it was so the caller can log it.
 */
export async function fetchOdds(
  sportKey: string,
  markets: string,
  opts: { manual?: boolean; active?: Set<string> } = {},
): Promise<{ events: unknown[]; credits: number } | { events: null; skipped: string }> {
  if (opts.active && !opts.active.has(sportKey)) {
    return { events: null, skipped: 'fuera de temporada' };
  }
  const credits = creditCost(markets);
  const allowed = canSpend(credits, opts.manual);
  if (!allowed.ok) {
    setOddsError(allowed.reason);
    return { events: null, skipped: allowed.reason };
  }

  const url =
    `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/odds/` +
    `?apiKey=${encodeURIComponent(env.oddsApiKey)}` +
    `&regions=${encodeURIComponent(env.oddsRegions)}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&oddsFormat=decimal`;

  const res = await fetch(url);
  recordQuota(res);
  // 404/422 mean "no such sport" or "no events" — normal, not a failure.
  if (res.status === 404 || res.status === 422) return { events: [], credits };
  if (res.status === 401) {
    const msg = 'The Odds API rechazó la clave (401). Revisa ODDS_API_KEY en tu .env.';
    setOddsError(msg);
    throw new Error(msg);
  }
  if (res.status === 429) {
    const msg = 'The Odds API: cupo agotado (429). El plan gratuito son 500 peticiones al mes.';
    setOddsError(msg);
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(`Odds API ${sportKey}: HTTP ${res.status}`);
  setOddsError(null);
  return { events: (await res.json()) as unknown[], credits };
}

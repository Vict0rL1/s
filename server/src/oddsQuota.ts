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
export const QUOTA_RESERVE = 25;

const KEY_REMAINING = 'odds:requestsRemaining';
const KEY_USED = 'odds:requestsUsed';
const KEY_CHECKED = 'odds:quotaCheckedAt';
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
  const floor = manual ? 0 : QUOTA_RESERVE;
  if (remaining - credits < floor) {
    return {
      ok: false,
      reason:
        `quedan ${remaining} peticiones del plan de The Odds API y esta operación cuesta ${credits}` +
        (manual ? '' : ` (se reservan ${QUOTA_RESERVE} para las actualizaciones manuales)`),
    };
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

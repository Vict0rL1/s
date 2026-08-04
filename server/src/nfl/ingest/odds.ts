// Upcoming NFL games and bookmaker prices from The Odds API.
//
// This sport asks the API for THREE markets rather than one, because for the NFL
// the handicap is the headline market and the moneyline is the sideshow — the
// reverse of every other tab in this app. h2h gives the moneyline, spreads the
// handicap, totals the over/under, and the card prices the model against all
// three lines a reader can actually see on a slip.
//
// Verification note: api.the-odds-api.com is unreachable from the environment
// this was written in, so the client is written defensively — fields are read by
// name, a missing market degrades to "no line from the market" instead of
// throwing, and the schedule rows ingested from nflverse remain the fallback.
// The archive and the model that rest under this ARE real and were measured.

import { getDb } from '../../db.ts';
import { env, nflConfig } from '../../config.ts';
import { activeKeys, creditCost, fetchOdds } from '../../oddsQuota.ts';
import { resolveTeam } from '../repo.ts';
import type { LeagueId } from '../types.ts';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface AggregatedEvent {
  id: string;
  commence_time: string;
  home: string;
  away: string;
  /** team name → median decimal moneyline across books. */
  price: Record<string, number>;
  /** Median handicap on the HOME team, bookmaker sign convention. */
  spread: number | null;
  total: number | null;
  books: number;
}

function leagueByKey(): Map<string, LeagueId> {
  const m = new Map<string, LeagueId>();
  for (const l of nflConfig.leagues) for (const k of l.oddsSportKeys) m.set(k, l.id);
  return m;
}

/**
 * The three markets a sportsbook posts for an NFL game.
 *
 * THIS IS THE MOST EXPENSIVE CALL IN THE APP and it should be, because the
 * handicap and the total are the point of this tab — but the price is worth
 * saying out loud: The Odds API bills per market per region, so h2h+spreads+
 * totals is THREE credits per region, not one. With one region and one league in
 * season that is 3 credits a cycle, which is affordable. It was 6 before the
 * region default changed, on every one of two league keys, whether the NFL was
 * playing or not.
 */
const MARKETS = 'h2h,spreads,totals';

async function fetchLive(
  sportKey: string,
  active: Set<string>,
  manual: boolean,
): Promise<AggregatedEvent[] | null> {
  const result = await fetchOdds(sportKey, MARKETS, { active, manual });
  if (result.events === null) {
    console.warn(`[nfl] ${sportKey}: ${result.skipped}`);
    return null;
  }
  const events = result.events as Record<string, unknown>[];

  return events.map((ev) => {
    const home = String(ev.home_team ?? '');
    const prices: Record<string, number[]> = {};
    const spreads: number[] = [];
    const totals: number[] = [];

    for (const bk of (ev.bookmakers as Record<string, unknown>[] | undefined) ?? []) {
      for (const mk of (bk.markets as Record<string, unknown>[] | undefined) ?? []) {
        const outcomes = (mk.outcomes as Record<string, unknown>[] | undefined) ?? [];
        if (mk.key === 'h2h') {
          for (const o of outcomes) {
            const n = String(o.name ?? '');
            const p = Number(o.price);
            if (n && Number.isFinite(p)) (prices[n] ??= []).push(p);
          }
        } else if (mk.key === 'spreads') {
          // The point is on the outcome, one per team; we keep the home side's.
          const h = outcomes.find((o) => String(o.name ?? '') === home);
          const pt = Number(h?.point);
          if (Number.isFinite(pt)) spreads.push(pt);
        } else if (mk.key === 'totals') {
          const over = outcomes.find((o) => String(o.name ?? '').toLowerCase() === 'over');
          const pt = Number(over?.point);
          if (Number.isFinite(pt)) totals.push(pt);
        }
      }
    }

    const price: Record<string, number> = {};
    for (const [n, arr] of Object.entries(prices)) price[n] = median(arr);

    return {
      id: String(ev.id ?? ''),
      commence_time: String(ev.commence_time ?? ''),
      home,
      away: String(ev.away_team ?? ''),
      price,
      spread: spreads.length ? median(spreads) : null,
      total: totals.length ? median(totals) : null,
      books: ((ev.bookmakers as unknown[] | undefined) ?? []).length,
    };
  });
}

/**
 * Refresh live prices.
 *
 * Live rows REPLACE the schedule rows for the same fixture rather than sitting
 * beside them — otherwise the tab would show every game twice, once with prices
 * and once without.
 */
export async function refreshOdds(manual = false): Promise<number> {
  if (!env.oddsApiKey) return 0;
  const db = getDb();
  const byKey = leagueByKey();
  const stamp = new Date().toISOString();
  let stored = 0;

  // One free /sports call decides which keys are worth paying for. Without this
  // the NFL was billed 6 credits every cycle in March, when it does not play.
  let active: Set<string>;
  try {
    active = await activeKeys(byKey.keys());
  } catch (err) {
    console.warn(`[nfl] no se pudo listar deportes activos: ${(err as Error).message}`);
    return 0;
  }
  if (active.size === 0) {
    console.log('[nfl] ninguna competición en temporada; no se gasta cupo.');
    return 0;
  }
  console.log(
    `[nfl] ${active.size} competición(es) en temporada · ${active.size * creditCost(MARKETS)} créditos`,
  );

  for (const [sportKey, league] of byKey) {
    let events: AggregatedEvent[] | null = [];
    try {
      events = await fetchLive(sportKey, active, manual);
    } catch (err) {
      console.warn(`[nfl] ${sportKey}: ${(err as Error).message}`);
      continue;
    }
    if (events === null || events.length === 0) continue;

    db.exec('BEGIN');
    try {
      db.prepare("DELETE FROM naf_upcoming WHERE league = ? AND source = 'live'").run(league);
      const ins = db.prepare(
        `INSERT INTO naf_upcoming
           (id, league, season, week, commence_time, home_name, away_name, home_id, away_id,
            neutral, odds_home, odds_away, spread_line, total_line, books, source, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'live', ?)
         ON CONFLICT (id) DO UPDATE SET
           commence_time = excluded.commence_time,
           odds_home = excluded.odds_home,
           odds_away = excluded.odds_away,
           spread_line = excluded.spread_line,
           total_line = excluded.total_line,
           books = excluded.books,
           updated_at = excluded.updated_at`,
      );
      const dropSchedule = db.prepare(
        "DELETE FROM naf_upcoming WHERE league = ? AND source = 'schedule' AND home_id = ? AND away_id = ?",
      );

      for (const ev of events) {
        if (!ev.id || !ev.home || !ev.away) continue;
        const home = resolveTeam(league, ev.home);
        const away = resolveTeam(league, ev.away);
        ins.run(
          `odds-${ev.id}`,
          league,
          ev.commence_time,
          ev.home,
          ev.away,
          home?.id ?? null,
          away?.id ?? null,
          ev.price[ev.home] ?? null,
          ev.price[ev.away] ?? null,
          ev.spread,
          ev.total,
          ev.books,
          stamp,
        );
        if (home && away) dropSchedule.run(league, home.id, away.id);
        stored++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return stored;
}

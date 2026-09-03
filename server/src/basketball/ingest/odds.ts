// ===========================================================================
// BASKETBALL ODDS  (upcoming games + bookmaker prices)
// ===========================================================================
// Same two backends as the tennis side:
//   • The Odds API — real fixtures and live prices (needs ODDS_API_KEY)
//   • fixtures     — games invented from current Elo so the tab works with no
//                    key, offline, or out of season
//
// Which leagues appear is driven by config/basketball.json, matched against The
// Odds API's own /sports listing. That listing is free, so the app discovers
// whatever basketball is in season right now instead of hardcoding a calendar —
// the NBA in winter, EuroLeague alongside it, NCAA in March.
//
// Basketball rows go to bb_upcoming, never to the tennis table: the two sports
// stay separate all the way from ingestion to the UI.
// ===========================================================================

import { getDb, setMeta } from '../../db.ts';
import { pruneUpcoming } from '../../freshness.ts';
import { basketballConfig, env } from '../../config.ts';
import { canSpend, creditCost, listSports, recordQuota } from '../../oddsQuota.ts';
import { demoKickoffs } from '../../demoSchedule.ts';
import { buildNameIndex, resolve } from './teamNames.ts';
import { homeWinProbability } from '../elo.ts';
import type { LeagueId } from '../types.ts';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

interface AggregatedEvent {
  id: string;
  commence_time: string;
  home: string;
  away: string;
  price: Record<string, number>; // team name → consensus (median) decimal odds
  books: number;
}

/** Every Odds API sport key our config cares about, keyed by league id. */
function leagueByKey(): Map<string, LeagueId> {
  const m = new Map<string, LeagueId>();
  for (const l of basketballConfig.leagues) {
    for (const k of l.oddsSportKeys) m.set(k, l.id);
  }
  return m;
}

interface SportListing {
  key: string;
  title: string;
}

/** Basketball competitions active right now, restricted to those we configure. */
async function fetchActiveBasketballSports(): Promise<SportListing[]> {
  // Shared and cached — see the note in oddsQuota.ts.
  const all = await listSports() as unknown as
    { key: string; title: string; group: string; active: boolean; has_outrights: boolean }[];
  const known = leagueByKey();
  return all
    .filter((s) => s.active && !s.has_outrights && known.has(s.key))
    .map((s) => ({ key: s.key, title: s.title }));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function fetchLive(sportKey: string): Promise<AggregatedEvent[]> {
  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/odds/` +
    `?apiKey=${encodeURIComponent(env.oddsApiKey)}` +
    `&regions=${encodeURIComponent(env.oddsRegions)}` +
    `&markets=h2h&oddsFormat=decimal`;
  // The guard comes BEFORE the request, obviously: checking afterwards would be
  // checking whether we could afford something already bought.
  const allowed = canSpend(creditCost('h2h'));
  if (!allowed.ok) {
    console.warn(`[odds] ${sportKey} saltado: ${allowed.reason}`);
    return [];
  }
  const res = await fetch(url);
  // Every response carries x-requests-remaining, so this is free knowledge.
  recordQuota(res);
  if (res.status === 404 || res.status === 422) return []; // out of season
  if (!res.ok) {
    throw new Error(`Odds API error for ${sportKey}: HTTP ${res.status} ${await res.text()}`);
  }
  const events = (await res.json()) as any[];
  return events.map((ev) => {
    const prices: Record<string, number[]> = {};
    for (const bk of ev.bookmakers ?? []) {
      const h2h = (bk.markets ?? []).find((m: any) => m.key === 'h2h');
      if (!h2h) continue;
      for (const o of h2h.outcomes ?? []) (prices[o.name] ??= []).push(o.price);
    }
    const price: Record<string, number> = {};
    for (const [name, arr] of Object.entries(prices)) price[name] = median(arr);
    return {
      id: String(ev.id),
      commence_time: String(ev.commence_time),
      home: String(ev.home_team ?? ''),
      away: String(ev.away_team ?? ''),
      price,
      books: (ev.bookmakers ?? []).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Fixture backend (no key / offline / out of season)
// ---------------------------------------------------------------------------
/**
 * Invent a plausible slate from current ratings so the tab is never empty.
 * Prices come from the model's own probability plus a bookmaker margin, and every
 * row is tagged source='fixture' so the UI can label it "odds demo" — these are
 * NOT real games and are never written to the track record.
 */
function generateFixtures(league: LeagueId, count = 8): AggregatedEvent[] {
  const teams = getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, r.elo FROM bb_team_ratings r
       JOIN bb_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ? ORDER BY r.elo DESC LIMIT ?`,
    )
    .all(league, count * 2) as unknown as { id: string; name: string; elo: number }[];
  if (teams.length < 2) return [];

  const out: AggregatedEvent[] = [];
  // Plausible kick-off times on the clock, always still ahead — see
  // demoSchedule.ts for why this is not `Date.now() + n days`.
  const kickoffs = demoKickoffs('basketball', count);
  for (let i = 0; i + 1 < teams.length && out.length < count; i += 2) {
    const home = teams[i];
    const away = teams[i + 1];
    const p = homeWinProbability(home.elo, away.elo);
    // A real book prices so the implied probabilities sum to MORE than 1 (its
    // margin). price = 1/(p·vig) gives implied = p·vig, summing to `vig` — the
    // inverse of that, 1/p·vig, would produce a NEGATIVE margin, which no
    // bookmaker offers and which makes the market comparison nonsense.
    const vig = 1.05;
    out.push({
      // The kick-off INSTANT is part of the id, and it has to be. These ids used to
      // be `fixture-epl-0`, stable per league and index, so a regenerated slate
      // reused them — and the ON CONFLICT UPDATE rewrote this morning's
      // already-started match with tonight's kick-off, mutating it out of today
      // instead of leaving it where the reader expects to find it.
      //
      // The full instant and not just the date: `demoKickoffs` only ever emits slots
      // at least 45 minutes ahead, so once 14:00 has passed the next slate starts at
      // 16:15 and gets its own id. The date alone collides, because the new slate is
      // usually still the same day.
      id: `fixture-${league}-${kickoffs[out.length]}-${i / 2}`,
      commence_time: kickoffs[out.length],
      home: home.name,
      away: away.name,
      price: {
        [home.name]: Math.round((1 / (p * vig)) * 100) / 100,
        [away.name]: Math.round((1 / ((1 - p) * vig)) * 100) / 100,
      },
      books: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
export interface BasketballOddsResult {
  source: 'live' | 'fixture';
  count: number;
  leagues: string[];
}

/** Refresh bb_upcoming for every configured basketball league. */
export async function refreshBasketballOdds(): Promise<BasketballOddsResult> {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO bb_upcoming
       (id, league, commence_time, home_name, away_name, home_id, away_id,
        home_odds, away_odds, books, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- NEVER move a match that has already kicked off. A feed re-sending an
       -- event id with a new time — which both the demo generator and a live API
       -- can do — would otherwise drag this morning's match into tonight, and it
       -- would vanish from today without anything being deleted. Measured: it did
       -- exactly that, and the row still existed afterwards, so only its time gave
       -- the bug away.
       commence_time = CASE WHEN bb_upcoming.commence_time >= ? THEN excluded.commence_time
                            ELSE bb_upcoming.commence_time END, home_odds = excluded.home_odds,
       away_odds = excluded.away_odds, books = excluded.books,
       home_id = excluded.home_id, away_id = excluded.away_id,
       source = excluded.source, updated_at = excluded.updated_at`,
  );

  const known = leagueByKey();
  const perLeague = new Map<LeagueId, AggregatedEvent[]>();
  let source: 'live' | 'fixture' = 'fixture';

  if (env.oddsApiKey) {
    let sports: SportListing[] = [];
    try {
      sports = await fetchActiveBasketballSports();
    } catch (e) {
      process.stderr.write(`  no pude listar deportes de baloncesto: ${(e as Error).message}\n`);
    }
    for (const sport of sports) {
      const league = known.get(sport.key);
      if (!league) continue;
      try {
        const events = await fetchLive(sport.key);
        if (events.length) {
          perLeague.set(league, [...(perLeague.get(league) ?? []), ...events]);
          source = 'live';
        }
      } catch (e) {
        process.stderr.write(`  odds de ${sport.key} fallaron: ${(e as Error).message}\n`);
      }
    }
  }

  // Nothing live (no key, off-season, or every request failed) → demo slate for
  // whichever leagues have ratings, clearly labelled as such.
  if (perLeague.size === 0) {
    for (const l of basketballConfig.leagues) {
      const fx = generateFixtures(l.id);
      if (fx.length) perLeague.set(l.id, fx);
    }
    source = 'fixture';
  }

  // Replace the slate wholesale: a game that dropped off the feed has been played
  // or postponed, and leaving it behind would show a stale fixture forever.
  const nowIso = new Date().toISOString();
  db.exec('BEGIN');
  try {
    // Keeps the matches that already kicked off today — see pruneUpcoming.
    // An unconditional DELETE here is what made this morning's game vanish.
    pruneUpcoming(db, 'bb_upcoming');
    let count = 0;
    for (const [league, events] of perLeague) {
      const idx = buildNameIndex(league);
      for (const ev of events) {
        const homeId = resolve(idx, ev.home);
        const awayId = resolve(idx, ev.away);
        insert.run(
          ev.id,
          league,
          ev.commence_time,
          ev.home,
          ev.away,
          homeId,
          awayId,
          ev.price[ev.home] ?? null,
          ev.price[ev.away] ?? null,
          ev.books,
          source,
          nowIso,
          // Last arg feeds the CASE guard above: the row may only be re-timed
          // while its stored kick-off is still in the future.
          nowIso,
        );
        count++;
      }
    }
    db.exec('COMMIT');
    setMeta('bb_odds_source', source);
    setMeta('bb_odds_refreshed_at', new Date().toISOString());
    return { source, count, leagues: [...perLeague.keys()] };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

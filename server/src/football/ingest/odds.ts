// Upcoming fixtures + bookmaker prices for football, from The Odds API.
//
// Football is the only one of the three sports with a THREE-way market, so the
// h2h outcomes here include the draw and the row carries three prices. Which
// leagues appear is driven by config/football.json matched against the provider's
// own /sports listing, so the app follows whatever is in season.
//
// Rows go to fb_upcoming only: the three sports never share a fixtures table.

import { getDb, setMeta } from '../../db.ts';
import { pruneUpcoming } from '../../freshness.ts';
import { env, footballConfig } from '../../config.ts';
import { canSpend, creditCost, listSports, recordQuota } from '../../oddsQuota.ts';
import { demoKickoffs } from '../../demoSchedule.ts';
import { eloExpectation, HOME_ADVANTAGE } from '../model.ts';
import { buildTeamIndex as buildNameIndex, resolveTeam as resolve } from './teamNames.ts';
import { secondDivisionOf } from '../promotion.ts';
import { seedPromotedTeam } from '../ratings.ts';
import type { LeagueId } from '../types.ts';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

interface Aggregated {
  id: string;
  commence_time: string;
  home: string;
  away: string;
  /** name → median decimal odds. The draw arrives as the literal "Draw". */
  price: Record<string, number>;
  books: number;
}

function leagueByKey(): Map<string, LeagueId> {
  const m = new Map<string, LeagueId>();
  for (const l of footballConfig.leagues) for (const k of l.oddsSportKeys) m.set(k, l.id);
  return m;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function fetchActive(): Promise<{ key: string }[]> {
  // Shared and cached — see the note in oddsQuota.ts.
  const all = await listSports();
  const known = leagueByKey();
  return all.filter((s) => s.active && !s.has_outrights && known.has(s.key));
}

async function fetchLive(sportKey: string): Promise<Aggregated[]> {
  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${encodeURIComponent(env.oddsApiKey)}` +
    `&regions=${encodeURIComponent(env.oddsRegions)}&markets=h2h&oddsFormat=decimal`;
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

  if (!res.ok) throw new Error(`Odds API ${sportKey}: HTTP ${res.status}`);
  const events = (await res.json()) as any[];
  return events.map((ev) => {
    const prices: Record<string, number[]> = {};
    for (const bk of ev.bookmakers ?? []) {
      const h2h = (bk.markets ?? []).find((m: any) => m.key === 'h2h');
      if (!h2h) continue;
      for (const o of h2h.outcomes ?? []) (prices[o.name] ??= []).push(o.price);
    }
    const price: Record<string, number> = {};
    for (const [n, arr] of Object.entries(prices)) price[n] = median(arr);
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


/** Demo fixtures from current Elo, so the tab works with no key / out of season. */
function generateFixtures(league: LeagueId, count = 6): Aggregated[] {
  const teams = getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, r.elo FROM fb_team_ratings r
       JOIN fb_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ? ORDER BY r.elo DESC LIMIT ?`,
    )
    .all(league, count * 2) as unknown as { id: string; name: string; elo: number }[];
  if (teams.length < 2) return [];
  const out: Aggregated[] = [];
  // Plausible kick-off times on the clock, always still ahead — see demoSchedule.ts
  // for why this is not `Date.now() + n days`.
  const kickoffs = demoKickoffs('football', count);
  for (let i = 0; i + 1 < teams.length && out.length < count; i += 2) {
    const home = teams[i];
    const away = teams[i + 1];
    // Rough 1X2 from the Elo expectation, holding the draw near its real rate.
    const e = eloExpectation(home.elo, away.elo, HOME_ADVANTAGE);
    const pd = 0.26;
    const ph = e * (1 - pd);
    const pa = 1 - pd - ph;
    // Priced so implied probabilities sum to MORE than 1 — a real book's margin.
    const vig = 1.06;
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
        [home.name]: Math.round((1 / (ph * vig)) * 100) / 100,
        Draw: Math.round((1 / (pd * vig)) * 100) / 100,
        [away.name]: Math.round((1 / (pa * vig)) * 100) / 100,
      },
      books: 0,
    });
  }
  return out;
}

export interface FootballOddsResult {
  source: 'live' | 'fixture';
  count: number;
  leagues: string[];
}

export async function refreshFootballOdds(): Promise<FootballOddsResult> {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO fb_upcoming
       (id, league, commence_time, home_name, away_name, home_id, away_id,
        odds_home, odds_draw, odds_away, books, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- NEVER move a match that has already kicked off. A feed re-sending an
       -- event id with a new time — which both the demo generator and a live API
       -- can do — would otherwise drag this morning's match into tonight, and it
       -- would vanish from today without anything being deleted. Measured: it did
       -- exactly that, and the row still existed afterwards, so only its time gave
       -- the bug away.
       commence_time = CASE WHEN fb_upcoming.commence_time >= ? THEN excluded.commence_time
                            ELSE fb_upcoming.commence_time END, odds_home = excluded.odds_home,
       odds_draw = excluded.odds_draw, odds_away = excluded.odds_away,
       books = excluded.books, home_id = excluded.home_id, away_id = excluded.away_id,
       source = excluded.source, updated_at = excluded.updated_at`,
  );

  const known = leagueByKey();
  const perLeague = new Map<LeagueId, Aggregated[]>();
  let source: 'live' | 'fixture' = 'fixture';

  if (env.oddsApiKey) {
    let sports: { key: string }[] = [];
    try {
      sports = await fetchActive();
    } catch (e) {
      process.stderr.write(`  no pude listar ligas de fútbol: ${(e as Error).message}\n`);
    }
    for (const s of sports) {
      const league = known.get(s.key);
      if (!league) continue;
      try {
        const events = await fetchLive(s.key);
        if (events.length) {
          perLeague.set(league, [...(perLeague.get(league) ?? []), ...events]);
          source = 'live';
        }
      } catch (e) {
        process.stderr.write(`  odds de ${s.key} fallaron: ${(e as Error).message}\n`);
      }
    }
  }

  if (perLeague.size === 0) {
    for (const l of footballConfig.leagues) {
      const fx = generateFixtures(l.id);
      if (fx.length) perLeague.set(l.id, fx);
    }
    source = 'fixture';
  }

  const nowIso = new Date().toISOString();
  db.exec('BEGIN');
  try {
    // Keeps the matches that already kicked off today — see pruneUpcoming.
    // An unconditional DELETE here is what made this morning's game vanish.
    pruneUpcoming(db, 'fb_upcoming');
    let count = 0;
    let promoted = 0;
    for (const [league, events] of perLeague) {
      const idx = buildNameIndex(league);
      const second = secondDivisionOf(league);
      const secondIdx = second ? buildNameIndex(second) : null;

      /**
       * The club's id in THIS division, seeding it from the one below if it has
       * just come up.
       *
       * Without this a promoted club never resolves — it has never played a match
       * in this division, so it is not in the table the index is built from — and
       * every one of its fixtures falls back to the market's implied numbers with
       * no breakdown at all. That is what "Atlético Madrid vs Málaga" looked like:
       * three clubs a league, every August, roughly a fifth of the fixtures for the
       * first months of a season.
       */
      const resolveOrSeed = (name: string): string | null => {
        const here = resolve(idx, name);
        if (here) return here;
        if (!secondIdx || !second) return null;
        const below = resolve(secondIdx, name);
        if (!below) return null;
        const seeded = seedPromotedTeam(league, below);
        if (!seeded) return null;
        promoted++;
        process.stdout.write(
          `  ↑ ${name}: Elo trasladado desde ${second} (${seeded.elo}, salto ${seeded.offset})\n`,
        );
        // The index is rebuilt so a second fixture for the same club in this run
        // resolves normally instead of seeding it again.
        idx.set(name.toLowerCase().trim(), below);
        return below;
      };

      for (const ev of events) {
        // The draw price is keyed by the literal "Draw" in this provider's h2h
        // market; anything else means the payload changed shape.
        const drawPrice = ev.price['Draw'] ?? ev.price['draw'] ?? null;
        insert.run(
          ev.id,
          league,
          ev.commence_time,
          ev.home,
          ev.away,
          resolveOrSeed(ev.home),
          resolveOrSeed(ev.away),
          ev.price[ev.home] ?? null,
          drawPrice,
          ev.price[ev.away] ?? null,
          ev.books,
          source,
          new Date().toISOString(),
          // Last arg feeds the CASE guard above: the row may only be re-timed
          // while its stored kick-off is still in the future.
          nowIso,
        );
        count++;
      }
    }
    db.exec('COMMIT');
    setMeta('fb_odds_source', source);
    setMeta('fb_odds_refreshed_at', new Date().toISOString());
    return { source, count, leagues: [...perLeague.keys()] };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

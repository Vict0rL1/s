// Upcoming baseball games + bookmaker prices from The Odds API, and the announced
// STARTING PITCHERS from MLB's own public Stats API.
//
// The probables feed is not a nice-to-have here. A baseball forecast without the
// starters is a forecast of the wrong thing: the same two clubs can be a coin
// flip or a 60/40 depending on who is on the mound, and both teams announce a day
// ahead. MLB publishes it for free, without a key, at statsapi.mlb.com.
//
// Verification note: statsapi.mlb.com is unreachable from the environment this
// was written in (only GitHub is), so the probables client is written
// defensively — it reads fields by name, never throws into the caller, and the
// app degrades to "starter unknown" and says so on the card. The Retrosheet
// ingest that everything else rests on IS real and was validated game by game.

import { getDb, setMeta } from '../../db.ts';
import { pruneUpcoming } from '../../freshness.ts';
import { env, baseballConfig } from '../../config.ts';
import { canSpend, creditCost, listSports, recordQuota } from '../../oddsQuota.ts';
import { demoKickoffs } from '../../demoSchedule.ts';
import { eloExpectation, HOME_ADVANTAGE } from '../model.ts';
import { findPitcherByName } from '../repo.ts';
import type { LeagueId } from '../types.ts';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

interface AggregatedEvent {
  id: string;
  commence_time: string;
  home: string;
  away: string;
  /** team name → median decimal odds across books. */
  price: Record<string, number>;
  books: number;
}

function leagueByKey(): Map<string, LeagueId> {
  const m = new Map<string, LeagueId>();
  for (const l of baseballConfig.leagues) for (const k of l.oddsSportKeys) m.set(k, l.id);
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

async function fetchLive(sportKey: string): Promise<AggregatedEvent[]> {
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
      for (const o of h2h?.outcomes ?? []) (prices[o.name] ??= []).push(o.price);
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

// ---------------------------------------------------------------------------
// Probable starters
// ---------------------------------------------------------------------------
export interface Probables {
  /** "YYYYMMDD|HOMEABBR|AWAYABBR" → { home, away } pitcher names. */
  byGame: Map<string, { home: string | null; away: string | null }>;
  games: number;
}

/**
 * Announced starters for the next few days, from MLB's Stats API.
 *
 * Returns an empty map on any failure rather than throwing. Losing the probables
 * costs accuracy; failing the whole odds refresh because of them would cost the
 * user their upcoming games entirely, which is worse.
 */
export async function fetchProbables(daysAhead = 3): Promise<Probables> {
  const byGame = new Map<string, { home: string | null; away: string | null }>();
  try {
    const today = new Date();
    const end = new Date(today.getTime() + daysAhead * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const url =
      `${baseballConfig.history.mlbStatsApi}/schedule?sportId=1` +
      `&startDate=${iso(today)}&endDate=${iso(end)}&hydrate=probablePitcher`;
    const res = await fetch(url);
    if (!res.ok) return { byGame, games: 0 };
    const data = (await res.json()) as any;
    for (const day of data?.dates ?? []) {
      for (const g of day?.games ?? []) {
        const date = String(g?.gameDate ?? '').slice(0, 10).replace(/-/g, '');
        const home = g?.teams?.home;
        const away = g?.teams?.away;
        const key = `${date}|${home?.team?.abbreviation ?? ''}|${away?.team?.abbreviation ?? ''}`;
        byGame.set(key, {
          home: home?.probablePitcher?.fullName ?? null,
          away: away?.probablePitcher?.fullName ?? null,
        });
      }
    }
  } catch {
    // Unreachable feed, malformed payload — either way the app carries on
    // without the starters and the card says they are unknown.
  }
  return { byGame, games: byGame.size };
}

// ---------------------------------------------------------------------------
// Team-name matching
// ---------------------------------------------------------------------------
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Index a league's teams by full name and by nickname.
 *
 * Baseball books write "New York Yankees" while Retrosheet says NYA, so the
 * index also carries the nickname ("yankees") — but NOT bare city names, because
 * New York, Chicago and Los Angeles each have two clubs and a city match would
 * pick one of them at random.
 */
function buildNameIndex(league: LeagueId): Map<string, string> {
  const rows = getDb()
    .prepare('SELECT id, name FROM bsb_teams WHERE league = ?')
    .all(league) as unknown as { id: string; name: string }[];
  const idx = new Map<string, string>();
  const add = (key: string, id: string) => {
    const k = normalize(key);
    if (k && !idx.has(k)) idx.set(k, id);
  };
  for (const r of rows) add(r.name, r.id);
  for (const r of rows) {
    const words = r.name.split(/\s+/);
    if (words.length > 1) add(words[words.length - 1], r.id);
    // "Red Sox", "Blue Jays", "White Sox" are two-word nicknames.
    if (words.length > 2) add(words.slice(-2).join(' '), r.id);
  }
  for (const r of rows) add(r.id, r.id);
  return idx;
}

function resolve(idx: Map<string, string>, name: string): string | null {
  const n = normalize(name);
  if (idx.has(n)) return idx.get(n)!;
  const words = n.split(' ');
  for (let take = 1; take <= Math.min(2, words.length - 1); take++) {
    const tail = words.slice(words.length - take).join(' ');
    if (idx.has(tail)) return idx.get(tail)!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Demo slate
// ---------------------------------------------------------------------------
/**
 * Invent a plausible slate from current ratings so the tab is never empty without
 * an API key. Every row is tagged source='fixture' so the UI labels it a demo,
 * and demo games never enter the track record.
 */
function generateFixtures(league: LeagueId, count = 8): AggregatedEvent[] {
  const teams = getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, r.elo FROM bsb_team_ratings r
       JOIN bsb_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ? ORDER BY r.elo DESC LIMIT ?`,
    )
    .all(league, count * 2) as unknown as { id: string; name: string; elo: number }[];
  if (teams.length < 2) return [];

  const out: AggregatedEvent[] = [];
  // Plausible kick-off times on the clock, always still ahead — see
  // demoSchedule.ts for why this is not `Date.now() + n days`.
  const kickoffs = demoKickoffs('baseball', count);
  for (let i = 0; i + 1 < teams.length && out.length < count; i += 2) {
    const home = teams[i];
    const away = teams[i + 1];
    const p = eloExpectation(home.elo, away.elo, HOME_ADVANTAGE);
    // A real book prices so the implied probabilities sum to MORE than 1: that
    // sum is its margin. 1/(p·vig) gives implied = p·vig; the inverse would
    // produce a negative margin, which no bookmaker offers.
    const vig = 1.045;
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
export interface BaseballOddsResult {
  source: 'live' | 'fixture';
  count: number;
  leagues: string[];
  withStarters: number;
}

/** Refresh bsb_upcoming for every configured baseball league. */
export async function refreshBaseballOdds(): Promise<BaseballOddsResult> {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO bsb_upcoming
       (id, league, commence_time, home_name, away_name, home_id, away_id,
        home_sp, away_sp, odds_home, odds_away, books, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- NEVER move a match that has already kicked off. A feed re-sending an
       -- event id with a new time — which both the demo generator and a live API
       -- can do — would otherwise drag this morning's match into tonight, and it
       -- would vanish from today without anything being deleted. Measured: it did
       -- exactly that, and the row still existed afterwards, so only its time gave
       -- the bug away.
       commence_time = CASE WHEN bsb_upcoming.commence_time >= ? THEN excluded.commence_time
                            ELSE bsb_upcoming.commence_time END, home_id = excluded.home_id,
       away_id = excluded.away_id, home_sp = excluded.home_sp, away_sp = excluded.away_sp,
       odds_home = excluded.odds_home, odds_away = excluded.odds_away,
       books = excluded.books, source = excluded.source, updated_at = excluded.updated_at`,
  );

  const byKey = leagueByKey();
  const perLeague = new Map<LeagueId, AggregatedEvent[]>();
  let source: 'live' | 'fixture' = 'fixture';

  if (env.oddsApiKey) {
    try {
      for (const s of await fetchActive()) {
        const league = byKey.get(s.key)!;
        const events = await fetchLive(s.key);
        if (events.length === 0) continue;
        perLeague.set(league, [...(perLeague.get(league) ?? []), ...events]);
        source = 'live';
      }
    } catch (e) {
      console.warn(`⚠️  Odds API falló, se usarán partidos demo: ${(e as Error).message}`);
    }
  }
  if (perLeague.size === 0) {
    for (const l of baseballConfig.leagues) {
      const fx = generateFixtures(l.id);
      if (fx.length) perLeague.set(l.id, fx);
    }
  }

  const probables = source === 'live' ? await fetchProbables() : { byGame: new Map(), games: 0 };

  const now = new Date().toISOString();
  let count = 0;
  let withStarters = 0;
  const leagues: string[] = [];

  db.exec('BEGIN');
  try {
    // Keeps the matches that already kicked off today — see pruneUpcoming.
    // An unconditional DELETE here is what made this morning's game vanish.
    pruneUpcoming(db, 'bsb_upcoming');
    for (const [league, events] of perLeague) {
      const idx = buildNameIndex(league);
      let inserted = 0;
      for (const ev of events) {
        const homeId = resolve(idx, ev.home);
        const awayId = resolve(idx, ev.away);
        const date = ev.commence_time.slice(0, 10).replace(/-/g, '');
        // The probables feed keys by MLB's own abbreviations; try the team id and
        // the resolved name, and accept a miss rather than guessing.
        const probable =
          probables.byGame.get(`${date}|${homeId ?? ''}|${awayId ?? ''}`) ??
          probables.byGame.get(`${date}|${ev.home}|${ev.away}`) ??
          null;
        const homeSp = probable?.home ? findPitcherByName(league, probable.home)?.id ?? null : null;
        const awaySp = probable?.away ? findPitcherByName(league, probable.away)?.id ?? null : null;
        if (homeSp && awaySp) withStarters++;
        insert.run(
          ev.id,
          league,
          ev.commence_time,
          ev.home,
          ev.away,
          homeId,
          awayId,
          homeSp,
          awaySp,
          ev.price[ev.home] ?? null,
          ev.price[ev.away] ?? null,
          ev.books,
          source,
          now,
          // Last arg feeds the CASE guard above: the row may only be re-timed
          // while its stored kick-off is still in the future.
          now,
        );
        inserted++;
      }
      if (inserted > 0) leagues.push(league);
      count += inserted;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  setMeta('bsb_odds_source', source);
  setMeta('bsb_odds_refreshed_at', now);
  setMeta('bsb_probables', String(probables.games));
  return { source, count, leagues, withStarters };
}

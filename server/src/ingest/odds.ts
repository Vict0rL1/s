// ===========================================================================
// ODDS INGESTION  (bookmaker head-to-head odds for upcoming matches)
// ===========================================================================
// Provider abstraction with two backends:
//   • theOddsApi  — live odds from The Odds API (needs ODDS_API_KEY)
//   • fixtures    — locally generated odds from current Elo, so the dashboard
//                   still works with no key / offline / out of season
//
// Get a FREE key at https://the-odds-api.com (500 requests/month on the free
// plan). Configure it as ODDS_API_KEY in .env — never hardcode it.
// ===========================================================================

import { getDb, setMeta } from '../db.ts';
import { demoKickoffs } from '../demoSchedule.ts';
import { pruneUpcoming } from '../freshness.ts';
import { env, tournamentsConfig } from '../config.ts';
import { canSpend, creditCost, listSports, recordQuota } from '../oddsQuota.ts';
import { expectedScore } from '../model/elo.ts';
import type { Surface, TourId } from '../types.ts';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

interface AggregatedEvent {
  id: string;
  commence_time: string;
  home: string;
  away: string;
  price: Record<string, number>; // player name -> consensus (median) decimal odds
  books: number;
}

// ---------------------------------------------------------------------------
// The Odds API backend
// ---------------------------------------------------------------------------

interface TennisSport {
  key: string; // e.g. "tennis_atp_wimbledon"
  title: string; // e.g. "ATP Wimbledon"
}

/**
 * Discover the tennis tournaments that are ACTIVE right now. The /sports listing
 * is free (does not count against the odds quota), so we use it to find whatever
 * is currently in season instead of hardcoding sport keys — that's how "today's"
 * real matches show up automatically.
 */
async function fetchActiveTennisSports(): Promise<TennisSport[]> {
  // Shared and cached: five sports were each making this call every cycle. It
  // is free, but it also carries the quota headers, so going through one place
  // means the app always knows where it stands.
  const all = (await listSports()) as any[];
  return all
    .filter((s) => s.group === 'Tennis' && s.active && !s.has_outrights)
    .map((s) => ({ key: s.key as string, title: s.title as string }));
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
  if (res.status === 404 || res.status === 422) return []; // no such sport / out of season
  if (!res.ok) {
    throw new Error(`Odds API error for ${sportKey}: HTTP ${res.status} ${await res.text()}`);
  }
  const events = (await res.json()) as any[];
  return events.map((ev) => {
    const prices: Record<string, number[]> = {};
    for (const bk of ev.bookmakers ?? []) {
      const h2h = (bk.markets ?? []).find((m: any) => m.key === 'h2h');
      if (!h2h) continue;
      for (const o of h2h.outcomes ?? []) {
        (prices[o.name] ??= []).push(o.price);
      }
    }
    const price: Record<string, number> = {};
    for (const [name, arr] of Object.entries(prices)) price[name] = median(arr);
    return {
      id: ev.id,
      commence_time: ev.commence_time,
      home: ev.home_team,
      away: ev.away_team,
      price,
      books: (ev.bookmakers ?? []).length,
    };
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// Player-name resolution (odds API names → Sackmann player ids)
// ---------------------------------------------------------------------------
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (combining diacritics)
    .toLowerCase()
    .replace(/[.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNameIndex(tour: TourId): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT id, name FROM players WHERE tour = ?')
    .all(tour) as unknown as { id: number; name: string }[];
  const idx = new Map<string, number>();
  for (const r of rows) idx.set(normalizeName(r.name), r.id);
  return idx;
}

function resolve(idx: Map<string, number>, name: string): number | null {
  return idx.get(normalizeName(name)) ?? null;
}

// ---------------------------------------------------------------------------
// Fixtures backend (Elo-derived odds when there is no live market)
// ---------------------------------------------------------------------------
interface RatedPlayer {
  id: number;
  name: string;
  overall: number;
  hard: number;
  clay: number;
  grass: number;
}

function topRated(tour: TourId, surface: Surface, limit: number): RatedPlayer[] {
  const col = surface.toLowerCase(); // hard|clay|grass
  return getDb()
    .prepare(
      `SELECT p.id, p.name, r.overall, r.hard, r.clay, r.grass
       FROM player_ratings r JOIN players p ON p.tour = r.tour AND p.id = r.player_id
       WHERE r.tour = ? AND r.matches_played > 0
       ORDER BY (0.7 * r.${col} + 0.3 * r.overall) DESC
       LIMIT ?`,
    )
    .all(tour, limit) as unknown as RatedPlayer[];
}

function generateFixtures(): number {
  const db = getDb();
  clearUpcoming();
  const insert = db.prepare(
    `INSERT INTO upcoming_matches (
       id, tour, tournament_id, tournament_name, surface, commence_time,
       p1_name, p2_name, p1_id, p2_id, p1_odds, p2_odds, books, source, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       commence_time = excluded.commence_time, p1_odds = excluded.p1_odds,
       p2_odds = excluded.p2_odds, books = excluded.books,
       source = excluded.source, updated_at = excluded.updated_at`,
  );
  // Plausible kick-off times on the clock, always still ahead. This generator was
  // missed when the other four were fixed — it is a SECOND demo-fixture builder for
  // tennis, separate from the one in ingest/seed.ts, and it kept producing
  // `Date.now() + n hours` (times with stray seconds, ageing into the past). The
  // audit's "hora de inicio en punto de minuto" check is what found it.
  const kickoffs = demoKickoffs('tennis', 64);
  let slot = 0;
  let count = 0;
  db.exec('BEGIN');
  for (const t of tournamentsConfig.tournaments) {
    for (const tour of t.tours) {
      const surface = t.surface;
      const players = topRated(tour, surface, 8);
      if (players.length < 4) continue;
      // Pair 1v3, 2v4, 5v7, 6v8 for competitive matchups.
      const pairs: [RatedPlayer, RatedPlayer][] = [];
      for (let i = 0; i + 2 < players.length && pairs.length < 3; i += 1) {
        if (i % 2 === 0) pairs.push([players[i], players[i + 2]]);
      }
      pairs.forEach((pair, pi) => {
        const [a, b] = pair;
        const effA = 0.7 * a[surface.toLowerCase() as 'hard'] + 0.3 * a.overall;
        const effB = 0.7 * b[surface.toLowerCase() as 'hard'] + 0.3 * b.overall;
        const pa = expectedScore(effA, effB);
        const margin = 1.05; // bookmaker overround (~5%): implied probs sum to >1
        // tiny deterministic bias so market != model exactly
        const bias = ((a.id + b.id) % 7) / 100 - 0.03;
        const mp = Math.min(0.9, Math.max(0.1, pa + bias));
        insert.run(
          `fx-${tour}-${t.id}-${pi}`,
          tour,
          t.id,
          t.name,
          surface,
          kickoffs[slot++],
          a.name,
          b.name,
          a.id,
          b.id,
          round2(1 / (mp * margin)),
          round2(1 / ((1 - mp) * margin)),
          0,
          'fixture',
          new Date().toISOString(),
        );
        count++;
      });
    }
  }
  db.exec('COMMIT');
  return count;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
/**
 * Clear the slate a refresh is about to rewrite — but not the matches from earlier
 * today.
 *
 * This used to be an unconditional `DELETE FROM upcoming_matches`, which is what
 * made a match played this morning disappear: a feed of UPCOMING matches never
 * returns one that has already started, so the row was deleted and never came back.
 * See pruneUpcoming in freshness.ts for the three-way rule.
 */
export function clearUpcoming(): void {
  pruneUpcoming(getDb(), 'upcoming_matches');
}

/** Which config tournament (if any) a live sport key belongs to. */
function matchConfigTournament(sportKey: string) {
  return tournamentsConfig.tournaments.find((t) =>
    Object.values(t.oddsSportKeys).includes(sportKey),
  );
}

/** Derive the tour from a sport key: tennis_atp_* / tennis_wta_*. */
function tourFromKey(sportKey: string): TourId | null {
  if (sportKey.includes('_wta')) return 'wta';
  if (sportKey.includes('_atp')) return 'atp';
  return null;
}

/** Best-effort surface for a live event, via config keyword hints (else ''). */
function guessSurface(sportKey: string, title: string): string {
  const hints = tournamentsConfig.surfaceHints ?? {};
  const hay = `${sportKey} ${title}`.toLowerCase();
  for (const [keyword, surface] of Object.entries(hints)) {
    if (hay.includes(keyword.toLowerCase())) return surface;
  }
  return ''; // unknown → model uses overall Elo
}

export async function ingestOdds(): Promise<{ source: 'live' | 'fixture'; count: number }> {
  if (!env.oddsApiKey) {
    const count = generateFixtures();
    return { source: 'fixture', count };
  }

  const db = getDb();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO upcoming_matches (
       id, tour, tournament_id, tournament_name, surface, commence_time,
       p1_name, p2_name, p1_id, p2_id, p1_odds, p2_odds, books, source, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  // Discover the tournaments that are live right now (free endpoint).
  let sports: TennisSport[];
  try {
    sports = await fetchActiveTennisSports();
  } catch (e) {
    process.stderr.write(`  could not list tennis sports: ${(e as Error).message}\n`);
    const count = generateFixtures();
    return { source: 'fixture', count };
  }

  const nameIndex: Partial<Record<TourId, Map<string, number>>> = {};
  clearUpcoming();
  let total = 0;

  for (const sport of sports) {
    const tour = tourFromKey(sport.key);
    if (!tour) continue; // skip mixed / unknown circuits
    const idx = (nameIndex[tour] ??= buildNameIndex(tour));

    let events: AggregatedEvent[] = [];
    try {
      events = await fetchLive(sport.key);
    } catch (e) {
      process.stderr.write(`  odds fetch failed for ${sport.key}: ${(e as Error).message}\n`);
      continue;
    }

    // Map to a configured tournament when possible; otherwise surface the real
    // event under its own name so nothing is hidden.
    const conf = matchConfigTournament(sport.key);
    const tournamentId = conf?.id ?? sport.key;
    const tournamentName = conf?.name ?? sport.title;
    // The Odds API doesn't report the surface. Use the config surface, else a
    // keyword hint, else leave it unknown so the model predicts on overall Elo
    // (never wrongly assume a surface).
    const surface = conf?.surface ?? guessSurface(sport.key, sport.title);

    db.exec('BEGIN');
    for (const ev of events) {
      const names = Object.keys(ev.price);
      const p1 = ev.home ?? names[0];
      const p2 = ev.away ?? names[1];
      if (!p1 || !p2) continue;
      insert.run(
        ev.id,
        tour,
        tournamentId,
        tournamentName,
        surface,
        ev.commence_time,
        p1,
        p2,
        resolve(idx, p1),
        resolve(idx, p2),
        ev.price[p1] ?? null,
        ev.price[p2] ?? null,
        ev.books,
        'live',
        new Date().toISOString(),
      );
      total++;
    }
    db.exec('COMMIT');
    if (events.length) process.stdout.write(`  ${sport.key}: ${events.length} events\n`);
  }

  // Nothing live at all → keep a working demo with Elo-derived fixtures.
  if (total === 0) {
    const count = generateFixtures();
    return { source: 'fixture', count };
  }
  return { source: 'live', count: total };
}

/** Refresh odds and record when it happened. Used by the timer and /api/refresh. */
export async function refreshOdds(): Promise<{ source: 'live' | 'fixture'; count: number }> {
  const result = await ingestOdds();
  setMeta('odds_source', result.source);
  setMeta('odds_refreshed_at', new Date().toISOString());
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

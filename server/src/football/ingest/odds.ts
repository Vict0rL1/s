// Upcoming fixtures + bookmaker prices for football, from The Odds API.
//
// Football is the only one of the three sports with a THREE-way market, so the
// h2h outcomes here include the draw and the row carries three prices. Which
// leagues appear is driven by config/football.json matched against the provider's
// own /sports listing, so the app follows whatever is in season.
//
// Rows go to fb_upcoming only: the three sports never share a fixtures table.

import { getDb, setMeta } from '../../db.ts';
import { env, footballConfig } from '../../config.ts';
import { eloExpectation, HOME_ADVANTAGE } from '../model.ts';
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
  const res = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${encodeURIComponent(env.oddsApiKey)}`);
  if (!res.ok) throw new Error(`Odds API /sports: HTTP ${res.status}`);
  const all = (await res.json()) as { key: string; active: boolean; has_outrights: boolean }[];
  const known = leagueByKey();
  return all.filter((s) => s.active && !s.has_outrights && known.has(s.key));
}

async function fetchLive(sportKey: string): Promise<Aggregated[]> {
  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${encodeURIComponent(env.oddsApiKey)}` +
    `&regions=${encodeURIComponent(env.oddsRegions)}&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  if (res.status === 404 || res.status === 422) return [];
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

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ac|ss|as|cd|ud|rcd|club|de|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Feeds spell clubs differently ("Manchester United" vs "Manchester United FC"
 * vs "Man United"), so the index drops common club suffixes and matches on what
 * is left. No fuzzy matching: it would cheerfully merge the two Manchester clubs.
 */
function buildNameIndex(league: LeagueId): Map<string, string> {
  const rows = getDb()
    .prepare('SELECT id, name FROM fb_teams WHERE league = ?')
    .all(league) as unknown as { id: string; name: string }[];
  const idx = new Map<string, string>();
  for (const r of rows) {
    const k = normalize(r.name);
    if (k && !idx.has(k)) idx.set(k, r.id);
  }
  return idx;
}

function resolve(idx: Map<string, string>, name: string): string | null {
  const n = normalize(name);
  if (idx.has(n)) return idx.get(n)!;
  // A feed's shorter name is often a prefix of ours ("Man City" vs "Manchester
  // City"): accept only an unambiguous single candidate.
  const hits = [...idx.entries()].filter(([k]) => k.startsWith(n) || n.startsWith(k));
  return hits.length === 1 ? hits[0][1] : null;
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
  const now = Date.now();
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
      id: `fixture-${league}-${i / 2}`,
      commence_time: new Date(now + (i / 2 + 1) * 86_400_000).toISOString(),
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
       commence_time = excluded.commence_time, odds_home = excluded.odds_home,
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

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM fb_upcoming');
    let count = 0;
    for (const [league, events] of perLeague) {
      const idx = buildNameIndex(league);
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
          resolve(idx, ev.home),
          resolve(idx, ev.away),
          ev.price[ev.home] ?? null,
          drawPrice,
          ev.price[ev.away] ?? null,
          ev.books,
          source,
          new Date().toISOString(),
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

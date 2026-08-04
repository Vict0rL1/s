// Ingest the NFL archive from nflverse/nfldata.
//
// One CSV, one row per game since 1999, ~2 MB. It carries three things nothing
// else free carries together:
//
//   * the result of every game,
//   * the CLOSING spread and total on every one of them, and the moneylines
//     since 2006 — which is what lets the backtest score this model against the
//     market instead of only against itself,
//   * NEXT season's schedule, as rows with a date and no score, which is where
//     upcoming games come from when there is no odds API key.
//
// The parser reads columns BY NAME and fails loudly naming the ones it cannot
// find. nflverse adds columns regularly (`ftn`, `pff` and `away_qb_id` all
// appeared after this file was written); reading by position would have made
// every one of those a silent corruption.

import { getDb } from '../../db.ts';
import { zonedToUtc } from '../../timezone.ts';
import type { LeagueId } from '../types.ts';

/**
 * Franchises that moved, folded into one rating.
 *
 * The Raiders are the Raiders whether the box score says OAK or LV, and a model
 * that treats the move as the birth of a new 1500-rated team throws away every
 * game the franchise played before it. nflverse keeps the historical code on
 * historical rows, so without this map the league would have 39 teams, several
 * of them holding half a history each.
 */
const FRANCHISE: Record<string, string> = {
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LA',
  // nflverse writes both LAR and LA for the Rams depending on the season.
  LAR: 'LA',
  // Washington's three names in six years, and the two codes for Arizona.
  WSH: 'WAS',
  PHO: 'ARI',
};

/** Fallback names, used when the teams file is unreachable. */
const TEAM_NAMES: Record<string, string> = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens',
  BUF: 'Buffalo Bills', CAR: 'Carolina Panthers', CHI: 'Chicago Bears',
  CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys',
  DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars',
  KC: 'Kansas City Chiefs', LA: 'Los Angeles Rams', LAC: 'Los Angeles Chargers',
  LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings',
  NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
  NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers',
  SEA: 'Seattle Seahawks', SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers',
  TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};

export const canonicalTeam = (code: string): string => {
  const up = code.trim().toUpperCase();
  return FRANCHISE[up] ?? up;
};

export interface ParsedGame {
  season: number;
  week: number;
  gameDate: string; // YYYYMMDD
  homeId: string;
  awayId: string;
  homePoints: number;
  awayPoints: number;
  neutral: number;
  playoff: number;
  homeRest: number | null;
  awayRest: number | null;
  closeSpread: number | null;
  closeTotal: number | null;
  closeMlHome: number | null;
  closeMlAway: number | null;
}

export interface ParsedFixture {
  season: number;
  week: number;
  commenceTime: string; // ISO
  homeId: string;
  awayId: string;
  neutral: number;
  spreadLine: number | null;
  totalLine: number | null;
}

/** Minimal CSV reader: nflverse quotes stadium names that contain commas. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      o[h] = (r[i] ?? '').trim();
    });
    return o;
  });
}

const REQUIRED = [
  'season', 'game_type', 'week', 'gameday', 'away_team', 'away_score',
  'home_team', 'home_score', 'location', 'spread_line', 'total_line',
];

const num = (v: string | undefined): number | null => {
  if (v == null) return null;
  const t = v.trim();
  if (t === '' || t === 'NA' || t === 'NULL') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Split the file into played games and the fixtures still to come.
 *
 * A row with a date and no score IS the schedule — nflverse publishes the season
 * before it starts and fills the scores in as it goes. That is why this tab has
 * real upcoming games with no API key at all, which none of the other four can
 * claim.
 */
export function parseGames(
  csv: string,
  fromSeason: number,
): { games: ParsedGame[]; fixtures: ParsedFixture[] } {
  const rows = parseCsv(csv);
  if (rows.length === 0) throw new Error('nflverse games.csv came back empty');

  const missing = REQUIRED.filter((c) => !(c in rows[0]));
  if (missing.length > 0) {
    throw new Error(
      `nflverse games.csv is missing the columns this parser needs: ${missing.join(', ')}. ` +
        'The upstream schema changed; fix the mapping rather than ingesting partial rows.',
    );
  }

  const games: ParsedGame[] = [];
  const fixtures: ParsedFixture[] = [];

  for (const r of rows) {
    const season = num(r.season);
    const day = r.gameday;
    if (season == null || season < fromSeason || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    const homeId = canonicalTeam(r.home_team);
    const awayId = canonicalTeam(r.away_team);
    if (!homeId || !awayId || homeId === awayId) continue;

    const week = num(r.week) ?? 0;
    // nflverse's `location` is "Home" or "Neutral". The Super Bowl is always
    // neutral; so are the international games.
    const neutral = r.location && r.location !== 'Home' ? 1 : 0;
    const playoff = r.game_type && r.game_type !== 'REG' ? 1 : 0;

    const hs = num(r.home_score);
    const as = num(r.away_score);

    if (hs == null || as == null) {
      const time = r.gametime && /^\d{2}:\d{2}$/.test(r.gametime) ? r.gametime : '13:00';
      // Kick-off times in the file are the US EASTERN wall clock, and the season
      // straddles the DST change: September to early November is -04:00, the rest
      // -05:00. A fixed offset put every early-season game an hour late (a
      // Thursday night game read 21:20 instead of 20:20), so the offset is looked
      // up for the actual date. See server/src/timezone.ts.
      const commenceTime = zonedToUtc(day, time, 'America/New_York');
      if (!commenceTime) continue;
      fixtures.push({
        season,
        week,
        commenceTime,
        homeId,
        awayId,
        neutral,
        // SIGN CONVERSION, and it matters.
        //
        // nflverse writes `spread_line` as the home team's expected MARGIN:
        // +3.5 means the home team is favoured by three and a half. A bookmaker
        // writes the same game as home −3.5, because the handicap is what gets
        // ADDED to their score. The two are negatives of each other, and the
        // card quotes bookmaker convention because that is what a reader sees on
        // a slip — so the flip happens here, once, at the edge of the system.
        //
        // Verified against the archive rather than assumed: over 3,285 games
        // with spread_line above +3 the home team won 73.3%, and over 1,357
        // below −3 it won 28.4%. Positive is unambiguously the home favourite.
        //
        // Getting this backwards printed "Seattle +3.5 · 75.6% lo cubre" on a
        // game where Seattle were laying the points — the right probability
        // attached to the wrong side of the line.
        spreadLine: num(r.spread_line) != null ? -(num(r.spread_line) as number) : null,
        totalLine: num(r.total_line),
      });
      continue;
    }

    games.push({
      season,
      week,
      gameDate: day.replace(/-/g, ''),
      homeId,
      awayId,
      homePoints: hs,
      awayPoints: as,
      neutral,
      playoff,
      homeRest: num(r.home_rest),
      awayRest: num(r.away_rest),
      closeSpread: num(r.spread_line),
      closeTotal: num(r.total_line),
      closeMlHome: num(r.home_moneyline),
      closeMlAway: num(r.away_moneyline),
    });
  }

  if (games.length === 0) {
    throw new Error('nflverse games.csv parsed to zero played games — refusing to wipe the table');
  }
  games.sort((a, b) =>
    a.gameDate === b.gameDate ? a.homeId.localeCompare(b.homeId) : a.gameDate.localeCompare(b.gameDate),
  );
  return { games, fixtures };
}

/** Team display names, from nflverse's own teams file when it is reachable. */
export function parseTeams(csv: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of parseCsv(csv)) {
    const code = r.team ?? r.abbr ?? r.team_abbr;
    const name = r.full ?? r.name ?? r.team_name;
    if (code && name) out.set(canonicalTeam(code), name);
  }
  return out;
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: 'text/csv,text/plain' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 500) throw new Error(`${url} → suspiciously short response (${text.length} B)`);
  return text;
}

export function storeGames(league: LeagueId, games: ParsedGame[], names: Map<string, string>): void {
  const db = getDb();
  const ids = new Set<string>();
  for (const g of games) {
    ids.add(g.homeId);
    ids.add(g.awayId);
  }

  db.exec('BEGIN');
  try {
    const team = db.prepare(
      'INSERT INTO naf_teams (id, league, name) VALUES (?, ?, ?) ' +
        'ON CONFLICT (league, id) DO UPDATE SET name = excluded.name',
    );
    for (const id of ids) team.run(id, league, names.get(id) ?? TEAM_NAMES[id] ?? id);

    db.prepare('DELETE FROM naf_games WHERE league = ?').run(league);
    const ins = db.prepare(
      `INSERT INTO naf_games
         (league, season, week, game_date, home_id, away_id, home_points, away_points,
          neutral, playoff, home_rest, away_rest,
          close_spread, close_total, close_ml_home, close_ml_away)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (league, season, week, home_id, away_id) DO NOTHING`,
    );
    for (const g of games) {
      ins.run(
        league, g.season, g.week, g.gameDate, g.homeId, g.awayId, g.homePoints, g.awayPoints,
        g.neutral, g.playoff, g.homeRest, g.awayRest,
        g.closeSpread, g.closeTotal, g.closeMlHome, g.closeMlAway,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Store the remaining schedule as upcoming games.
 *
 * Only rows in the future: the file keeps a whole season of fixtures and a card
 * for a game that kicked off three weeks ago is noise. Rows from a live odds
 * feed are left alone — those carry prices, these do not.
 */
export function storeSchedule(league: LeagueId, fixtures: ParsedFixture[], names: Map<string, string>): number {
  const db = getDb();
  const now = Date.now();
  const upcoming = fixtures
    .filter((f) => new Date(f.commenceTime).getTime() > now - 4 * 3600_000)
    .sort((a, b) => a.commenceTime.localeCompare(b.commenceTime))
    .slice(0, 32);

  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM naf_upcoming WHERE league = ? AND source = 'schedule'").run(league);
    const ins = db.prepare(
      `INSERT INTO naf_upcoming
         (id, league, season, week, commence_time, home_name, away_name, home_id, away_id,
          neutral, odds_home, odds_away, spread_line, total_line, books, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, 'schedule', ?)
       ON CONFLICT (id) DO UPDATE SET
         commence_time = excluded.commence_time,
         spread_line   = excluded.spread_line,
         total_line    = excluded.total_line,
         updated_at    = excluded.updated_at`,
    );
    const stamp = new Date().toISOString();
    for (const f of upcoming) {
      ins.run(
        `${league}-${f.season}-${f.week}-${f.awayId}-${f.homeId}`,
        league, f.season, f.week, f.commenceTime,
        names.get(f.homeId) ?? TEAM_NAMES[f.homeId] ?? f.homeId,
        names.get(f.awayId) ?? TEAM_NAMES[f.awayId] ?? f.awayId,
        f.homeId, f.awayId, f.neutral, f.spreadLine, f.totalLine, stamp,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return upcoming.length;
}

export { TEAM_NAMES };

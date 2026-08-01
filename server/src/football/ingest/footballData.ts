// Current-season results and HISTORICAL 1X2 ODDS from football-data.co.uk.
//
// This is the primary source: it covers every major league, is updated within
// days of each round, and carries closing bookmaker odds for every match — which
// is what lets `npm run backtest:fb` ask whether the model beats the market
// instead of only beating a baseline.
//
// TWO LAYOUTS, because the site has two:
//   • "main"  — one CSV per season per division (mmz4281/2425/E0.csv), with
//               Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR + odds columns.
//   • "extra" — one multi-season CSV per country (new/BRA.csv) covering leagues
//               outside Europe, with Country,League,Season,Home,Away,HG,AG,Res.
//
// Columns are located BY HEADER NAME. The layout has drifted over the years
// (bookmakers come and go) and the two variants disagree on nearly every name, so
// a missing required column fails with the headers actually found rather than
// silently ingesting nonsense.
//
// VERIFICATION NOTE: this host is unreachable from the environment the code was
// written in, so parsing is tested against fixtures in the site's real layout.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDb } from '../../db.ts';
import { RAW_DIR, footballConfig } from '../../config.ts';
import { slugify } from './footballcsv.ts';
import type { LeagueConfig } from '../types.ts';

export const MANUAL_DIR = path.join(RAW_DIR, 'football', 'football-data');

const norm = (s: string) => s.toLowerCase().replace(/[\s._-]/g, '');

/** dd/mm/yy or dd/mm/yyyy → YYYYMMDD. */
export function parseUkDate(raw: string): string | null {
  const m = (raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? (Number(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`) : m[3];
  return `${year}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`;
}

export interface ParsedFdMatch {
  date: string;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  oddsHome: number | null;
  oddsDraw: number | null;
  oddsAway: number | null;
}

function pick(headers: string[], aliases: string[]): string | null {
  for (const a of aliases) {
    const h = headers.find((x) => norm(x) === a);
    if (h) return h;
  }
  return null;
}

const num = (v: string | undefined): number | null => {
  const s = (v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const validOdds = (n: number | null) => (n != null && n > 1 && n < 1000 ? n : null);

/**
 * Parse one football-data.co.uk CSV. `leagueFilter` applies only to the "extra"
 * multi-league files, where one file holds several competitions.
 */
export function parseFootballData(
  csv: string,
  source: string,
  leagueFilter?: string,
): ParsedFdMatch[] {
  const rows = parse(csv, {
    columns: true,
    skipEmptyLines: true,
    relaxColumnCount: true,
    relaxQuotes: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  const dateCol = pick(headers, ['date']);
  const homeCol = pick(headers, ['hometeam', 'home']);
  const awayCol = pick(headers, ['awayteam', 'away']);
  const hgCol = pick(headers, ['fthg', 'hg', 'homegoals']);
  const agCol = pick(headers, ['ftag', 'ag', 'awaygoals']);
  if (!dateCol || !homeCol || !awayCol || !hgCol || !agCol) {
    throw new Error(
      `${source}: faltan columnas obligatorias. Encontradas: [${headers.slice(0, 25).join(', ')}]. ` +
        `Se esperaban Date, HomeTeam, AwayTeam, FTHG y FTAG (o Home/Away/HG/AG).`,
    );
  }
  // Odds preference: the average across books is the fairest consensus; Pinnacle
  // is the sharpest single book; Bet365 the most consistently present. "Max" is
  // the best available price, which flatters a bettor and is NOT a fair yardstick.
  const oh = pick(headers, ['avgh', 'avgch', 'psh', 'pch', 'b365h', 'b365ch']);
  const od = pick(headers, ['avgd', 'avgcd', 'psd', 'pcd', 'b365d', 'b365cd']);
  const oa = pick(headers, ['avga', 'avgca', 'psa', 'pca', 'b365a', 'b365ca']);
  const leagueCol = pick(headers, ['league']);

  const out: ParsedFdMatch[] = [];
  for (const r of rows) {
    if (leagueFilter && leagueCol && (r[leagueCol] ?? '').trim() !== leagueFilter) continue;
    const date = parseUkDate(r[dateCol]);
    const home = (r[homeCol] ?? '').trim();
    const away = (r[awayCol] ?? '').trim();
    const hg = num(r[hgCol]);
    const ag = num(r[agCol]);
    if (!date || !home || !away || hg == null || ag == null) continue;
    out.push({
      date,
      homeName: home,
      awayName: away,
      homeGoals: hg,
      awayGoals: ag,
      oddsHome: validOdds(oh ? num(r[oh]) : null),
      oddsDraw: validOdds(od ? num(r[od]) : null),
      oddsAway: validOdds(oa ? num(r[oa]) : null),
    });
  }
  return out;
}

/** Season 2025 → "2425", the site's directory naming. */
function seasonCode(endYear: number): string {
  const a = String((endYear - 1) % 100).padStart(2, '0');
  const b = String(endYear % 100).padStart(2, '0');
  return `${a}${b}`;
}

function manualFile(name: string): string | null {
  const p = path.join(MANUAL_DIR, name);
  return fs.existsSync(p) && fs.statSync(p).size > 100 ? p : null;
}

async function download(url: string, dest: string): Promise<string | null> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100) return dest;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    // A blocked request often returns a short HTML error page with a 200.
    if (text.length < 100 || /^\s*</.test(text)) return null;
    fs.writeFileSync(dest, text);
    return dest;
  } catch {
    return null;
  }
}

export interface FootballDataResult {
  league: string;
  matches: number;
  withOdds: number;
  seasons: number[];
}

/** Ingest seasons for one league from football-data.co.uk. */
export async function ingestFootballData(
  league: LeagueConfig,
  seasons: number[],
): Promise<FootballDataResult> {
  if (!league.footballData) return { league: league.id, matches: 0, withOdds: 0, seasons: [] };
  const db = getDb();
  const cacheDir = path.join(RAW_DIR, 'football', 'football-data-cache');

  const insertTeam = db.prepare(
    `INSERT INTO fb_teams (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );
  const insertMatch = db.prepare(
    `INSERT INTO fb_matches
       (league, season, match_date, home_id, away_id, home_goals, away_goals, result,
        odds_home, odds_draw, odds_away)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, match_date, home_id, away_id) DO UPDATE SET
       odds_home = COALESCE(excluded.odds_home, fb_matches.odds_home),
       odds_draw = COALESCE(excluded.odds_draw, fb_matches.odds_draw),
       odds_away = COALESCE(excluded.odds_away, fb_matches.odds_away)`,
  );

  let matches = 0;
  let withOdds = 0;
  const used: number[] = [];

  const files: { file: string; season: number | null }[] = [];
  if (league.footballData.kind === 'main') {
    for (const season of seasons) {
      const code = seasonCode(season);
      const name = `${league.id}-${code}.csv`;
      const url = `${footballConfig.history.footballDataBase}/${code}/${league.footballData.div}.csv`;
      const f = manualFile(name) ?? (await download(url, path.join(cacheDir, name)));
      if (f) files.push({ file: f, season });
    }
  } else {
    // One file per country covering many seasons; the season comes from the row.
    const name = league.footballData.file;
    const url = `${footballConfig.history.footballDataExtraBase}/${name}`;
    const f = manualFile(name) ?? (await download(url, path.join(cacheDir, name)));
    if (f) files.push({ file: f, season: null });
  }

  for (const { file, season } of files) {
    const parsed = parseFootballData(
      fs.readFileSync(file, 'utf8'),
      path.basename(file),
      league.footballData.kind === 'extra' ? league.footballData.league : undefined,
    );
    if (parsed.length === 0) continue;

    db.exec('BEGIN');
    try {
      for (const m of parsed) {
        // For the multi-season files, derive the season from the match date:
        // a match in July or later belongs to the season ending next year.
        const y = Number(m.date.slice(0, 4));
        const mo = Number(m.date.slice(4, 6));
        const s = season ?? (mo >= 7 ? y + 1 : y);
        if (seasons.length && !seasons.includes(s)) continue;
        const homeId = slugify(m.homeName);
        const awayId = slugify(m.awayName);
        insertTeam.run(homeId, league.id, m.homeName);
        insertTeam.run(awayId, league.id, m.awayName);
        insertMatch.run(
          league.id,
          s,
          m.date,
          homeId,
          awayId,
          m.homeGoals,
          m.awayGoals,
          m.homeGoals > m.awayGoals ? 'H' : m.homeGoals === m.awayGoals ? 'D' : 'A',
          m.oddsHome,
          m.oddsDraw,
          m.oddsAway,
        );
        matches++;
        if (m.oddsHome && m.oddsDraw && m.oddsAway) withOdds++;
        if (!used.includes(s)) used.push(s);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return { league: league.id, matches, withOdds, seasons: used.sort() };
}

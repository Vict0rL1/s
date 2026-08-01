// Ingest real league results from the footballcsv project on GitHub.
//
// WHAT THIS IS FOR
// ----------------
// A GitHub-hosted, public-domain mirror of league results going back ~20 seasons
// for England, Spain and Germany. Two jobs:
//
//   1. FITTING. Home advantage, the Elo→goals conversion and the Dixon-Coles
//      correction are all chosen by measuring them on these matches.
//   2. A FALLBACK. It needs nothing but GitHub, so a network that blocks
//      football-data.co.uk still gets real data to work with.
//
// WHAT IT IS NOT
// --------------
// The mirror lags by a few seasons, so it is never the source of ratings for
// this weekend's fixtures — football-data.co.uk is (see footballData.ts). The
// update script says so out loud rather than presenting old ratings as current.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDb } from '../../db.ts';
import { RAW_DIR, footballConfig } from '../../config.ts';
import type { LeagueConfig } from '../types.ts';

export const CACHE_DIR = path.join(RAW_DIR, 'football', 'footballcsv');

/** Team name → stable slug. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** "Sat Aug 17 2013" or "2013-08-17" → YYYYMMDD. */
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
export function parseDate(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  // "Sat Aug 17 2013" / "Aug 17 2013"
  const m = v.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (mm) return `${m[3]}${mm}${m[2].padStart(2, '0')}`;
  }
  return null;
}

export interface ParsedMatch {
  date: string;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s._-]/g, '');

/**
 * Parse one season file. Columns are located BY HEADER NAME because the header
 * drifts across repos and eras ("Round" vs "Matchday", "FT" vs "Score"); relying
 * on position would silently mis-read whole seasons.
 */
export function parseFootballCsv(csv: string, source: string): ParsedMatch[] {
  const rows = parse(csv, {
    columns: true,
    skipEmptyLines: true,
    relaxColumnCount: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  const find = (aliases: string[]) =>
    headers.find((h) => aliases.includes(norm(h))) ?? null;

  const dateCol = find(['date']);
  const homeCol = find(['team1', 'home', 'hometeam']);
  const awayCol = find(['team2', 'away', 'awayteam']);
  const scoreCol = find(['ft', 'score', 'result', 'ftscore']);
  if (!dateCol || !homeCol || !awayCol || !scoreCol) {
    throw new Error(
      `${source}: faltan columnas. Encontradas: [${headers.join(', ')}]. ` +
        `Se esperaban Date, Team 1, FT y Team 2.`,
    );
  }

  const out: ParsedMatch[] = [];
  for (const r of rows) {
    const date = parseDate(r[dateCol]);
    const home = (r[homeCol] ?? '').trim();
    const away = (r[awayCol] ?? '').trim();
    const score = (r[scoreCol] ?? '').trim();
    if (!date || !home || !away) continue;
    // "4-1", sometimes "4-1 (2-0)" with the half-time score appended.
    const m = score.match(/^(\d+)\s*-\s*(\d+)/);
    if (!m) continue; // not played / abandoned
    out.push({
      date,
      homeName: home,
      awayName: away,
      homeGoals: Number(m[1]),
      awayGoals: Number(m[2]),
    });
  }
  return out;
}

/** Season label "2019-20" → the year it ends in (2020). */
function seasonEndYear(label: string): number {
  const m = label.match(/^(\d{4})-(\d{2})$/);
  if (!m) return Number(label) || 0;
  const start = Number(m[1]);
  const endTwo = Number(m[2]);
  return Math.floor(start / 100) * 100 + endTwo + (endTwo < start % 100 ? 100 : 0);
}

async function fetchSeason(
  league: LeagueConfig,
  seasonLabel: string,
): Promise<string | null> {
  if (!league.footballcsv) return null;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, `${league.footballcsv.div}_${seasonLabel}.csv`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 200) return dest;

  const startYear = Number(seasonLabel.slice(0, 4));
  const decade = `${Math.floor(startYear / 10) * 10}s`;
  const url =
    `${footballConfig.history.footballCsvBase}/${league.footballcsv.repo}` +
    `/master/${decade}/${seasonLabel}/${league.footballcsv.div}.csv`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length < 200) return null;
    fs.writeFileSync(dest, text);
    return dest;
  } catch {
    return null;
  }
}

export interface FootballCsvResult {
  league: string;
  matches: number;
  teams: number;
  seasons: string[];
}

/** Ingest a range of seasons for one league from the GitHub mirror. */
export async function ingestFootballCsv(
  league: LeagueConfig,
  seasonLabels: string[],
): Promise<FootballCsvResult> {
  if (!league.footballcsv) {
    return { league: league.id, matches: 0, teams: 0, seasons: [] };
  }
  const db = getDb();
  const insertTeam = db.prepare(
    `INSERT INTO fb_teams (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );
  const insertMatch = db.prepare(
    `INSERT INTO fb_matches
       (league, season, match_date, home_id, away_id, home_goals, away_goals, result,
        odds_home, odds_draw, odds_away)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(league, match_date, home_id, away_id) DO NOTHING`,
  );

  const teams = new Map<string, string>();
  let matches = 0;
  const used: string[] = [];

  for (const label of seasonLabels) {
    const file = await fetchSeason(league, label);
    if (!file) continue;
    const parsed = parseFootballCsv(fs.readFileSync(file, 'utf8'), path.basename(file));
    if (parsed.length === 0) continue;
    used.push(label);
    const season = seasonEndYear(label);

    db.exec('BEGIN');
    try {
      for (const m of parsed) {
        const homeId = slugify(m.homeName);
        const awayId = slugify(m.awayName);
        teams.set(homeId, m.homeName);
        teams.set(awayId, m.awayName);
        insertTeam.run(homeId, league.id, m.homeName);
        insertTeam.run(awayId, league.id, m.awayName);
        insertMatch.run(
          league.id,
          season,
          m.date,
          homeId,
          awayId,
          m.homeGoals,
          m.awayGoals,
          m.homeGoals > m.awayGoals ? 'H' : m.homeGoals === m.awayGoals ? 'D' : 'A',
        );
        matches++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return { league: league.id, matches, teams: teams.size, seasons: used };
}

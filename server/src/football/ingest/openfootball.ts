// Ingest league results from openfootball/football.json.
//
// ===========================================================================
// WHY THIS SOURCE, AND WHY IT MATTERS MORE THAN THE OTHER TWO
// ===========================================================================
// The football tab's history ended in **July 2020**. Every Elo on it described the
// teams of six years ago, and the app said so in an amber banner — which is honest
// but is not a fix. The cause was that footballcsv, the source it fits on, was
// abandoned after 2020-21.
//
// footballcsv is a MIRROR. This is what it mirrors, and the upstream is alive:
//
//     liga      2019-20  2020-21  2021-22  2022-23  2023-24  2024-25  2025-26
//     en.1      380/380  380/380  380/380  380/380  380/380  380/380  353/380
//     en.2      552/552  552/552  557/557  557/557  557/557  557/557  521/557
//     es.1      380/380  380/380  380/380  380/380  380/380  370/380  365/380
//     de.1      306/306  306/306  306/306  306/306  306/306  306/306  294/306
//     it.1      380/380  380/380  380/380  380/380  380/380  370/380  344/380
//     fr.1      279/380  380/380  380/380  380/380  306/306  306/306  282/306
//     nl.1      232/306  306/306  306/306  306/306  306/306  306/306  295/306
//     pt.1      306/306  306/306  306/306  306/306  306/306  306/306  287/306
//
// (scored / scheduled, measured against the live repo.)
//
// So this does two things at once. It moves the history from 2020 to the current
// season — and it gives Serie A, Ligue 1, Eredivisie, Primeira, Liga MX and the
// Argentine league a RESULTS SOURCE for the first time. Those five were configured
// as tabs and could only ever show the market's numbers, because nothing in the app
// knew a single one of their matches.
//
// ===========================================================================
// TWO THINGS THE JSON HAS THAT THE CSV DID NOT
// ===========================================================================
//   * HALF-TIME SCORES (`score.ht`). Stored but not yet modelled — see the note on
//     the schema. It is the one piece of data that would make "wins either half", a
//     market this app's reader actually bets, possible rather than invented.
//   * Kick-off TIMES, so a historical match has an hour and not just a date.
//
// ===========================================================================
// WHAT IT STILL IS NOT
// ===========================================================================
// It carries no BOOKMAKER ODDS. football-data.co.uk remains the only source of
// historical closing prices, which is what lets the model be measured against the
// market rather than just against a coin. The two are complements: this one supplies
// depth and currency, that one supplies the benchmark.

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db.ts';
import { RAW_DIR, footballConfig } from '../../config.ts';
import { slugify } from './footballcsv.ts';
import type { LeagueConfig } from '../types.ts';

export const CACHE_DIR = path.join(RAW_DIR, 'football', 'openfootball');

/** One match as the JSON gives it. */
interface RawMatch {
  round?: string;
  date?: string;
  time?: string;
  team1?: string;
  team2?: string;
  score?: { ft?: [number, number]; ht?: [number, number] };
}

export interface OpenFootballMatch {
  /** YYYYMMDD. */
  date: string;
  /** "HH:MM" when the file has it. */
  time: string | null;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  /** Half-time, when present. Null is common in the older seasons. */
  htHome: number | null;
  htAway: number | null;
}

/**
 * Parse one season file.
 *
 * Deliberately tolerant: a match with no `score.ft` has not been played (or was
 * abandoned) and is skipped rather than stored as 0-0, which is the single worst
 * thing an ingest can do to a rating.
 */
export function parseOpenFootball(json: string, source: string): OpenFootballMatch[] {
  let data: { name?: string; matches?: RawMatch[] };
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`${source}: JSON ilegible — ${(e as Error).message}`);
  }
  const out: OpenFootballMatch[] = [];
  for (const m of data.matches ?? []) {
    const ft = m.score?.ft;
    if (!Array.isArray(ft) || ft.length < 2) continue;
    if (!Number.isFinite(ft[0]) || !Number.isFinite(ft[1])) continue;
    const d = (m.date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const home = (m.team1 ?? '').trim();
    const away = (m.team2 ?? '').trim();
    if (!d || !home || !away) continue;
    const ht = m.score?.ht;
    out.push({
      date: `${d[1]}${d[2]}${d[3]}`,
      time: /^\d{1,2}:\d{2}$/.test(m.time ?? '') ? (m.time as string) : null,
      homeName: home,
      awayName: away,
      homeGoals: Number(ft[0]),
      awayGoals: Number(ft[1]),
      htHome: Array.isArray(ht) && Number.isFinite(ht[0]) ? Number(ht[0]) : null,
      htAway: Array.isArray(ht) && Number.isFinite(ht[1]) ? Number(ht[1]) : null,
    });
  }
  return out;
}

/** Season label "2019-20" → the year it ends in (2020), matching fb_matches.season. */
function seasonEndYear(label: string): number {
  const m = label.match(/^(\d{4})-(\d{2})$/);
  if (!m) return Number(label) || 0;
  const start = Number(m[1]);
  const endTwo = Number(m[2]);
  return Math.floor(start / 100) * 100 + endTwo + (endTwo < start % 100 ? 100 : 0);
}

/**
 * Season labels to fetch, newest first, ending with the season now in progress.
 *
 * European seasons are named by the year they END in, and the new one starts in
 * August — so in September 2026 the current label is "2026-27" and in March 2026 it
 * is still "2025-26". Getting this wrong is how an ingest silently skips the season
 * everyone actually cares about.
 */
export function seasonLabels(count: number, now = new Date()): string[] {
  const y = now.getFullYear();
  const startYear = now.getMonth() + 1 >= 7 ? y : y - 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = startYear - i;
    out.push(`${s}-${String((s + 1) % 100).padStart(2, '0')}`);
  }
  return out;
}

async function fetchSeason(league: LeagueConfig, label: string): Promise<string | null> {
  const key = league.openfootball?.key;
  if (!key) return null;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, `${key}_${label}.json`);
  // The CURRENT season is never cached: it gains matches every weekend, and serving
  // a week-old copy of it is exactly the staleness this whole file exists to remove.
  const current = seasonLabels(1)[0];
  if (label !== current && fs.existsSync(dest) && fs.statSync(dest).size > 200) return dest;

  const url = `${footballConfig.history.openfootballBase}/${label}/${key}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.text();
    if (body.length < 100) return null;
    fs.writeFileSync(dest, body);
    return dest;
  } catch {
    // A missing season is normal — not every league has every year — so this is a
    // skip and not an error. A network that is down shows up as every season
    // missing, which the caller reports as zero matches.
    return null;
  }
}

export interface OpenFootballResult {
  league: string;
  matches: number;
  teams: number;
  seasons: string[];
  /** Newest match ingested, YYYYMMDD — what the staleness banner reads. */
  through: string | null;
  withHalfTime: number;
}

export async function ingestOpenFootball(
  league: LeagueConfig,
  labels: string[],
): Promise<OpenFootballResult> {
  const empty: OpenFootballResult = {
    league: league.id,
    matches: 0,
    teams: 0,
    seasons: [],
    through: null,
    withHalfTime: 0,
  };
  if (!league.openfootball) return empty;

  const db = getDb();
  const insertTeam = db.prepare(
    `INSERT INTO fb_teams (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );
  // Odds are left alone on conflict: football-data.co.uk may already have filled
  // them in for this match, and this source has none. Overwriting them with NULL
  // would destroy the only benchmark the model can be measured against.
  const insertMatch = db.prepare(
    `INSERT INTO fb_matches
       (league, season, match_date, home_id, away_id, home_goals, away_goals, result,
        odds_home, odds_draw, odds_away, ht_home_goals, ht_away_goals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(league, match_date, home_id, away_id) DO UPDATE SET
       home_goals = excluded.home_goals,
       away_goals = excluded.away_goals,
       result = excluded.result,
       season = excluded.season,
       ht_home_goals = COALESCE(excluded.ht_home_goals, fb_matches.ht_home_goals),
       ht_away_goals = COALESCE(excluded.ht_away_goals, fb_matches.ht_away_goals)`,
  );

  const teams = new Map<string, string>();
  let matches = 0;
  let withHalfTime = 0;
  let through: string | null = null;
  const used: string[] = [];

  for (const label of labels) {
    const file = await fetchSeason(league, label);
    if (!file) continue;
    let parsed: OpenFootballMatch[];
    try {
      parsed = parseOpenFootball(fs.readFileSync(file, 'utf8'), path.basename(file));
    } catch (e) {
      process.stderr.write(`  ${league.id} ${label}: ${(e as Error).message}\n`);
      continue;
    }
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
          m.htHome,
          m.htAway,
        );
        matches++;
        if (m.htHome != null) withHalfTime++;
        if (!through || m.date > through) through = m.date;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return {
    league: league.id,
    matches,
    teams: teams.size,
    seasons: used,
    through,
    withHalfTime,
  };
}

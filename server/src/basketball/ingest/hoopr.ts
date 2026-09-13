// Current NBA results from hoopR, on GitHub.
//
// ===========================================================================
// WHY A THIRD BASKETBALL SOURCE
// ===========================================================================
// There were two, and between them they left an eleven-year hole:
//
//   * fivethirtyeight — real, game by game, 1946 to **June 2015**, and then it
//     stops because the project stopped. It is what the model was fitted on.
//   * ESPN's site API — current, and the right answer on a normal connection. But
//     it is a live API on a host a corporate or filtered network can block, and
//     when it is blocked the tab falls back to 2015 ratings.
//
// So the basketball tab could be serving an Elo built on the 2014-15 Warriors with
// nothing but an amber banner to say so. This is the same failure the football tab
// had, and it has the same fix: a source that needs nothing but GitHub.
//
// hoopR mirrors ESPN's schedule into a single CSV in a public repo, 2002 to the
// present. Measured against the live file:
//
//     2019  1314 games, 1314 with scores, through 2019-06-14
//     2022  1335                   1335              2022-06-17
//     2025  1329                   1329              2025-06-23
//     2026  1330                   1330              2026-06-14   ← current
//
// ===========================================================================
// THE COST, STATED PLAINLY
// ===========================================================================
// The file is ONE CSV of about 37 MB covering every season at once — there is no
// per-season split in the CSV form (the per-season files are parquet, which would
// mean a new dependency for a format nothing else here reads). So the first run
// downloads 37 MB and later runs use the cache. That is a poor trade for a phone
// and a fine one for a laptop, which is why it is cached aggressively and why the
// season filter is applied while parsing rather than after.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDb } from '../../db.ts';
import { RAW_DIR } from '../../config.ts';
import { slugify } from './fivethirtyeight.ts';
import { buildNameIndex, resolve } from './teamNames.ts';

export const CACHE_DIR = path.join(RAW_DIR, 'basketball', 'hoopr');
export const SCHEDULE_URL =
  'https://raw.githubusercontent.com/sportsdataverse/hoopR-nba-data/main/nba/schedules/nba_schedule_master.csv';

/**
 * ESPN's season types. 2 is the regular season and 3 the play-offs; 1 is the
 * pre-season and 4 the All-Star weekend.
 *
 * Filtering these matters more than it looks. A pre-season game is a real result
 * played by half a roster, and letting it move an Elo is how a model arrives at
 * opening night believing a team is worse than it is. The All-Star game would be
 * worse still: it is not a contest.
 */
const REGULAR = '2';
const PLAYOFFS = '3';

/**
 * Exhibitions that ESPN files under a real season type.
 *
 * The season-type filter alone was not enough: All-Star weekend arrives tagged as
 * play-off basketball, and the first run of this ingest created seventeen "teams"
 * out of it — East All-Stars, Team LeBron, Team Giannis, USA, World, Team
 * Stars/Stripes. Sixty-odd games that are not contests, each one moving somebody's
 * Elo. Matched on the NAME because that is the only thing that distinguishes them.
 */
const EXHIBITION = /all-?stars?|^team |^usa$|^world$|rising stars/i;

/**
 * ESPN's spelling → the id FiveThirtyEight already uses.
 *
 * Everything else the name resolver handles on its own ("Los Angeles Lakers" finds
 * "Lakers" by its trailing word). These are the ones it cannot:
 *
 *   · "76ers" and "Trail Blazers" — 538 writes them "Sixers" and "Trailblazers", so
 *     there is no shared word to match on.
 *   · RELOCATIONS AND RENAMES. 538 files a franchise's whole history under its
 *     current name; ESPN uses the name in use at the time. So the Sonics' 2002-2008
 *     seasons are Thunder history, and the New Orleans Hornets are Pelicans history.
 *
 * The Charlotte knot is genuinely ambiguous and worth naming: Charlotte Hornets
 * (1988-2002) → New Orleans Hornets → Pelicans, while a separate Charlotte
 * franchise began in 2004 as the Bobcats and took the Hornets name in 2014 (the
 * league also transferred the 1988-2002 records back to it). This follows 538's
 * lineage — the pre-2002 history stays with the Pelicans — because 538 is what the
 * model was fitted on. Documented rather than silently chosen.
 */
const ALIASES: Record<string, string> = {
  'philadelphia 76ers': 'sixers',
  '76ers': 'sixers',
  'portland trail blazers': 'trailblazers',
  'trail blazers': 'trailblazers',
  'seattle supersonics': 'thunder',
  supersonics: 'thunder',
  'new orleans hornets': 'pelicans',
  'new orleans/oklahoma city hornets': 'pelicans',
  'charlotte bobcats': 'charlotte-hornets',
  bobcats: 'charlotte-hornets',
  'charlotte hornets': 'charlotte-hornets',
};

/** Normalised the same way the name index normalises, so lookups agree. */
function aliasOf(name: string): string | null {
  const n = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[n] ?? ALIASES[n.split(' ').slice(-1)[0]] ?? null;
}

export interface HooprGame {
  season: number;
  /** YYYYMMDD. */
  date: string;
  homeId: string;
  awayId: string;
  homeName: string;
  awayName: string;
  homePts: number;
  awayPts: number;
  neutral: boolean;
  isPlayoff: boolean;
}

/** "2026-06-14T00:30Z" or "2026-06-14" → YYYYMMDD. */
function toYmd(raw: string): string | null {
  const m = (raw ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * Parse the schedule CSV.
 *
 * Columns by NAME, never by position: this file has 100+ of them and ESPN adds more
 * over time, so a positional read would silently shift the day a column is inserted.
 */
export function parseHoopr(csv: string, fromSeason: number): HooprGame[] {
  const rows = parse(csv, {
    columns: true,
    skipEmptyLines: true,
    relaxColumnCount: true,
    relaxQuotes: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  const out: HooprGame[] = [];
  for (const r of rows) {
    const season = Number(r.season);
    if (!Number.isFinite(season) || season < fromSeason) continue;
    const type = String(r.season_type ?? '');
    if (type !== REGULAR && type !== PLAYOFFS) continue;

    const date = toYmd(r.date || r.start_date || '');
    const hp = Number(r.home_score);
    const ap = Number(r.away_score);
    // No score means not played (or postponed). Storing it as 0-0 would be the
    // single most damaging thing this parser could do to a rating.
    if (!date || !Number.isFinite(hp) || !Number.isFinite(ap)) continue;
    // ESPN leaves a completed flag; when it is present and false, trust it.
    if (String(r.status_type_completed ?? '').toLowerCase() === 'false') continue;

    const homeName = (r.home_display_name || r.home_name || '').trim();
    const awayName = (r.away_display_name || r.away_name || '').trim();
    if (!homeName || !awayName || homeName === awayName) continue;
    if (EXHIBITION.test(homeName) || EXHIBITION.test(awayName)) continue;

    out.push({
      season,
      date,
      homeId: slugify(homeName),
      awayId: slugify(awayName),
      homeName,
      awayName,
      homePts: hp,
      awayPts: ap,
      neutral: String(r.neutral_site ?? '').toLowerCase() === 'true',
      isPlayoff: type === PLAYOFFS,
    });
  }
  return out;
}

async function download(): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, 'nba_schedule_master.csv');
  // Cached for a day. The file is 37 MB and gains a handful of rows a night, so
  // re-fetching it on every `update-data:bb` would be minutes of transfer for a
  // few games — but a week-old copy would miss a week of results, which is the
  // staleness this file exists to remove.
  if (fs.existsSync(dest)) {
    const ageHours = (Date.now() - fs.statSync(dest).mtimeMs) / 3_600_000;
    if (ageHours < 24) return fs.readFileSync(dest, 'utf8');
  }
  const res = await fetch(SCHEDULE_URL);
  if (!res.ok) throw new Error(`hoopR HTTP ${res.status}`);
  const body = await res.text();
  if (body.length < 10_000) throw new Error(`hoopR: respuesta demasiado corta (${body.length} bytes)`);
  fs.writeFileSync(dest, body);
  return body;
}

export interface HooprResult {
  games: number;
  teams: number;
  seasons: number[];
  /** Newest game ingested, YYYYMMDD. */
  through: string | null;
  /**
   * Rows whose team could not be matched to an existing franchise and got a new id.
   *
   * Reported rather than hidden: a non-zero count on a league that already has teams
   * means the resolver is missing a spelling, which is how a franchise gets split.
   */
  unmatched: number;
}

export async function ingestHoopr(opts: { fromSeason?: number } = {}): Promise<HooprResult> {
  const fromSeason = opts.fromSeason ?? 2003;
  const games = parseHoopr(await download(), fromSeason);
  if (games.length === 0) return { games: 0, teams: 0, seasons: [], through: null, unmatched: 0 };

  const db = getDb();
  const insertTeam = db.prepare(
    `INSERT INTO bb_teams (id, league, name) VALUES (?, 'nba', ?)
     ON CONFLICT(league, id) DO NOTHING`,
  );
  const insertGame = db.prepare(
    `INSERT INTO bb_games
       (league, season, game_date, home_id, away_id, home_pts, away_pts, neutral, is_playoff, overtimes)
     VALUES ('nba', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(league, game_date, home_id, away_id) DO UPDATE SET
       home_pts = excluded.home_pts,
       away_pts = excluded.away_pts,
       season = excluded.season,
       is_playoff = excluded.is_playoff`,
  );

  // Resolve against the teams already in the table before inventing new ids.
  //
  // THIS IS THE LOAD-BEARING PART. FiveThirtyEight stores the bare nickname
  // ("Lakers"); this file gets the full name ("Los Angeles Lakers"). Slugifying
  // blindly took the NBA from 45 teams to 98 and left the Lakers with 6,023 games
  // under one id and 2,134 under another, overlapping in 2002-2015 — every
  // franchise split in half, every Elo built from a fraction of its own history,
  // and the shared seasons stored twice.
  const index = buildNameIndex('nba');
  const teams = new Map<string, string>();
  const seasons = new Set<number>();
  let unmatched = 0;
  let through: string | null = null;

  db.exec('BEGIN');
  try {
    for (const g of games) {
      // Alias first, then the resolver, then a fresh slug as the last resort.
      const homeId = aliasOf(g.homeName) ?? resolve(index, g.homeName) ?? g.homeId;
      const awayId = aliasOf(g.awayName) ?? resolve(index, g.awayName) ?? g.awayId;
      if (
        (!aliasOf(g.homeName) && !resolve(index, g.homeName)) ||
        (!aliasOf(g.awayName) && !resolve(index, g.awayName))
      ) {
        unmatched++;
      }
      teams.set(homeId, g.homeName);
      teams.set(awayId, g.awayName);
      // The name is NOT overwritten on an existing team: the resolver matched this
      // row to a franchise already in the table, and renaming "Lakers" to "Los
      // Angeles Lakers" mid-ingest would break the very index that matched it.
      insertTeam.run(homeId, g.homeName);
      insertTeam.run(awayId, g.awayName);
      insertGame.run(
        g.season,
        g.date,
        homeId,
        awayId,
        g.homePts,
        g.awayPts,
        g.neutral ? 1 : 0,
        g.isPlayoff ? 1 : 0,
      );
      seasons.add(g.season);
      if (!through || g.date > through) through = g.date;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    games: games.length,
    teams: teams.size,
    seasons: [...seasons].sort((a, b) => a - b),
    through,
    unmatched,
  };
}

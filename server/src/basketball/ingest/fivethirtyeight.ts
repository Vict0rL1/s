// Ingest real NBA game results from FiveThirtyEight's published Elo dataset.
//
// WHAT THIS IS FOR
// ----------------
// 63,157 real NBA games, 1946–2015, with final scores, home/away/neutral venue
// and a playoff flag. Two jobs:
//
//   1. FITTING. Every constant in ../elo.ts (home advantage, margin weight, rest,
//      season carryover, calibration) is chosen by measuring it on this sample
//      instead of copying a number from a blog post.
//   2. A BENCHMARK. The file also contains 538's own pre-game forecast for each
//      game, so `npm run backtest:bb` can score this model against a published,
//      independent one on identical games — a far harder yardstick than "better
//      than a coin flip".
//
// WHAT IT IS NOT
// --------------
// It ends in 2015, so it can never be the source of ratings for tonight's games.
// The current-season source is ESPN (see espn.ts). Presenting 2015 ratings as
// current would be exactly the staleness failure the tennis side already warns
// about, so `update-data:bb` treats this source as history-only and says so.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDb } from '../../db.ts';
import { RAW_DIR, basketballConfig } from '../../config.ts';

/** M/D/YYYY (the file's format) → YYYYMMDD. */
function toYmd(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`;
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  return null;
}

/** Franchise name → stable slug ("Trail Blazers" → "trail-blazers"). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const CACHE = path.join(RAW_DIR, 'basketball', 'nbaallelo.csv');

async function ensureFile(): Promise<string> {
  if (fs.existsSync(CACHE) && fs.statSync(CACHE).size > 1_000_000) return CACHE;
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const url = basketballConfig.history.fivethirtyeightUrl;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `No se pudo descargar el histórico NBA de FiveThirtyEight (HTTP ${res.status}). ` +
        `URL: ${url}. Si tu red bloquea GitHub, descarga el CSV a mano y guárdalo en ${CACHE}.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(CACHE, buf);
  return CACHE;
}

export interface HistoricalGame {
  season: number;
  date: string; // YYYYMMDD
  homeId: string;
  awayId: string;
  homeName: string;
  awayName: string;
  homePts: number;
  awayPts: number;
  neutral: boolean;
  isPlayoff: boolean;
  /** 538's own pre-game probability for the HOME team, when available. */
  benchmarkHomeProb: number | null;
}

/**
 * Parse the dataset into one row per game.
 *
 * The file stores each game TWICE — once from each team's perspective, flagged by
 * `_iscopy`. Taking only the original rows halves the work and, more importantly,
 * avoids counting every game twice in the ratings, which would silently double
 * every K-factor.
 */
export function parseFiveThirtyEight(csv: string): HistoricalGame[] {
  const rows = parse(csv, { columns: true, skipEmptyLines: true, relaxColumnCount: true }) as Record<
    string,
    string
  >[];
  const out: HistoricalGame[] = [];
  for (const r of rows) {
    if (r._iscopy !== '0') continue; // keep one row per game
    if ((r.lg_id || '').toUpperCase() !== 'NBA') continue; // skip the ABA
    const date = toYmd(r.date_game || '');
    if (!date) continue;
    const pts = Number(r.pts);
    const oppPts = Number(r.opp_pts);
    if (!Number.isFinite(pts) || !Number.isFinite(oppPts)) continue;

    const venue = (r.game_location || '').toUpperCase(); // H | A | N
    const neutral = venue === 'N';
    // `team_id` is the row's subject; game_location says where THEY played.
    const teamIsHome = venue === 'H' || neutral; // neutral: orientation is arbitrary
    const teamName = r.fran_id || r.team_id;
    const oppName = r.opp_fran || r.opp_id;

    const forecast = Number(r.forecast);
    // `forecast` is the row subject's win probability; flip it if they're away.
    const benchmark = Number.isFinite(forecast)
      ? teamIsHome
        ? forecast
        : 1 - forecast
      : null;

    out.push({
      season: Number(r.year_id) || Number(date.slice(0, 4)),
      date,
      homeId: slugify(teamIsHome ? teamName : oppName),
      awayId: slugify(teamIsHome ? oppName : teamName),
      homeName: teamIsHome ? teamName : oppName,
      awayName: teamIsHome ? oppName : teamName,
      homePts: teamIsHome ? pts : oppPts,
      awayPts: teamIsHome ? oppPts : pts,
      neutral,
      isPlayoff: r.is_playoffs === '1',
      benchmarkHomeProb: benchmark,
    });
  }
  // Chronological: ratings only ever reflect earlier games.
  out.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  return out;
}

/** Download (once), parse and store into bb_teams / bb_games under league "nba". */
export async function ingestFiveThirtyEight(opts: { fromSeason?: number } = {}): Promise<{
  games: number;
  teams: number;
  from: string;
  to: string;
}> {
  const file = await ensureFile();
  let games = parseFiveThirtyEight(fs.readFileSync(file, 'utf8'));
  if (opts.fromSeason) games = games.filter((g) => g.season >= opts.fromSeason!);

  const db = getDb();
  const insertTeam = db.prepare(
    `INSERT INTO bb_teams (id, league, name, abbreviation, location, conference, division, logo)
     VALUES (?, 'nba', ?, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );
  const insertGame = db.prepare(
    `INSERT INTO bb_games
       (league, season, game_date, home_id, away_id, home_pts, away_pts, neutral, is_playoff, overtimes)
     VALUES ('nba', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(league, game_date, home_id, away_id) DO NOTHING`,
  );

  const teams = new Map<string, string>();
  for (const g of games) {
    teams.set(g.homeId, g.homeName);
    teams.set(g.awayId, g.awayName);
  }

  db.exec('BEGIN');
  try {
    for (const [id, name] of teams) insertTeam.run(id, name);
    for (const g of games) {
      insertGame.run(
        g.season,
        g.date,
        g.homeId,
        g.awayId,
        g.homePts,
        g.awayPts,
        g.neutral ? 1 : 0,
        g.isPlayoff ? 1 : 0,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    games: games.length,
    teams: teams.size,
    from: games[0]?.date ?? '',
    to: games[games.length - 1]?.date ?? '',
  };
}

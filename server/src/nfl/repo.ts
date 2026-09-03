// Read queries and rating persistence for the American football side.
//
// Every per-team lookup is written as two indexed halves joined by UNION ALL
// rather than as `WHERE home_id = ? OR away_id = ?`. That is not style: SQLite's
// planner cannot use an index for an OR across two different columns and falls
// back to scanning the whole table. The same mistake cost 612 ms per prediction
// on the tennis side before it was fixed this way.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db.ts';
import { freshFilter } from '../freshness.ts';
import { pythagorean } from './model.ts';
import { replayGames, type NafTeamState, type ReplayGame } from './ratings.ts';
import type {
  LeagueId,
  NafConfig,
  NafGameRow,
  NafRecord,
  NafTeamInfo,
  NafTeamRatingRow,
  NafTeamRow,
  NafUpcomingRow,
} from './types.ts';

let configCache: NafConfig | null = null;

export function getConfig(root = process.cwd()): NafConfig {
  if (configCache) return configCache;
  // The server can be started from the repo root or from server/, so try both
  // rather than making the caller care.
  const candidates = [
    join(root, 'config', 'americanfootball.json'),
    join(root, '..', 'config', 'americanfootball.json'),
  ];
  for (const p of candidates) {
    try {
      configCache = JSON.parse(readFileSync(p, 'utf8')) as NafConfig;
      return configCache;
    } catch {
      // try the next one
    }
  }
  throw new Error('config/americanfootball.json not found');
}

export const listLeagues = () => getConfig().leagues;
export const findLeague = (id: LeagueId) => getConfig().leagues.find((l) => l.id === id) ?? null;

// ---------------------------------------------------------------------------
// Counts and teams
// ---------------------------------------------------------------------------
export function countTeams(league?: LeagueId): number {
  const db = getDb();
  const row = league
    ? db.prepare('SELECT COUNT(*) AS n FROM naf_teams WHERE league = ?').get(league)
    : db.prepare('SELECT COUNT(*) AS n FROM naf_teams').get();
  return (row as unknown as { n: number })?.n ?? 0;
}

export function countGames(league?: LeagueId): number {
  const db = getDb();
  const row = league
    ? db.prepare('SELECT COUNT(*) AS n FROM naf_games WHERE league = ?').get(league)
    : db.prepare('SELECT COUNT(*) AS n FROM naf_games').get();
  return (row as unknown as { n: number })?.n ?? 0;
}

/**
 * The last season in the archive.
 *
 * Needed because this sport has a seven-month off-season. Every other tab in the
 * app predicts games from the same season its history ends in; here the normal
 * case is predicting September's games from February's ratings, and those
 * ratings have not yet been through the winter regression the replay applies at
 * a season boundary.
 */
export function getLatestSeason(league: LeagueId): number | null {
  const row = getDb()
    .prepare('SELECT MAX(season) AS s FROM naf_games WHERE league = ?')
    .get(league) as unknown as { s: number | null } | undefined;
  return row?.s ?? null;
}

export function getLeagueLatestDate(league: LeagueId): string | null {
  const row = getDb()
    .prepare('SELECT MAX(game_date) AS d FROM naf_games WHERE league = ?')
    .get(league) as unknown as { d: string | null } | undefined;
  return row?.d ?? null;
}

export function getTeam(league: LeagueId, id: string): NafTeamRow | null {
  return (
    (getDb()
      .prepare('SELECT id, league, name FROM naf_teams WHERE league = ? AND id = ?')
      .get(league, id) as unknown as NafTeamRow) ?? null
  );
}

export function listTeams(league: LeagueId): NafTeamRow[] {
  return getDb()
    .prepare('SELECT id, league, name FROM naf_teams WHERE league = ? ORDER BY name')
    .all(league) as unknown as NafTeamRow[];
}

/** Resolve a bookmaker's spelling of a team to an id in the database. */
export function resolveTeam(league: LeagueId, name: string): NafTeamRow | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
  const target = norm(name);
  const teams = listTeams(league);
  const exact = teams.find((t) => norm(t.name) === target);
  if (exact) return exact;
  // "Chiefs" and "Kansas City" both have to find Kansas City Chiefs.
  const partial = teams.find((t) => {
    const n = norm(t.name);
    return n.endsWith(` ${target}`) || n.startsWith(`${target} `) || n.includes(target);
  });
  return partial ?? null;
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------
const EMPTY_RATING = (league: LeagueId, id: string): NafTeamRatingRow => ({
  team_id: id,
  league,
  elo: 1500,
  games_played: 0,
  last_date: null,
  pf: null,
  pa: null,
});

export function getRating(league: LeagueId, id: string): NafTeamRatingRow {
  const row = getDb()
    .prepare(
      `SELECT team_id, league, elo, games_played, last_date, pf, pa
       FROM naf_team_ratings WHERE league = ? AND team_id = ?`,
    )
    .get(league, id) as unknown as NafTeamRatingRow | undefined;
  return row ?? EMPTY_RATING(league, id);
}

export function getEloRank(league: LeagueId, id: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM naf_team_ratings
       WHERE league = ? AND elo > (SELECT elo FROM naf_team_ratings WHERE league = ? AND team_id = ?)`,
    )
    .get(league, league, id) as unknown as { rank: number } | undefined;
  return row?.rank ?? 0;
}

export function getPowerRanking(league: LeagueId, limit = 40) {
  return getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, r.elo, r.games_played AS games, r.pf, r.pa
       FROM naf_team_ratings r
       JOIN naf_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ?
       ORDER BY r.elo DESC
       LIMIT ?`,
    )
    .all(league, limit) as unknown as {
    id: string;
    name: string;
    elo: number;
    games: number;
    pf: number | null;
    pa: number | null;
  }[];
}

/**
 * Where the league-wide trackers ended up.
 *
 * Home advantage and points per game are properties of the LEAGUE, not of any
 * team, so they live in `meta` rather than being recomputed at prediction time.
 * Storing them is what lets a prediction be made without replaying 7,000 games.
 */
export function getLeagueState(league: LeagueId): { homeAdvantage: number; leagueTotal: number } {
  const db = getDb();
  const read = (k: string, fallback: number): number => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`naf:${league}:${k}`) as
      | unknown as { value: string }
      | undefined;
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  return { homeAdvantage: read('homeAdvantage', 55), leagueTotal: read('leagueTotal', 44) };
}

function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function listReplayGames(league: LeagueId): ReplayGame[] {
  return getDb()
    .prepare(
      `SELECT season, week, game_date, home_id, away_id, home_points, away_points,
              neutral, playoff, home_rest, away_rest,
              home_qb_id, away_qb_id, home_qb_name, away_qb_name, roof, wind, temp
       FROM naf_games WHERE league = ?
       ORDER BY game_date, season, week, home_id`,
    )
    .all(league) as unknown as ReplayGame[];
}

/** Games with the closing line attached. Backtest only. */
export function listGamesWithMarket(league: LeagueId): NafGameRow[] {
  return getDb()
    .prepare(
      `SELECT id, league, season, week, game_date, home_id, away_id, home_points, away_points,
              neutral, playoff, home_rest, away_rest,
              close_spread, close_total, close_ml_home, close_ml_away,
              home_qb_id, away_qb_id, home_qb_name, away_qb_name, roof, temp, wind
       FROM naf_games WHERE league = ?
       ORDER BY game_date, season, week, home_id`,
    )
    .all(league) as unknown as NafGameRow[];
}

/**
 * Replay the archive and persist the result.
 *
 * The same `replayGames` the backtest calls, so what gets written here is what
 * gets measured there.
 */
export function rebuildRatings(league: LeagueId): { teams: number; games: number } {
  const games = listReplayGames(league);
  if (games.length === 0) return { teams: 0, games: 0 };

  const result = replayGames(games);
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM naf_team_ratings WHERE league = ?').run(league);
    const ins = db.prepare(
      `INSERT INTO naf_team_ratings (team_id, league, elo, games_played, last_date, pf, pa, current_qb)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, s] of result.teams) {
      ins.run(
        id, league, s.elo, s.games, s.lastDate, s.pointsFor, s.pointsAgainst,
        result.currentQb.get(id) ?? null,
      );
    }

    db.prepare('DELETE FROM naf_qb_ratings WHERE league = ?').run(league);
    const insQb = db.prepare(
      `INSERT INTO naf_qb_ratings (qb_id, league, name, adjustment, starts, last_season, last_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, q] of result.qbs) {
      insQb.run(id, league, q.name, q.adjustment, q.starts, q.lastSeason, q.lastDate);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  setMeta(`naf:${league}:homeAdvantage`, String(result.homeAdvantage));
  setMeta(`naf:${league}:leagueTotal`, String(result.leagueTotal));
  return { teams: result.teams.size, games: games.length };
}

/**
 * The quarterback a team is expected to start, with his Elo offset.
 *
 * "Expected" is doing real work in that sentence. nflverse names the starter for
 * games already played, never for scheduled ones, so this returns whoever started
 * the team's most recent game. It is right most weeks and wrong exactly when a
 * midweek injury or benching lands — which the app cannot know and says so rather
 * than implying the forecast accounts for it.
 */
export function getCurrentQb(
  league: LeagueId,
  teamId: string,
): { id: string; name: string | null; adjustment: number; starts: number } | null {
  const row = getDb()
    .prepare(
      `SELECT q.qb_id AS id, q.name, q.adjustment, q.starts
         FROM naf_team_ratings t
         JOIN naf_qb_ratings q ON q.league = t.league AND q.qb_id = t.current_qb
        WHERE t.league = ? AND t.team_id = ?`,
    )
    .get(league, teamId) as unknown as
    | { id: string; name: string | null; adjustment: number; starts: number }
    | undefined;
  return row ?? null;
}

/** The quarterbacks with the largest offsets, for the league panel. */
export function getQbRanking(league: LeagueId, limit = 12) {
  return getDb()
    .prepare(
      `SELECT q.qb_id AS id, q.name, q.adjustment, q.starts, q.last_season,
              (SELECT t.team_id FROM naf_team_ratings t
                WHERE t.league = q.league AND t.current_qb = q.qb_id LIMIT 1) AS team_id
         FROM naf_qb_ratings q
        WHERE q.league = ? AND q.starts >= 16
        ORDER BY q.adjustment DESC
        LIMIT ?`,
    )
    .all(league, limit) as unknown as {
    id: string;
    name: string | null;
    adjustment: number;
    starts: number;
    last_season: number | null;
    team_id: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Upcoming
// ---------------------------------------------------------------------------
export function listUpcoming(league: LeagueId, limit = 24): NafUpcomingRow[] {
  const fresh = freshFilter();
  return getDb()
    .prepare(
      `SELECT id, league, season, week, commence_time, home_name, away_name, home_id, away_id,
              neutral, odds_home, odds_away, spread_line, total_line, books, source, updated_at, roof
       FROM naf_upcoming WHERE league = ? AND ${fresh.sql}
       ORDER BY commence_time
       LIMIT ?`,
    )
    .all(league, ...fresh.params, limit) as unknown as NafUpcomingRow[];
}

export function getUpcoming(id: string): NafUpcomingRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, league, season, week, commence_time, home_name, away_name, home_id, away_id,
                neutral, odds_home, odds_away, spread_line, total_line, books, source, updated_at, roof
         FROM naf_upcoming WHERE id = ?`,
      )
      .get(id) as unknown as NafUpcomingRow) ?? null
  );
}

export function lastOddsUpdate(league: LeagueId): string | null {
  const row = getDb()
    .prepare("SELECT MAX(updated_at) AS t FROM naf_upcoming WHERE league = ? AND source = 'live'")
    .get(league) as unknown as { t: string | null } | undefined;
  return row?.t ?? null;
}

// ---------------------------------------------------------------------------
// Team detail
// ---------------------------------------------------------------------------
const EMPTY_RECORD: NafRecord = { wins: 0, losses: 0, ties: 0 };

export function getTeamInfo(league: LeagueId, id: string): NafTeamInfo | null {
  const team = getTeam(league, id);
  if (!team) return null;
  const db = getDb();
  const rating = getRating(league, id);

  // UNION ALL of two indexed halves — see the note at the top of the file.
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT game_date, season, week, away_id AS opponent, 1 AS at_home,
                home_points AS pf, away_points AS pa
         FROM naf_games WHERE league = ? AND home_id = ?
         UNION ALL
         SELECT game_date, season, week, home_id AS opponent, 0 AS at_home,
                away_points AS pf, home_points AS pa
         FROM naf_games WHERE league = ? AND away_id = ?
       ) ORDER BY game_date DESC, week DESC`,
    )
    .all(league, id, league, id) as unknown as {
    game_date: string;
    season: number;
    week: number;
    opponent: string;
    at_home: number;
    pf: number;
    pa: number;
  }[];

  const record = { ...EMPTY_RECORD };
  const homeRecord = { ...EMPTY_RECORD };
  const awayRecord = { ...EMPTY_RECORD };
  let pf = 0;
  let pa = 0;
  for (const r of rows) {
    const target = r.at_home ? homeRecord : awayRecord;
    if (r.pf > r.pa) {
      record.wins++;
      target.wins++;
    } else if (r.pf < r.pa) {
      record.losses++;
      target.losses++;
    } else {
      record.ties++;
      target.ties++;
    }
    pf += r.pf;
    pa += r.pa;
  }

  const names = new Map(listTeams(league).map((t) => [t.id, t.name]));
  const form = rows.slice(0, 10).map((r) => ({
    date: r.game_date,
    season: r.season,
    week: r.week,
    opponentId: r.opponent,
    opponentName: names.get(r.opponent) ?? null,
    home: r.at_home === 1,
    result: (r.pf > r.pa ? 'W' : r.pf < r.pa ? 'L' : 'D') as 'W' | 'L' | 'D',
    pointsFor: r.pf,
    pointsAgainst: r.pa,
  }));

  const n = rows.length;
  return {
    id,
    league,
    name: team.name,
    elo: rating.elo,
    eloRank: getEloRank(league, id),
    gamesInDb: n,
    record,
    homeRecord,
    awayRecord,
    // The EWMA the model reads, not the raw season average: it is what the
    // forecast is actually built on, so it is what the card should show.
    pf: rating.pf != null ? Number(rating.pf.toFixed(1)) : n ? Number((pf / n).toFixed(1)) : null,
    pa: rating.pa != null ? Number(rating.pa.toFixed(1)) : n ? Number((pa / n).toFixed(1)) : null,
    pythagorean: n ? pythagorean(pf, pa) : null,
    form,
  };
}

/** Head-to-head, most recent first. */
export function getHeadToHead(league: LeagueId, a: string, b: string, limit = 6) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT game_date, season, week, home_id, away_id, home_points, away_points
         FROM naf_games WHERE league = ? AND home_id = ? AND away_id = ?
         UNION ALL
         SELECT game_date, season, week, home_id, away_id, home_points, away_points
         FROM naf_games WHERE league = ? AND home_id = ? AND away_id = ?
       ) ORDER BY game_date DESC LIMIT ?`,
    )
    .all(league, a, b, league, b, a, limit) as unknown as {
    game_date: string;
    season: number;
    week: number;
    home_id: string;
    away_id: string;
    home_points: number;
    away_points: number;
  }[];

  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  const all = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT home_id, home_points, away_points FROM naf_games WHERE league = ? AND home_id = ? AND away_id = ?
         UNION ALL
         SELECT home_id, home_points, away_points FROM naf_games WHERE league = ? AND home_id = ? AND away_id = ?
       )`,
    )
    .all(league, a, b, league, b, a) as unknown as {
    home_id: string;
    home_points: number;
    away_points: number;
  }[];
  for (const r of all) {
    if (r.home_points === r.away_points) ties++;
    else {
      const winner = r.home_points > r.away_points ? r.home_id : r.home_id === a ? b : a;
      if (winner === a) aWins++;
      else bWins++;
    }
  }

  return { total: all.length, homeWins: aWins, awayWins: bWins, ties, recent: rows };
}

export type { NafTeamState };

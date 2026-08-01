// Read queries for the baseball side.
//
// Every per-team lookup is written as two indexed halves joined by UNION ALL
// rather than as `WHERE home_id = ? OR away_id = ?`. That is not style: SQLite's
// planner cannot use an index for an OR across two different columns and falls
// back to scanning the whole table, which on the tennis side turned a prediction
// into a 612 ms operation before it was fixed the same way.

import { getDb } from '../db.ts';
import { pythagorean } from './model.ts';
import type {
  BsbGameRow,
  BsbPitcherRow,
  BsbRecord,
  BsbTeamInfo,
  BsbTeamRatingRow,
  BsbTeamRow,
  BsbUpcomingRow,
  LeagueId,
} from './types.ts';

export function countTeams(league?: LeagueId): number {
  const db = getDb();
  const row = league
    ? db.prepare('SELECT COUNT(*) AS n FROM bsb_teams WHERE league = ?').get(league)
    : db.prepare('SELECT COUNT(*) AS n FROM bsb_teams').get();
  return (row as unknown as { n: number }).n ?? 0;
}

export function countGames(league?: LeagueId): number {
  const db = getDb();
  const row = league
    ? db.prepare('SELECT COUNT(*) AS n FROM bsb_games WHERE league = ?').get(league)
    : db.prepare('SELECT COUNT(*) AS n FROM bsb_games').get();
  return (row as unknown as { n: number }).n ?? 0;
}

export function getLeagueLatestDate(league: LeagueId): string | null {
  const row = getDb()
    .prepare('SELECT MAX(game_date) AS d FROM bsb_games WHERE league = ?')
    .get(league) as unknown as { d: string | null };
  return row?.d ?? null;
}

export function getTeam(league: LeagueId, id: string): BsbTeamRow | null {
  return (getDb()
    .prepare('SELECT id, league, name FROM bsb_teams WHERE league = ? AND id = ?')
    .get(league, id) as unknown as BsbTeamRow) ?? null;
}

export function listTeams(league: LeagueId): BsbTeamRow[] {
  return getDb()
    .prepare('SELECT id, league, name FROM bsb_teams WHERE league = ? ORDER BY name')
    .all(league) as unknown as BsbTeamRow[];
}

const EMPTY_RATING = (league: LeagueId, id: string): BsbTeamRatingRow => ({
  team_id: id,
  league,
  elo: 1500,
  games_played: 0,
  last_date: null,
  rs: null,
  ra: null,
});

export function getRating(league: LeagueId, id: string): BsbTeamRatingRow {
  const row = getDb()
    .prepare(
      `SELECT team_id, league, elo, games_played, last_date, rs, ra
       FROM bsb_team_ratings WHERE league = ? AND team_id = ?`,
    )
    .get(league, id) as unknown as BsbTeamRatingRow | undefined;
  return row ?? EMPTY_RATING(league, id);
}

export function getEloRank(league: LeagueId, id: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM bsb_team_ratings
       WHERE league = ? AND elo > (SELECT elo FROM bsb_team_ratings WHERE league = ? AND team_id = ?)`,
    )
    .get(league, league, id) as unknown as { rank: number } | undefined;
  return row?.rank ?? 0;
}

export function getPowerRanking(league: LeagueId, limit = 40) {
  return getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, r.elo, r.games_played AS games, r.rs, r.ra
       FROM bsb_team_ratings r
       LEFT JOIN bsb_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ? ORDER BY r.elo DESC LIMIT ?`,
    )
    .all(league, limit) as unknown as {
    id: string;
    name: string | null;
    elo: number;
    games: number;
    rs: number | null;
    ra: number | null;
  }[];
}

/** Win/loss overall and by venue, in one pass over two indexed halves. */
export function getRecords(league: LeagueId, id: string): {
  overall: BsbRecord;
  home: BsbRecord;
  away: BsbRecord;
} {
  const rows = getDb()
    .prepare(
      `SELECT 1 AS at_home, home_runs AS rf, away_runs AS ra
         FROM bsb_games WHERE league = ? AND home_id = ?
       UNION ALL
       SELECT 0 AS at_home, away_runs AS rf, home_runs AS ra
         FROM bsb_games WHERE league = ? AND away_id = ?`,
    )
    .all(league, id, league, id) as unknown as { at_home: number; rf: number; ra: number }[];

  const overall: BsbRecord = { wins: 0, losses: 0 };
  const home: BsbRecord = { wins: 0, losses: 0 };
  const away: BsbRecord = { wins: 0, losses: 0 };
  for (const r of rows) {
    if (r.rf === r.ra) continue; // the handful of suspended ties
    const won = r.rf > r.ra;
    const bucket = r.at_home ? home : away;
    if (won) {
      overall.wins++;
      bucket.wins++;
    } else {
      overall.losses++;
      bucket.losses++;
    }
  }
  return { overall, home, away };
}

export function getRecentGames(league: LeagueId, id: string, limit = 10) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT game_date AS date, away_id AS opponent, 1 AS at_home,
                home_runs AS rf, away_runs AS ra
           FROM bsb_games WHERE league = ? AND home_id = ?
         UNION ALL
         SELECT game_date AS date, home_id AS opponent, 0 AS at_home,
                away_runs AS rf, home_runs AS ra
           FROM bsb_games WHERE league = ? AND away_id = ?
       ) ORDER BY date DESC LIMIT ?`,
    )
    .all(league, id, league, id, limit) as unknown as {
    date: string;
    opponent: string;
    at_home: number;
    rf: number;
    ra: number;
  }[];
  return rows.map((r) => ({
    date: r.date,
    opponentId: r.opponent,
    home: !!r.at_home,
    result: (r.rf > r.ra ? 'W' : 'L') as 'W' | 'L',
    runsFor: r.rf,
    runsAgainst: r.ra,
  }));
}

export function getMeetings(league: LeagueId, a: string, b: string, limit = 8) {
  const rows = getDb()
    .prepare(
      `SELECT game_date AS date, home_id, away_id, home_runs, away_runs
         FROM bsb_games WHERE league = ? AND home_id = ? AND away_id = ?
       UNION ALL
       SELECT game_date AS date, home_id, away_id, home_runs, away_runs
         FROM bsb_games WHERE league = ? AND home_id = ? AND away_id = ?`,
    )
    .all(league, a, b, league, b, a) as unknown as {
    date: string;
    home_id: string;
    away_id: string;
    home_runs: number;
    away_runs: number;
  }[];
  // Sorted in JS so both halves can be served straight off their indexes.
  rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return rows.slice(0, limit).map((r) => ({
    date: r.date,
    homeId: r.home_id,
    awayId: r.away_id,
    homeRuns: r.home_runs,
    awayRuns: r.away_runs,
  }));
}

export function getPitcher(league: LeagueId, id: string): BsbPitcherRow | null {
  return (getDb()
    .prepare(
      `SELECT id, league, name, team_id, starts, outs, runs_allowed, runs_per_9, rating,
              last_date, season
       FROM bsb_pitchers WHERE league = ? AND id = ?`,
    )
    .get(league, id) as unknown as BsbPitcherRow) ?? null;
}

/** A team's rotation: its most-used starters, best first. */
export function getRotation(league: LeagueId, teamId: string, limit = 8): BsbPitcherRow[] {
  return getDb()
    .prepare(
      `SELECT id, league, name, team_id, starts, outs, runs_allowed, runs_per_9, rating,
              last_date, season
       FROM bsb_pitchers
       WHERE league = ? AND team_id = ? AND starts > 0
       ORDER BY starts DESC LIMIT ?`,
    )
    .all(league, teamId, limit) as unknown as BsbPitcherRow[];
}

/**
 * Find a pitcher by name, for matching a probables feed that gives names rather
 * than ids. Exact (case-insensitive) only: two different pitchers called Rodríguez
 * is an ordinary situation in baseball, and guessing between them would be worse
 * than admitting the starter is unknown.
 */
export function findPitcherByName(league: LeagueId, name: string): BsbPitcherRow | null {
  const rows = getDb()
    .prepare(
      `SELECT id, league, name, team_id, starts, outs, runs_allowed, runs_per_9, rating,
              last_date, season
       FROM bsb_pitchers WHERE league = ? AND LOWER(name) = LOWER(?)
       ORDER BY starts DESC`,
    )
    .all(league, name.trim()) as unknown as BsbPitcherRow[];
  return rows.length === 1 ? rows[0] : null;
}

export function getTeamInfo(league: LeagueId, id: string): BsbTeamInfo | null {
  const team = getTeam(league, id);
  if (!team) return null;
  const rating = getRating(league, id);
  const rec = getRecords(league, id);
  const names = new Map(listTeams(league).map((t) => [t.id, t.name]));
  return {
    id,
    league,
    name: team.name,
    elo: rating.elo,
    eloRank: getEloRank(league, id),
    gamesInDb: rating.games_played,
    record: rec.overall,
    homeRecord: rec.home,
    awayRecord: rec.away,
    rs: rating.rs,
    ra: rating.ra,
    pythagorean: rating.rs != null && rating.ra != null ? pythagorean(rating.rs, rating.ra) : null,
    form: getRecentGames(league, id, 10).map((g) => ({
      ...g,
      opponentName: names.get(g.opponentId) ?? null,
    })),
    rotation: getRotation(league, id).map((p) => ({
      id: p.id,
      name: p.name,
      starts: p.starts,
      runsPer9: p.runs_per_9,
      rating: p.rating,
    })),
  };
}

export function listUpcoming(league?: string): BsbUpcomingRow[] {
  const db = getDb();
  const sql = `SELECT id, league, commence_time, home_name, away_name, home_id, away_id,
                      home_sp, away_sp, odds_home, odds_away, books, source, updated_at
               FROM bsb_upcoming`;
  const rows = league
    ? db.prepare(`${sql} WHERE league = ? ORDER BY commence_time`).all(league)
    : db.prepare(`${sql} ORDER BY commence_time`).all();
  return rows as unknown as BsbUpcomingRow[];
}

export function getUpcomingById(id: string): BsbUpcomingRow | null {
  return (getDb()
    .prepare(
      `SELECT id, league, commence_time, home_name, away_name, home_id, away_id,
              home_sp, away_sp, odds_home, odds_away, books, source, updated_at
       FROM bsb_upcoming WHERE id = ?`,
    )
    .get(id) as unknown as BsbUpcomingRow) ?? null;
}

export function getLeaguesWithUpcoming(): { league: string; count: number }[] {
  return getDb()
    .prepare('SELECT league, COUNT(*) AS count FROM bsb_upcoming GROUP BY league')
    .all() as unknown as { league: string; count: number }[];
}

export function getGamesForDate(league: LeagueId, date: string): BsbGameRow[] {
  return getDb()
    .prepare(
      `SELECT id, league, season, game_date, game_number, home_id, away_id,
              home_runs, away_runs, home_sp, away_sp, site
       FROM bsb_games WHERE league = ? AND game_date = ?`,
    )
    .all(league, date) as unknown as BsbGameRow[];
}

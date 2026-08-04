// Database reads for football. Per-team lookups are two explicit indexed halves
// (home rows, away rows) rather than an OR over two columns — same reason as the
// other two sports, where that OR let SQLite pick a full scan of the league.

import { getDb } from '../db.ts';
import { freshSince } from '../freshness.ts';
import { INITIAL_ELO } from './model.ts';
import type { FbRecord, FbTeamInfo, FbTeamRatingRow, FbTeamRow, FbUpcomingRow, LeagueId } from './types.ts';

export function getTeam(league: LeagueId, id: string): FbTeamRow | null {
  return (getDb().prepare('SELECT * FROM fb_teams WHERE league = ? AND id = ?').get(league, id) as
    unknown as FbTeamRow | undefined) ?? null;
}

export function listTeams(league: LeagueId): FbTeamRow[] {
  return getDb()
    .prepare('SELECT * FROM fb_teams WHERE league = ? ORDER BY name')
    .all(league) as unknown as FbTeamRow[];
}

export function getRating(league: LeagueId, id: string): FbTeamRatingRow {
  const row = getDb()
    .prepare('SELECT * FROM fb_team_ratings WHERE league = ? AND team_id = ?')
    .get(league, id) as unknown as FbTeamRatingRow | undefined;
  return row ?? { team_id: id, league, elo: INITIAL_ELO, matches_played: 0, last_date: null, gf: null, ga: null };
}

export function getEloRank(league: LeagueId, id: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM fb_team_ratings WHERE league = ? AND elo > (
         SELECT elo FROM fb_team_ratings WHERE league = ? AND team_id = ?)`,
    )
    .get(league, league, id) as unknown as { rank: number };
  return row.rank;
}

export interface FbRecentMatch {
  date: string;
  season: number;
  opponentId: string;
  opponentName: string | null;
  home: boolean;
  result: 'W' | 'D' | 'L';
  goalsFor: number;
  goalsAgainst: number;
}

export function getRecentMatches(league: LeagueId, id: string, limit = 10): FbRecentMatch[] {
  const rows = getDb()
    .prepare(
      `SELECT date, season, opponentId, home, gf, ga FROM (
         SELECT match_date AS date, season, away_id AS opponentId, 1 AS home,
                home_goals AS gf, away_goals AS ga, id AS mid
           FROM fb_matches WHERE league = ? AND home_id = ?
         UNION ALL
         SELECT match_date AS date, season, home_id AS opponentId, 0 AS home,
                away_goals AS gf, home_goals AS ga, id AS mid
           FROM fb_matches WHERE league = ? AND away_id = ?
       ) ORDER BY date DESC, mid DESC LIMIT ?`,
    )
    .all(league, id, league, id, limit) as unknown as {
    date: string; season: number; opponentId: string; home: number; gf: number; ga: number;
  }[];
  const nameStmt = getDb().prepare('SELECT name FROM fb_teams WHERE league = ? AND id = ?');
  return rows.map((r) => ({
    date: String(r.date),
    season: r.season,
    opponentId: r.opponentId,
    opponentName:
      (nameStmt.get(league, r.opponentId) as unknown as { name: string } | undefined)?.name ?? null,
    home: !!r.home,
    result: r.gf > r.ga ? 'W' : r.gf === r.ga ? 'D' : 'L',
    goalsFor: r.gf,
    goalsAgainst: r.ga,
  }));
}

export function getRecords(
  league: LeagueId,
  id: string,
): { overall: FbRecord; home: FbRecord; away: FbRecord } {
  const r = getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM fb_matches WHERE league=? AND home_id=? AND result='H') AS hw,
        (SELECT COUNT(*) FROM fb_matches WHERE league=? AND home_id=? AND result='D') AS hd,
        (SELECT COUNT(*) FROM fb_matches WHERE league=? AND home_id=? AND result='A') AS hl,
        (SELECT COUNT(*) FROM fb_matches WHERE league=? AND away_id=? AND result='A') AS aw,
        (SELECT COUNT(*) FROM fb_matches WHERE league=? AND away_id=? AND result='D') AS ad,
        (SELECT COUNT(*) FROM fb_matches WHERE league=? AND away_id=? AND result='H') AS al`,
    )
    .get(league, id, league, id, league, id, league, id, league, id, league, id) as unknown as {
    hw: number; hd: number; hl: number; aw: number; ad: number; al: number;
  };
  return {
    overall: { wins: r.hw + r.aw, draws: r.hd + r.ad, losses: r.hl + r.al },
    home: { wins: r.hw, draws: r.hd, losses: r.hl },
    away: { wins: r.aw, draws: r.ad, losses: r.al },
  };
}

export interface FbMeeting {
  date: string;
  season: number;
  homeId: string;
  awayId: string;
  homeGoals: number;
  awayGoals: number;
}

export function getMeetings(league: LeagueId, a: string, b: string, limit = 200): FbMeeting[] {
  // Sorted in JS: an ORDER BY here makes SQLite prefer the date index (free
  // ordering, full league scan) over the far more selective team index.
  const rows = getDb()
    .prepare(
      `SELECT match_date AS date, season, home_id AS homeId, away_id AS awayId,
              home_goals AS homeGoals, away_goals AS awayGoals FROM (
         SELECT * FROM fb_matches WHERE league = ? AND home_id = ? AND away_id = ?
         UNION ALL
         SELECT * FROM fb_matches WHERE league = ? AND home_id = ? AND away_id = ?
       ) LIMIT ?`,
    )
    .all(league, a, b, league, b, a, limit) as unknown as {
    date: string; season: number; homeId: string; awayId: string; homeGoals: number; awayGoals: number;
  }[];
  return rows
    .map((r) => ({ ...r, date: String(r.date) }))
    .sort((x, y) => y.date.localeCompare(x.date));
}

export function getLeagueLatestDate(league: LeagueId): string | null {
  const row = getDb()
    .prepare('SELECT MAX(match_date) AS d FROM fb_matches WHERE league = ?')
    .get(league) as unknown as { d: string | null };
  return row.d;
}

export function getTeamInfo(league: LeagueId, id: string): FbTeamInfo | null {
  const team = getTeam(league, id);
  if (!team) return null;
  const rating = getRating(league, id);
  const rec = getRecords(league, id);
  return {
    id: team.id,
    league,
    name: team.name,
    elo: rating.elo,
    eloRank: getEloRank(league, id),
    matchesInDb: rating.matches_played,
    record: rec.overall,
    homeRecord: rec.home,
    awayRecord: rec.away,
    gf: rating.gf,
    ga: rating.ga,
    points: rec.overall.wins * 3 + rec.overall.draws,
    form: getRecentMatches(league, id, 10).map((m) => ({
      date: m.date,
      opponentId: m.opponentId,
      opponentName: m.opponentName,
      home: m.home,
      result: m.result,
      goalsFor: m.goalsFor,
      goalsAgainst: m.goalsAgainst,
    })),
  };
}

/** Teams ordered by Elo — the league's power ranking. */
export function getPowerRanking(league: LeagueId, limit = 40) {
  return getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, r.elo, r.matches_played AS matches, r.gf, r.ga
       FROM fb_team_ratings r
       JOIN fb_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ? ORDER BY r.elo DESC LIMIT ?`,
    )
    .all(league, limit) as unknown as {
    id: string; name: string; elo: number; matches: number; gf: number | null; ga: number | null;
  }[];
}

export function listUpcoming(league?: string): FbUpcomingRow[] {
  const db = getDb();
  return (
    league
      ? db
          .prepare(
            'SELECT * FROM fb_upcoming WHERE league = ? AND commence_time >= ? ORDER BY commence_time ASC, id ASC',
          )
          .all(league, freshSince())
      : db
          .prepare(
            'SELECT * FROM fb_upcoming WHERE commence_time >= ? ORDER BY commence_time ASC, id ASC',
          )
          .all(freshSince())
  ) as unknown as FbUpcomingRow[];
}

export function getUpcomingById(id: string): FbUpcomingRow | null {
  return (getDb().prepare('SELECT * FROM fb_upcoming WHERE id = ?').get(id) as unknown as
    FbUpcomingRow | undefined) ?? null;
}

export function getLeaguesWithUpcoming(): { league: string; count: number }[] {
  return getDb()
    .prepare('SELECT league, COUNT(*) AS count FROM fb_upcoming GROUP BY league')
    .all() as unknown as { league: string; count: number }[];
}

export function countMatches(league?: string): number {
  const db = getDb();
  const row = (
    league
      ? db.prepare('SELECT COUNT(*) AS c FROM fb_matches WHERE league = ?').get(league)
      : db.prepare('SELECT COUNT(*) AS c FROM fb_matches').get()
  ) as unknown as { c: number };
  return row.c;
}

export function countTeams(league?: string): number {
  const db = getDb();
  const row = (
    league
      ? db.prepare('SELECT COUNT(*) AS c FROM fb_teams WHERE league = ?').get(league)
      : db.prepare('SELECT COUNT(*) AS c FROM fb_teams').get()
  ) as unknown as { c: number };
  return row.c;
}

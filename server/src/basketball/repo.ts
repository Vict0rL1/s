// Database reads for basketball.
//
// Per-team lookups are written as two explicit indexed halves (home rows, away
// rows) rather than `(home_id = ? OR away_id = ?)`. Same lesson as the tennis
// side, where that OR let SQLite choose a full scan of the league and turned a
// 5 ms prediction into 600 ms.

import { getDb, getMeta } from '../db.ts';
import { freshFilter } from '../freshness.ts';
import { INITIAL_ELO, MARGIN_SIGMA } from './elo.ts';
import type {
  GameRow,
  LeagueId,
  TeamInfo,
  TeamRatingRow,
  TeamRecord,
  TeamRow,
  UpcomingGameRow,
} from './types.ts';

export function getTeam(league: LeagueId, id: string): TeamRow | null {
  return (getDb()
    .prepare('SELECT * FROM bb_teams WHERE league = ? AND id = ?')
    .get(league, id) as unknown as TeamRow | undefined) ?? null;
}

export function listTeams(league: LeagueId): TeamRow[] {
  return getDb()
    .prepare('SELECT * FROM bb_teams WHERE league = ? ORDER BY name')
    .all(league) as unknown as TeamRow[];
}

export function getRating(league: LeagueId, id: string): TeamRatingRow {
  const row = getDb()
    .prepare('SELECT * FROM bb_team_ratings WHERE league = ? AND team_id = ?')
    .get(league, id) as unknown as TeamRatingRow | undefined;
  return (
    row ?? {
      team_id: id,
      league,
      elo: INITIAL_ELO,
      games_played: 0,
      last_date: null,
      ppg: null,
      papg: null,
    }
  );
}

/** 1-based rank by Elo within the league (1 = best). */
export function getEloRank(league: LeagueId, id: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM bb_team_ratings
       WHERE league = ? AND elo > (
         SELECT elo FROM bb_team_ratings WHERE league = ? AND team_id = ?
       )`,
    )
    .get(league, league, id) as unknown as { rank: number };
  return row.rank;
}

/**
 * League-wide average points per game, for the total-points estimate.
 *
 * MEMOISED, because it is a league CONSTANT that was being recomputed once per
 * prediction. The query is four scans of bb_games — two branches of the UNION, each
 * with its own `MAX(season)` subquery — and none of it depends on which two teams are
 * playing.
 *
 * That was invisible while the archive stopped in 2015 at ~15k games. Adding hoopR
 * took it to 86,305, and the same query went to 224 ms: 83 % of the time spent
 * building a prediction, and 1.8 s of the 2.3 s the basketball tab took to answer
 * with eight games on the slate. A five-fold increase in data turned a harmless
 * inefficiency into the slowest thing in the app.
 *
 * The cache key includes the newest game date and the row count rather than just the
 * league, so an ingest inside a live process invalidates it instead of serving an
 * average from before the update. Both are index reads and cost nothing next to the
 * scan they replace.
 */
const avgScoreCache = new Map<string, number>();

export function getLeagueAverageScore(league: LeagueId): number {
  const db = getDb();
  const stamp = db
    .prepare('SELECT MAX(game_date) AS d, COUNT(*) AS c FROM bb_games WHERE league = ?')
    .get(league) as unknown as { d: string | null; c: number };
  const key = `${league}|${stamp.d}|${stamp.c}`;
  const hit = avgScoreCache.get(key);
  if (hit !== undefined) return hit;

  const row = db
    .prepare(
      `SELECT AVG(pts) AS avg FROM (
         SELECT home_pts AS pts FROM bb_games WHERE league = ?
           AND season >= (SELECT MAX(season) - 2 FROM bb_games WHERE league = ?)
         UNION ALL
         SELECT away_pts AS pts FROM bb_games WHERE league = ?
           AND season >= (SELECT MAX(season) - 2 FROM bb_games WHERE league = ?)
       )`,
    )
    .get(league, league, league, league) as unknown as { avg: number | null };
  const avg = row.avg ?? 100;
  // One entry per league in practice; the key only changes when the data does.
  if (avgScoreCache.size > 32) avgScoreCache.clear();
  avgScoreCache.set(key, avg);
  return avg;
}

export interface RecentGame {
  date: string;
  season: number;
  opponentId: string;
  opponentName: string | null;
  home: boolean;
  won: boolean;
  pts: number;
  oppPts: number;
  isPlayoff: boolean;
}

/** A team's most recent games, newest first. */
export function getRecentGames(league: LeagueId, id: string, limit = 10): RecentGame[] {
  const rows = getDb()
    .prepare(
      `SELECT date, season, opponentId, home, pts, oppPts, isPlayoff FROM (
         SELECT game_date AS date, season, away_id AS opponentId, 1 AS home,
                home_pts AS pts, away_pts AS oppPts, is_playoff AS isPlayoff, id AS gid
           FROM bb_games WHERE league = ? AND home_id = ?
         UNION ALL
         SELECT game_date AS date, season, home_id AS opponentId, 0 AS home,
                away_pts AS pts, home_pts AS oppPts, is_playoff AS isPlayoff, id AS gid
           FROM bb_games WHERE league = ? AND away_id = ?
       )
       ORDER BY date DESC, gid DESC
       LIMIT ?`,
    )
    .all(league, id, league, id, limit) as unknown as {
    date: string;
    season: number;
    opponentId: string;
    home: number;
    pts: number;
    oppPts: number;
    isPlayoff: number;
  }[];

  const nameStmt = getDb().prepare('SELECT name FROM bb_teams WHERE league = ? AND id = ?');
  return rows.map((r) => ({
    date: String(r.date),
    season: r.season,
    opponentId: r.opponentId,
    opponentName:
      (nameStmt.get(league, r.opponentId) as unknown as { name: string } | undefined)?.name ?? null,
    home: !!r.home,
    won: r.pts > r.oppPts,
    pts: r.pts,
    oppPts: r.oppPts,
    isPlayoff: !!r.isPlayoff,
  }));
}

/** Overall / home / away record. */
export function getRecords(
  league: LeagueId,
  id: string,
): { overall: TeamRecord; home: TeamRecord; away: TeamRecord } {
  const r = getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM bb_games WHERE league=? AND home_id=? AND home_pts>away_pts) AS hw,
        (SELECT COUNT(*) FROM bb_games WHERE league=? AND home_id=? AND home_pts<away_pts) AS hl,
        (SELECT COUNT(*) FROM bb_games WHERE league=? AND away_id=? AND away_pts>home_pts) AS aw,
        (SELECT COUNT(*) FROM bb_games WHERE league=? AND away_id=? AND away_pts<home_pts) AS al`,
    )
    .get(league, id, league, id, league, id, league, id) as unknown as {
    hw: number;
    hl: number;
    aw: number;
    al: number;
  };
  return {
    overall: { wins: r.hw + r.aw, losses: r.hl + r.al },
    home: { wins: r.hw, losses: r.hl },
    away: { wins: r.aw, losses: r.al },
  };
}

export interface Meeting {
  date: string;
  season: number;
  homeId: string;
  awayId: string;
  homePts: number;
  awayPts: number;
  isPlayoff: boolean;
}

/** Every meeting between two teams, newest first. */
export function getMeetings(league: LeagueId, a: string, b: string, limit = 400): Meeting[] {
  // Sorted in JS: with ORDER BY in the SQL, SQLite prefers the date index (free
  // ordering, full league scan) over the far more selective team index.
  const rows = getDb()
    .prepare(
      `SELECT game_date AS date, season, home_id AS homeId, away_id AS awayId,
              home_pts AS homePts, away_pts AS awayPts, is_playoff AS isPlayoff FROM (
         SELECT * FROM bb_games WHERE league = ? AND home_id = ? AND away_id = ?
         UNION ALL
         SELECT * FROM bb_games WHERE league = ? AND home_id = ? AND away_id = ?
       ) LIMIT ?`,
    )
    .all(league, a, b, league, b, a, limit) as unknown as {
    date: string;
    season: number;
    homeId: string;
    awayId: string;
    homePts: number;
    awayPts: number;
    isPlayoff: number;
  }[];
  return rows
    .map((r) => ({
      date: String(r.date),
      season: r.season,
      homeId: r.homeId,
      awayId: r.awayId,
      homePts: r.homePts,
      awayPts: r.awayPts,
      isPlayoff: !!r.isPlayoff,
    }))
    .sort((x, y) => y.date.localeCompare(x.date));
}

/** Date of a team's most recent game (for rest / back-to-back). */
export function getLastGameDate(league: LeagueId, id: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(d) AS d FROM (
         SELECT MAX(game_date) AS d FROM bb_games WHERE league = ? AND home_id = ?
         UNION ALL
         SELECT MAX(game_date) AS d FROM bb_games WHERE league = ? AND away_id = ?
       )`,
    )
    .get(league, id, league, id) as unknown as { d: string | null };
  return row.d;
}

/** Newest game date in the league — the app's notion of "now" for this data. */
export function getLeagueLatestDate(league: LeagueId): string | null {
  const row = getDb()
    .prepare('SELECT MAX(game_date) AS d FROM bb_games WHERE league = ?')
    .get(league) as unknown as { d: string | null };
  return row.d;
}

/**
 * The margin σ this league's handicap should be quoted with.
 *
 * Written by `measureMarginSigma` at recompute time from the last few seasons,
 * because the width of an NBA margin has drifted from 11.5 to 14.0 over the
 * archive and a frozen constant describes the wrong decade — see the long note on
 * MARGIN_SIGMA. Falls back to the constant when the league has too little
 * history to measure, or when ratings have not been recomputed since the meta key
 * was introduced (an empty string means "measured and rejected as noise", which
 * is the same fallback).
 */
export function getMarginSigma(league: LeagueId): number {
  const raw = getMeta(`bb_margin_sigma_${league}`);
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : MARGIN_SIGMA;
}

/** Full team dossier for the UI. */
export function getTeamInfo(league: LeagueId, id: string): TeamInfo | null {
  const team = getTeam(league, id);
  if (!team) return null;
  const rating = getRating(league, id);
  const records = getRecords(league, id);
  return {
    id: team.id,
    league,
    name: team.name,
    abbreviation: team.abbreviation,
    conference: team.conference,
    division: team.division,
    logo: team.logo,
    elo: rating.elo,
    eloRank: getEloRank(league, id),
    gamesInDb: rating.games_played,
    record: records.overall,
    homeRecord: records.home,
    awayRecord: records.away,
    ppg: rating.ppg,
    papg: rating.papg,
    form: getRecentGames(league, id, 10).map((g) => ({
      date: g.date,
      opponentId: g.opponentId,
      opponentName: g.opponentName,
      home: g.home,
      won: g.won,
      pts: g.pts,
      oppPts: g.oppPts,
    })),
  };
}

/** Teams ordered by Elo, for a league standings-style table. */
export function getPowerRanking(league: LeagueId, limit = 40) {
  return getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, t.abbreviation, r.elo, r.games_played AS games,
              r.ppg, r.papg
       FROM bb_team_ratings r
       JOIN bb_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ?
       ORDER BY r.elo DESC
       LIMIT ?`,
    )
    .all(league, limit) as unknown as {
    id: string;
    name: string;
    abbreviation: string | null;
    elo: number;
    games: number;
    ppg: number | null;
    papg: number | null;
  }[];
}

export function listUpcoming(league?: string): UpcomingGameRow[] {
  const fresh = freshFilter();
  const db = getDb();
  return (
    league
      ? db
          .prepare(
            `SELECT * FROM bb_upcoming WHERE league = ? AND ${fresh.sql} ORDER BY commence_time ASC, id ASC`,
          )
          .all(league, ...fresh.params)
      : db
          .prepare(
            `SELECT * FROM bb_upcoming WHERE ${fresh.sql} ORDER BY commence_time ASC, id ASC`,
          )
          .all(...fresh.params)
  ) as unknown as UpcomingGameRow[];
}

export function getUpcomingById(id: string): UpcomingGameRow | null {
  return (getDb()
    .prepare('SELECT * FROM bb_upcoming WHERE id = ?')
    .get(id) as unknown as UpcomingGameRow | undefined) ?? null;
}

/** Leagues that currently have upcoming games, with counts. */
export function getLeaguesWithUpcoming(): { league: string; count: number }[] {
  return getDb()
    .prepare(
      'SELECT league, COUNT(*) AS count FROM bb_upcoming GROUP BY league ORDER BY count DESC',
    )
    .all() as unknown as { league: string; count: number }[];
}

export function countGames(league?: string): number {
  const db = getDb();
  const row = (
    league
      ? db.prepare('SELECT COUNT(*) AS c FROM bb_games WHERE league = ?').get(league)
      : db.prepare('SELECT COUNT(*) AS c FROM bb_games').get()
  ) as unknown as { c: number };
  return row.c;
}

export function countTeams(league?: string): number {
  const db = getDb();
  const row = (
    league
      ? db.prepare('SELECT COUNT(*) AS c FROM bb_teams WHERE league = ?').get(league)
      : db.prepare('SELECT COUNT(*) AS c FROM bb_teams').get()
  ) as unknown as { c: number };
  return row.c;
}

export type { GameRow };

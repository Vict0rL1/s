// The final score of a fixture that has already been played.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
// The schedule used to drop a match six hours after kick-off, so a game played
// this morning was gone by mid-afternoon — exactly when you most want to look up
// how it ended. The cutoff now runs to midnight (see freshness.ts), which keeps
// the card on screen; this fills in what the card should say once the game is
// over, instead of leaving a forecast for something that already happened.
//
// ===========================================================================
// ONE MATCHER, NOT TWO
// ===========================================================================
// Pairing a scheduled fixture with the archived game is exactly the job the five
// prediction resolvers already do, and it is fiddly: the two sides come from
// different feeds, so the date can differ by a day and the team ids have to be
// franchise-folded first. Writing a second matcher here would mean the card and
// the track record could disagree about whether the same game had finished.
//
// So this mirrors the resolvers' rule — league + home + away, nearest date inside
// a ±1 day window — and nothing else. If that rule ever changes it changes in both
// places, and the audit compares them.
//
// WHAT THIS CANNOT DO: invent a result. Scores arrive with `update-data`, so a
// game finished ten minutes ago is not in the archive yet. The card says
// "jugado · sin resultado todavía" rather than implying the model was wrong or
// that the match never happened.

import { getDb } from './db.ts';

/** A finished game's score, from the point of view of the fixture's home side. */
export interface GameResult {
  homeScore: number;
  awayScore: number;
  /** Local YYYYMMDD of the archived game, for the "is this really it" check. */
  playedOn: string;
}

export interface ResultQuery {
  league: string;
  homeId: string | null;
  awayId: string | null;
  /** The fixture's kick-off, ISO. */
  commenceTime: string | null;
}

/** ISO instant → YYYYMMDD in LOCAL time, matching how the archives store dates. */
function ymdOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * A day either side.
 *
 * Not generosity — necessity. A 21:00 kick-off in Los Angeles is the next day in
 * UTC, and the two feeds do not agree on which day that is. One day of slack
 * absorbs it; more than one would start matching a different fixture of the same
 * pairing in a double-header.
 */
const WINDOW_DAYS = 1;

/** Team-sport table shapes, so one query serves four sports. */
const TABLES: Record<string, { table: string; dateCol: string; home: string; away: string }> = {
  football: { table: 'fb_matches', dateCol: 'match_date', home: 'home_goals', away: 'away_goals' },
  basketball: { table: 'bb_games', dateCol: 'game_date', home: 'home_pts', away: 'away_pts' },
  baseball: { table: 'bsb_games', dateCol: 'game_date', home: 'home_runs', away: 'away_runs' },
  nfl: { table: 'naf_games', dateCol: 'game_date', home: 'home_points', away: 'away_points' },
};

export function findGameResult(sport: string, q: ResultQuery): GameResult | null {
  const t = TABLES[sport];
  if (!t || !q.homeId || !q.awayId) return null;
  const target = ymdOf(q.commenceTime);
  if (!target) return null;

  const row = getDb()
    .prepare(
      `SELECT ${t.home} AS h, ${t.away} AS a, ${t.dateCol} AS d
         FROM ${t.table}
        WHERE league = ? AND home_id = ? AND away_id = ?
          AND ${t.dateCol} >= ? AND ${t.dateCol} <= ?
          AND ${t.home} IS NOT NULL AND ${t.away} IS NOT NULL
        ORDER BY ABS(CAST(${t.dateCol} AS INTEGER) - CAST(? AS INTEGER)) ASC
        LIMIT 1`,
    )
    .get(
      q.league,
      q.homeId,
      q.awayId,
      shiftYmd(target, -WINDOW_DAYS),
      shiftYmd(target, WINDOW_DAYS),
      target,
    ) as unknown as { h: number; a: number; d: string } | undefined;

  return row ? { homeScore: row.h, awayScore: row.a, playedOn: row.d } : null;
}

/**
 * Tennis, which does not have a home side.
 *
 * The archive records a WINNER and a LOSER rather than two slots, so the answer
 * is an id, not a pair of scores. Either ordering has to be tried: the fixture
 * says "p1 vs p2" and the archive says whoever won.
 */
export interface TennisResult {
  winnerId: number;
  /** The set score as the archive recorded it, when it has one. */
  score: string | null;
  playedOn: string;
}

export function findTennisResult(
  tour: string,
  p1Id: number | null,
  p2Id: number | null,
  commenceTime: string | null,
): TennisResult | null {
  if (p1Id == null || p2Id == null) return null;
  const target = ymdOf(commenceTime);
  if (!target) return null;

  const row = getDb()
    .prepare(
      `SELECT winner_id AS w, score AS s, tourney_date AS d
         FROM matches
        WHERE tour = ?
          AND ((winner_id = ? AND loser_id = ?) OR (winner_id = ? AND loser_id = ?))
          AND tourney_date >= ? AND tourney_date <= ?
        ORDER BY ABS(CAST(tourney_date AS INTEGER) - CAST(? AS INTEGER)) ASC
        LIMIT 1`,
    )
    .get(
      tour,
      p1Id,
      p2Id,
      p2Id,
      p1Id,
      shiftYmd(target, -WINDOW_DAYS),
      shiftYmd(target, WINDOW_DAYS),
      target,
    ) as unknown as { w: number; s: string | null; d: string } | undefined;

  return row ? { winnerId: row.w, score: row.s, playedOn: row.d } : null;
}

/**
 * Has this fixture's start time passed?
 *
 * Separate from "do we have a result", because the two differ for a couple of
 * hours every time and the card needs to say which state it is in: a match that
 * has started but has no score yet is being played, not missing.
 */
export function hasStarted(commenceTime: string | null, now = Date.now()): boolean {
  if (!commenceTime) return false;
  const t = new Date(commenceTime).getTime();
  return Number.isFinite(t) && t <= now;
}

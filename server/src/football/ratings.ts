// Replay matches chronologically to produce team ratings.
//
// ONE replay, shared by the app and the backtest — the same arrangement used on
// the basketball side, and for the same reason: a backtest that keeps its own
// copy of the update rules drifts from the shipped model, and then its reported
// accuracy describes something nobody is running.

import { getDb } from '../db.ts';
import {
  carryOver,
  eloExpectation,
  goalDifferenceMultiplier,
  HOME_ADVANTAGE,
  INITIAL_ELO,
  K_FACTOR,
  SEASON_CARRYOVER,
} from './model.ts';
import type { LeagueId } from './types.ts';

export interface ReplayMatch {
  season: number;
  match_date: string; // YYYYMMDD
  home_id: string;
  away_id: string;
  home_goals: number;
  away_goals: number;
  result: string; // H | D | A
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
}

export interface FbTeamState {
  elo: number;
  matches: number;
  lastDate: string | null;
  wins: number;
  draws: number;
  losses: number;
  homeWins: number;
  homeDraws: number;
  homeLosses: number;
  awayWins: number;
  awayDraws: number;
  awayLosses: number;
  goalsFor: number;
  goalsAgainst: number;
  /** Matches counted toward the scoring averages (recent window only). */
  scoringMatches: number;
}

export interface ReplayOptions {
  homeAdvantage?: number;
  k?: number;
  carryover?: number;
  /** Weight on the goal-difference multiplier (0 = win/draw/loss only). */
  goalWeight?: number;
  /** Seasons counted toward goal averages; 0 = all. */
  scoringFromSeason?: number;
  /** Called BEFORE ratings update, with the pre-match state. */
  onMatch?: (info: {
    match: ReplayMatch;
    home: FbTeamState;
    away: FbTeamState;
  }) => void;
}

function fresh(): FbTeamState {
  return {
    elo: INITIAL_ELO,
    matches: 0,
    lastDate: null,
    wins: 0,
    draws: 0,
    losses: 0,
    homeWins: 0,
    homeDraws: 0,
    homeLosses: 0,
    awayWins: 0,
    awayDraws: 0,
    awayLosses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    scoringMatches: 0,
  };
}

/**
 * Replay every match in order. Matches MUST already be sorted chronologically.
 *
 * The Elo update treats a draw as a half-result (S = 0.5), which is the standard
 * handling and the reason ratings stay meaningful in a sport where a quarter of
 * matches have no winner.
 */
export function replayMatches(
  matches: ReplayMatch[],
  opts: ReplayOptions = {},
): Map<string, FbTeamState> {
  const homeAdv = opts.homeAdvantage ?? HOME_ADVANTAGE;
  const k = opts.k ?? K_FACTOR;
  const carry = opts.carryover ?? SEASON_CARRYOVER;
  const goalWeight = opts.goalWeight ?? 1;
  const scoringFrom = opts.scoringFromSeason ?? 0;

  const states = new Map<string, FbTeamState>();
  const get = (id: string): FbTeamState => {
    let s = states.get(id);
    if (!s) {
      s = fresh();
      states.set(id, s);
    }
    return s;
  };

  let season = matches[0]?.season ?? 0;

  for (const m of matches) {
    if (m.season !== season) {
      for (const s of states.values()) s.elo = carryOver(s.elo, carry);
      season = m.season;
    }

    const home = get(m.home_id);
    const away = get(m.away_id);

    opts.onMatch?.({ match: m, home, away });

    // --- update ---
    const expected = eloExpectation(home.elo, away.elo, homeAdv);
    const actual = m.home_goals > m.away_goals ? 1 : m.home_goals === m.away_goals ? 0.5 : 0;
    const mult = goalDifferenceMultiplier(m.home_goals - m.away_goals, goalWeight);
    const shift = k * mult * (actual - expected);
    home.elo += shift;
    away.elo -= shift;

    home.matches++;
    away.matches++;
    home.lastDate = m.match_date;
    away.lastDate = m.match_date;

    if (m.home_goals > m.away_goals) {
      home.wins++;
      home.homeWins++;
      away.losses++;
      away.awayLosses++;
    } else if (m.home_goals === m.away_goals) {
      home.draws++;
      home.homeDraws++;
      away.draws++;
      away.awayDraws++;
    } else {
      home.losses++;
      home.homeLosses++;
      away.wins++;
      away.awayWins++;
    }

    if (m.season >= scoringFrom) {
      home.goalsFor += m.home_goals;
      home.goalsAgainst += m.away_goals;
      away.goalsFor += m.away_goals;
      away.goalsAgainst += m.home_goals;
      home.scoringMatches++;
      away.scoringMatches++;
    }
  }

  return states;
}

/** Load every match of a league, chronologically. */
export function loadMatches(league: LeagueId, fromSeason = 0): ReplayMatch[] {
  return getDb()
    .prepare(
      `SELECT season, match_date, home_id, away_id, home_goals, away_goals, result,
              odds_home, odds_draw, odds_away
       FROM fb_matches WHERE league = ? AND season >= ?
       ORDER BY match_date ASC, id ASC`,
    )
    .all(league, fromSeason) as unknown as ReplayMatch[];
}

/** Average goals per match in a league's recent seasons — the model's anchor. */
export function getLeagueGoalsPerMatch(league: LeagueId): number {
  const row = getDb()
    .prepare(
      `SELECT AVG(home_goals + away_goals) AS avg FROM fb_matches
       WHERE league = ?
         AND season >= (SELECT MAX(season) - 2 FROM fb_matches WHERE league = ?)`,
    )
    .get(league, league) as unknown as { avg: number | null };
  // 2.7 is the long-run average across the major European leagues; used only
  // when a league has no matches at all yet.
  return row.avg ?? 2.7;
}

/** Recompute and persist ratings for every league that has matches. */
export function recomputeFootballRatings(): Record<string, number> {
  const db = getDb();
  const leagues = (
    db.prepare('SELECT DISTINCT league AS l FROM fb_matches').all() as unknown as { l: string }[]
  ).map((r) => r.l);

  const insert = db.prepare(
    `INSERT INTO fb_team_ratings (team_id, league, elo, matches_played, last_date, gf, ga)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, team_id) DO UPDATE SET
       elo = excluded.elo, matches_played = excluded.matches_played,
       last_date = excluded.last_date, gf = excluded.gf, ga = excluded.ga`,
  );

  const out: Record<string, number> = {};
  for (const league of leagues) {
    const matches = loadMatches(league);
    if (matches.length === 0) continue;
    const latest = matches[matches.length - 1].season;
    // Goal averages from the last two seasons: a club's scoring rate changes with
    // its squad, and a 2005 average says nothing about this weekend.
    const states = replayMatches(matches, { scoringFromSeason: latest - 1 });

    db.exec('BEGIN');
    try {
      for (const [id, s] of states) {
        insert.run(
          id,
          league,
          round1(s.elo),
          s.matches,
          s.lastDate,
          s.scoringMatches > 0 ? round2(s.goalsFor / s.scoringMatches) : null,
          s.scoringMatches > 0 ? round2(s.goalsAgainst / s.scoringMatches) : null,
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    out[league] = states.size;
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

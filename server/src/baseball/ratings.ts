// Replay games chronologically to produce team ratings AND pitcher ratings.
//
// One replay, shared by the app and the backtest — the same arrangement as the
// other three sports, and for the same reason: a backtest with its own copy of
// the update rules drifts, and then the accuracy it reports describes a model
// nobody is running. The callback hands over the pre-game state and the expected
// runs the model itself computed, so the backtest scores the shipped arithmetic
// rather than a reimplementation of it.

import { getDb } from '../db.ts';
import {
  carryOver,
  eloExpectation,
  expectedRuns,
  pitcherRating,
  runDifferentialMultiplier,
  HOME_ADVANTAGE,
  HOME_RUN_SHARE,
  INITIAL_ELO,
  K_FACTOR,
  PITCHER_REGRESSION_STARTS,
  PITCHER_WEIGHT,
  RUN_DIFF_WEIGHT,
  RUN_SENSITIVITY,
  SEASON_CARRYOVER,
} from './model.ts';
import type { LeagueId } from './types.ts';

export interface ReplayGame {
  season: number;
  game_date: string; // YYYYMMDD
  game_number: number;
  home_id: string;
  away_id: string;
  home_runs: number;
  away_runs: number;
  home_sp: string | null;
  away_sp: string | null;
}

export interface BsbTeamState {
  elo: number;
  games: number;
  lastDate: string | null;
  wins: number;
  losses: number;
  homeWins: number;
  homeLosses: number;
  awayWins: number;
  awayLosses: number;
  runsFor: number;
  runsAgainst: number;
  scoringGames: number;
}

/**
 * A pitcher's running record.
 *
 * Runs allowed per START, not per nine innings. Innings pitched are not available
 * without simulating every out of every event file, and manufacturing an RA9 from
 * an assumed workload is worse than not having one: the first version of this
 * model did exactly that and pinned every pitcher at its clamp, sending the
 * predicted run total 2.25 runs a game too high.
 */
export interface PitcherState {
  starts: number;
  runsAllowed: number;
  /** Running total of (runs allowed) ÷ (runs an average starter was expected to
   * allow in that matchup). Opponent-adjusted by construction. */
  sumRatio: number;
  lastDate: string | null;
  teamId: string | null;
}

/**
 * How much of a starter's record survives the winter, in ratio space.
 *
 * Higher than the team carryover (0.7), because a pitcher IS one arm: the thing
 * being rated does not turn over a quarter of itself in the off-season the way a
 * roster does. Fitted; see docs/BASEBALL.md.
 */
export const PITCHER_CARRYOVER = 0.85;

export interface ReplayOptions {
  homeAdvantage?: number;
  k?: number;
  carryover?: number;
  runDiffWeight?: number;
  runsAnchor?: number;
  runSensitivity?: number;
  homeRunShare?: number;
  /** 0 turns the starting-pitcher layer off entirely. */
  pitcherWeight?: number;
  pitcherRegressionStarts?: number;
  pitcherCarryover?: number;
  /** Seasons counted toward the run averages; 0 = all. */
  scoringFromSeason?: number;
  /** How fast the league runs-per-game anchor follows the league. 0 freezes it. */
  anchorAlpha?: number;
  onGame?: (info: {
    game: ReplayGame;
    home: BsbTeamState;
    away: BsbTeamState;
    lambda: { home: number; away: number; baseHome: number; baseAway: number };
    pitchers: { home: number | null; away: number | null };
    anchor: number;
  }) => void;
}

/**
 * How fast the league runs-per-game anchor tracks the league.
 *
 * Baseball's scoring environment moves a LOT more than football's — the same
 * league went from 4.8 runs a game in 2000 to 4.07 in 2014 and back to 4.6 — and
 * it moves for reasons (the ball, the strike zone, the rules) that no team rating
 * can see. 1/2430 is one season of memory.
 */
export const ANCHOR_ALPHA = 1 / 2430;

function freshTeam(): BsbTeamState {
  return {
    elo: INITIAL_ELO,
    games: 0,
    lastDate: null,
    wins: 0,
    losses: 0,
    homeWins: 0,
    homeLosses: 0,
    awayWins: 0,
    awayLosses: 0,
    runsFor: 0,
    runsAgainst: 0,
    scoringGames: 0,
  };
}

function freshPitcher(): PitcherState {
  return { starts: 0, runsAllowed: 0, sumRatio: 0, lastDate: null, teamId: null };
}

export interface ReplayResult {
  teams: Map<string, BsbTeamState>;
  pitchers: Map<string, PitcherState>;
}

export function replayGames(games: ReplayGame[], opts: ReplayOptions = {}): ReplayResult {
  const homeAdv = opts.homeAdvantage ?? HOME_ADVANTAGE;
  const k = opts.k ?? K_FACTOR;
  const carry = opts.carryover ?? SEASON_CARRYOVER;
  const runDiffWeight = opts.runDiffWeight ?? RUN_DIFF_WEIGHT;
  const sens = opts.runSensitivity ?? RUN_SENSITIVITY;
  const share = opts.homeRunShare ?? HOME_RUN_SHARE;
  const pitcherWeight = opts.pitcherWeight ?? PITCHER_WEIGHT;
  const regression = opts.pitcherRegressionStarts ?? PITCHER_REGRESSION_STARTS;
  const pitcherCarry = opts.pitcherCarryover ?? PITCHER_CARRYOVER;
  const scoringFrom = opts.scoringFromSeason ?? 0;
  const anchorAlpha = opts.anchorAlpha ?? ANCHOR_ALPHA;
  let anchor = opts.runsAnchor ?? firstSeasonRunAverage(games);

  const teams = new Map<string, BsbTeamState>();
  const pitchers = new Map<string, PitcherState>();
  const team = (id: string) => {
    let s = teams.get(id);
    if (!s) teams.set(id, (s = freshTeam()));
    return s;
  };
  const pitcher = (id: string) => {
    let s = pitchers.get(id);
    if (!s) pitchers.set(id, (s = freshPitcher()));
    return s;
  };
  /** The rating a starter carries INTO a game — never including that game. */
  const ratingOf = (id: string | null): number | null => {
    if (!id) return null;
    const s = pitchers.get(id);
    if (!s || s.starts === 0) return null;
    return pitcherRating(s.sumRatio, s.starts, regression);
  };

  let season = games[0]?.season ?? 0;

  for (const g of games) {
    if (g.season !== season) {
      for (const s of teams.values()) s.elo = carryOver(s.elo, carry);
      // Pitcher records are regressed rather than reset: a starter's ability
      // carries across a winter far better than a team's does, because it is one
      // arm and not a roster that just turned over a quarter of itself.
      for (const p of pitchers.values()) {
        if (p.starts === 0) continue;
        const mean = p.sumRatio / p.starts;
        p.sumRatio = (1 + (mean - 1) * pitcherCarry) * p.starts;
      }
      season = g.season;
    }

    const home = team(g.home_id);
    const away = team(g.away_id);
    const homeSpRating = ratingOf(g.home_sp);
    const awaySpRating = ratingOf(g.away_sp);

    const lambda = expectedRuns(home.elo, away.elo, anchor, {
      homeAdvantage: homeAdv,
      runSensitivity: sens,
      homeRunShare: share,
      homePitcher: homeSpRating,
      awayPitcher: awaySpRating,
      pitcherWeight,
    });

    opts.onGame?.({
      game: g,
      home,
      away,
      lambda,
      pitchers: { home: homeSpRating, away: awaySpRating },
      anchor,
    });

    // --- update ---
    const expected = eloExpectation(home.elo, away.elo, homeAdv);
    const actual = g.home_runs > g.away_runs ? 1 : g.home_runs === g.away_runs ? 0.5 : 0;
    const mult = runDifferentialMultiplier(g.home_runs - g.away_runs, runDiffWeight);
    const shift = k * mult * (actual - expected);
    home.elo += shift;
    away.elo -= shift;

    home.games++;
    away.games++;
    home.lastDate = g.game_date;
    away.lastDate = g.game_date;
    if (g.home_runs > g.away_runs) {
      home.wins++;
      home.homeWins++;
      away.losses++;
      away.awayLosses++;
    } else if (g.home_runs < g.away_runs) {
      home.losses++;
      home.homeLosses++;
      away.wins++;
      away.awayWins++;
    }

    if (g.season >= scoringFrom) {
      home.runsFor += g.home_runs;
      home.runsAgainst += g.away_runs;
      away.runsFor += g.away_runs;
      away.runsAgainst += g.home_runs;
      home.scoringGames++;
      away.scoringGames++;
    }

    // A starter is charged the runs his TEAM allowed, relative to what an average
    // starter was expected to allow in this exact matchup. The bullpen's share is
    // still in there and PITCHER_WEIGHT is fitted against that same definition,
    // so the contamination is absorbed rather than left to distort the number.
    if (g.home_sp) {
      const p = pitcher(g.home_sp);
      p.starts++;
      p.runsAllowed += g.away_runs;
      p.sumRatio += g.away_runs / lambda.baseAway;
      p.lastDate = g.game_date;
      p.teamId = g.home_id;
    }
    if (g.away_sp) {
      const p = pitcher(g.away_sp);
      p.starts++;
      p.runsAllowed += g.home_runs;
      p.sumRatio += g.home_runs / lambda.baseHome;
      p.lastDate = g.game_date;
      p.teamId = g.away_id;
    }

    if (anchorAlpha > 0) {
      anchor = anchor * (1 - anchorAlpha) + anchorAlpha * (g.home_runs + g.away_runs);
    }
  }

  return { teams, pitchers };
}

export function firstSeasonRunAverage(games: ReplayGame[]): number {
  if (games.length === 0) return 9.0;
  const first = games[0].season;
  let n = 0;
  let runs = 0;
  for (const g of games) {
    if (g.season !== first) break;
    runs += g.home_runs + g.away_runs;
    n++;
  }
  return n > 0 ? runs / n : 9.0;
}

export function loadGames(league: LeagueId, fromSeason = 0): ReplayGame[] {
  return getDb()
    .prepare(
      `SELECT season, game_date, game_number, home_id, away_id, home_runs, away_runs,
              home_sp, away_sp
       FROM bsb_games WHERE league = ? AND season >= ?
       ORDER BY game_date ASC, game_number ASC, id ASC`,
    )
    .all(league, fromSeason) as unknown as ReplayGame[];
}

/** Combined runs per game in a league's recent seasons — the model's anchor. */
export function getLeagueRunsPerGame(league: LeagueId): number {
  const row = getDb()
    .prepare(
      `SELECT AVG(home_runs + away_runs) AS avg FROM bsb_games
       WHERE league = ?
         AND season >= (SELECT MAX(season) - 1 FROM bsb_games WHERE league = ?)`,
    )
    .get(league, league) as unknown as { avg: number | null };
  return row.avg ?? 9.0;
}

/** Recompute and persist ratings for every league that has games. */
export function recomputeBaseballRatings(): Record<string, number> {
  const db = getDb();
  const leagues = (
    db.prepare('SELECT DISTINCT league AS l FROM bsb_games').all() as unknown as { l: string }[]
  ).map((r) => r.l);

  const insertTeam = db.prepare(
    `INSERT INTO bsb_team_ratings (team_id, league, elo, games_played, last_date, rs, ra)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, team_id) DO UPDATE SET
       elo = excluded.elo, games_played = excluded.games_played,
       last_date = excluded.last_date, rs = excluded.rs, ra = excluded.ra`,
  );
  const insertPitcher = db.prepare(
    `INSERT INTO bsb_pitchers
       (id, league, name, team_id, starts, outs, runs_allowed, runs_per_9, rating, last_date, season)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET
       team_id = excluded.team_id, starts = excluded.starts, outs = excluded.outs,
       runs_allowed = excluded.runs_allowed, runs_per_9 = excluded.runs_per_9,
       rating = excluded.rating, last_date = excluded.last_date, season = excluded.season`,
  );
  const nameOf = db.prepare('SELECT name FROM bsb_pitchers WHERE league = ? AND id = ?');

  const out: Record<string, number> = {};
  for (const league of leagues) {
    const games = loadGames(league);
    if (games.length === 0) continue;
    const latest = games[games.length - 1].season;
    // Run averages from the last two seasons only: a 2016 offence says little
    // about this one, and the scoring environment itself has moved since.
    const { teams, pitchers } = replayGames(games, { scoringFromSeason: latest - 1 });

    db.exec('BEGIN');
    try {
      for (const [id, s] of teams) {
        insertTeam.run(
          id,
          league,
          round1(s.elo),
          s.games,
          s.lastDate,
          s.scoringGames > 0 ? round2(s.runsFor / s.scoringGames) : null,
          s.scoringGames > 0 ? round2(s.runsAgainst / s.scoringGames) : null,
        );
      }
      for (const [id, p] of pitchers) {
        const known = nameOf.get(league, id) as unknown as { name: string } | undefined;
        insertPitcher.run(
          id,
          league,
          known?.name ?? id,
          p.teamId,
          p.starts,
          0,
          p.runsAllowed,
          p.starts > 0 ? round2(p.runsAllowed / p.starts) : null,
          round3(pitcherRating(p.sumRatio, p.starts) ?? 1),
          p.lastDate,
          latest,
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    out[league] = teams.size;
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

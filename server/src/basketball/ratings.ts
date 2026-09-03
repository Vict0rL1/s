// Replay games chronologically to produce team ratings.
//
// ONE replay, used by both the app and the backtest. The tennis side learned this
// the hard way: when a backtest keeps its own copy of the update rules, the two
// drift and the reported accuracy stops describing the shipped model. Here the
// loop lives in `replayGames` and the backtest is just a consumer that hooks the
// per-game callback, so a change to the update rules is measured by construction.

import { getDb, setMeta } from '../db.ts';
import {
  calibratedHomeWinProbability,
  carryOver,
  expectedMargin,
  homeWinProbability,
  movMultiplier,
  restAdjustment,
  CALIBRATION_SCALE,
  ELO_PER_POINT,
  HOME_ADVANTAGE,
  INITIAL_ELO,
  K_FACTOR,
  SEASON_CARRYOVER,
  SIGMA_MIN_GAMES,
  SIGMA_SEASONS,
} from './elo.ts';
import type { LeagueId } from './types.ts';

export interface ReplayGame {
  season: number;
  game_date: string; // YYYYMMDD
  home_id: string;
  away_id: string;
  home_pts: number;
  away_pts: number;
  neutral: number;
  is_playoff: number;
}

export interface TeamState {
  elo: number;
  games: number;
  lastDate: string | null;
  wins: number;
  losses: number;
  homeWins: number;
  homeLosses: number;
  awayWins: number;
  awayLosses: number;
  ptsFor: number;
  ptsAgainst: number;
  /** Games counted toward ppg/papg — only the recent window (see WINDOW). */
  scoringGames: number;
}

export interface ReplayOptions {
  homeAdvantage?: number;
  movWeight?: number;
  restWeight?: number;
  carryover?: number;
  k?: number;
  calibrationScale?: number;
  eloPerPoint?: number;
  /**
   * Seasons counted toward scoring averages. Basketball scoring levels shift
   * (rule changes, three-point volume), so a 1946 blowout should not drag a
   * team's expected total today. 0 = all seasons.
   */
  scoringFromSeason?: number;
  /** Called BEFORE the ratings are updated, with the pre-game prediction. */
  onGame?: (info: {
    game: ReplayGame;
    home: TeamState;
    away: TeamState;
    /** Ratings including the rest adjustment, as used for the prediction. */
    homeAdj: number;
    awayAdj: number;
    restHome: number;
    restAway: number;
    /** Calibrated probability the HOME team wins. */
    probHome: number;
    /** Expected home margin in points. */
    predictedMargin: number;
  }) => void;
}

const ymd = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

/** Whole days between two YYYYMMDD dates (null when there is no previous game). */
export function daysBetween(from: string | null, to: string): number | null {
  return from ? Math.max(0, Math.round((ymd(to) - ymd(from)) / 86_400_000)) : null;
}

function freshState(): TeamState {
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
    ptsFor: 0,
    ptsAgainst: 0,
    scoringGames: 0,
  };
}

/**
 * Replay every game in order and return the final state per team.
 * Games MUST already be sorted chronologically.
 */
export function replayGames(
  games: ReplayGame[],
  opts: ReplayOptions = {},
): Map<string, TeamState> {
  const homeAdv = opts.homeAdvantage ?? HOME_ADVANTAGE;
  const movWeight = opts.movWeight ?? 1;
  const restWeight = opts.restWeight ?? 1;
  const carry = opts.carryover ?? SEASON_CARRYOVER;
  const k = opts.k ?? K_FACTOR;
  const scale = opts.calibrationScale ?? CALIBRATION_SCALE;
  const eloPerPoint = opts.eloPerPoint ?? ELO_PER_POINT;
  const scoringFrom = opts.scoringFromSeason ?? 0;

  const states = new Map<string, TeamState>();
  const get = (id: string): TeamState => {
    let s = states.get(id);
    if (!s) {
      s = freshState();
      states.set(id, s);
    }
    return s;
  };

  let season = games[0]?.season ?? 0;

  for (const g of games) {
    // New season: rosters changed, so pull every rating toward the league mean.
    if (g.season !== season) {
      for (const s of states.values()) s.elo = carryOver(s.elo, carry);
      season = g.season;
    }

    const home = get(g.home_id);
    const away = get(g.away_id);
    const neutral = !!g.neutral;

    const restHome = restAdjustment(daysBetween(home.lastDate, g.game_date), restWeight);
    const restAway = restAdjustment(daysBetween(away.lastDate, g.game_date), restWeight);
    const homeAdj = home.elo + restHome;
    const awayAdj = away.elo + restAway;

    if (opts.onGame) {
      opts.onGame({
        game: g,
        home,
        away,
        homeAdj,
        awayAdj,
        restHome,
        restAway,
        probHome: calibratedHomeWinProbability(homeAdj, awayAdj, {
          neutral,
          homeAdvantage: homeAdv,
          scale,
        }),
        predictedMargin: expectedMargin(homeAdj, awayAdj, {
          neutral,
          homeAdvantage: homeAdv,
          eloPerPoint,
        }),
      });
    }

    // --- update ---
    // The rating update uses the RAW curve on purpose: calibration is a
    // presentation step for probabilities, not part of the Elo system.
    const expHome = homeWinProbability(homeAdj, awayAdj, { neutral, homeAdvantage: homeAdv });
    const homeWon = g.home_pts > g.away_pts;
    const margin = Math.abs(g.home_pts - g.away_pts);
    const effHome = homeAdj + (neutral ? 0 : homeAdv);
    // Damping uses the gap from the WINNER's point of view (see elo.ts).
    const eloDiffWinner = homeWon ? effHome - awayAdj : awayAdj - effHome;
    const shift = k * movMultiplier(margin, eloDiffWinner, movWeight) * ((homeWon ? 1 : 0) - expHome);
    home.elo += shift;
    away.elo -= shift;

    home.games++;
    away.games++;
    home.lastDate = g.game_date;
    away.lastDate = g.game_date;
    if (homeWon) {
      home.wins++;
      home.homeWins++;
      away.losses++;
      away.awayLosses++;
    } else {
      home.losses++;
      home.homeLosses++;
      away.wins++;
      away.awayWins++;
    }
    if (g.season >= scoringFrom) {
      home.ptsFor += g.home_pts;
      home.ptsAgainst += g.away_pts;
      away.ptsFor += g.away_pts;
      away.ptsAgainst += g.home_pts;
      home.scoringGames++;
      away.scoringGames++;
    }
  }

  return states;
}

/** Load every game of a league, chronologically. */
export function loadGames(league: LeagueId, fromSeason = 0): ReplayGame[] {
  return getDb()
    .prepare(
      `SELECT season, game_date, home_id, away_id, home_pts, away_pts, neutral, is_playoff
       FROM bb_games WHERE league = ? AND season >= ?
       ORDER BY game_date ASC, id ASC`,
    )
    .all(league, fromSeason) as unknown as ReplayGame[];
}

/**
 * Recompute and persist ratings for every league that has games.
 * Scoring averages use only recent seasons — see ReplayOptions.scoringFromSeason.
 */
export function recomputeBasketballRatings(): Record<string, number> {
  const db = getDb();
  const leagues = (
    db.prepare('SELECT DISTINCT league AS l FROM bb_games').all() as unknown as { l: string }[]
  ).map((r) => r.l);

  const insert = db.prepare(
    `INSERT INTO bb_team_ratings (team_id, league, elo, games_played, last_date, ppg, papg)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, team_id) DO UPDATE SET
       elo = excluded.elo, games_played = excluded.games_played,
       last_date = excluded.last_date, ppg = excluded.ppg, papg = excluded.papg`,
  );

  const out: Record<string, number> = {};
  for (const league of leagues) {
    const games = loadGames(league);
    if (games.length === 0) continue;
    // Scoring averages from the last 3 seasons present in the data.
    const latest = games[games.length - 1].season;
    const states = replayGames(games, { scoringFromSeason: latest - 2 });

    db.exec('BEGIN');
    try {
      for (const [id, s] of states) {
        insert.run(
          id,
          league,
          round1(s.elo),
          s.games,
          s.lastDate,
          s.scoringGames > 0 ? round1(s.ptsFor / s.scoringGames) : null,
          s.scoringGames > 0 ? round1(s.ptsAgainst / s.scoringGames) : null,
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // Measured alongside the ratings, from the same model's own errors — see
    // measureMarginSigma. Stored rather than computed per request, because it needs a
    // full replay of 86k games.
    const sigma = measureMarginSigma(league as LeagueId);
    setMeta(`bb_margin_sigma_${league}`, sigma == null ? '' : String(sigma));
    out[league] = states.size;
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Measure the margin residual's spread from RECENT seasons, per league.
 *
 * Why measured and not a constant: see the long note on MARGIN_SIGMA. The short
 * version is that the figure has drifted from 11.5 to 14.0 as the NBA got faster,
 * so a constant describes whichever era it was written in.
 *
 * Recent seasons only, and that is the whole point — averaging over 1950 tells you
 * nothing about 2026. Under SIGMA_MIN_GAMES it returns null and the caller keeps the
 * fallback, because a σ fitted on 200 games is worse than an honest default.
 */
export function measureMarginSigma(league: LeagueId): number | null {
  const games = loadGames(league, 0);
  if (games.length < SIGMA_MIN_GAMES) return null;
  const latest = games[games.length - 1].season;
  const from = latest - SIGMA_SEASONS + 1;

  const resid: number[] = [];
  replayGames(games, {
    onGame: ({ game, home, away, predictedMargin }) => {
      // The same warm-up the backtest uses: a team with five games has a rating that
      // says little, and its errors would widen σ for reasons that are not the sport.
      if (home.games < 20 || away.games < 20) return;
      if (game.season < from) return;
      resid.push(game.home_pts - game.away_pts - predictedMargin);
    },
  });
  if (resid.length < SIGMA_MIN_GAMES) return null;
  const mean = resid.reduce((a, b) => a + b, 0) / resid.length;
  const sd = Math.sqrt(resid.reduce((a, b) => a + (b - mean) ** 2, 0) / (resid.length - 1));
  // A guard, not a tuning knob: anything outside this is a bug upstream, and a wild
  // σ would make every probability on the tab meaningless rather than merely wrong.
  if (!(sd > 6 && sd < 25)) return null;
  return Math.round(sd * 100) / 100;
}

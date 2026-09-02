// Replay matches chronologically to produce team ratings.
//
// ONE replay, shared by the app and the backtest — the same arrangement used on
// the basketball side, and for the same reason: a backtest that keeps its own
// copy of the update rules drifts from the shipped model, and then its reported
// accuracy describes something nobody is running.

import {
  getPromotionGap,
  measurePromotionGap,
  secondDivisionOf,
  storePromotionGap,
} from './promotion.ts';
import { getDb } from '../db.ts';
import {
  carryOver,
  eloExpectation,
  expectedGoals,
  goalDifferenceMultiplier,
  GOAL_SENSITIVITY,
  HOME_ADVANTAGE,
  HOME_GOAL_SHARE,
  INITIAL_ELO,
  K_FACTOR,
  SEASON_CARRYOVER,
} from './model.ts';
import {
  carryOverStrength,
  neutralStrength,
  shrinkStrength,
  updateStrengths,
  STRENGTH_ALPHA,
  STRENGTH_CARRYOVER,
  STRENGTH_MODE,
  STRENGTH_SHRINK_MATCHES,
  type StrengthMode,
  type TeamStrength,
} from './strength.ts';
import {
  daysBetween,
  freshMomentum,
  momentumElo,
  restAdjustment,
  updateMomentum,
  CONGESTION_ELO,
  MOMENTUM_ALPHA,
  MOMENTUM_ELO,
  type MomentumState,
} from './momentum.ts';
import { fitDixonColes, type DcMatch, type DcParams } from './bayes/dixonColes.ts';
import { storeDcParams } from './bayes/repo.ts';
import type { LeagueId } from './types.ts';

/**
 * EWMA rate at which the league goals anchor follows the league's own scoring.
 *
 * 1/760 is about two seasons of memory — the same window the live app uses when
 * it reads the anchor out of the database, so the backtest and the app are
 * describing the same model. The optimum is a wide plateau (anything from one to
 * four seasons of memory scores the same), which is what a real effect looks
 * like; the thing that matters is that the anchor MOVES at all.
 */
export const ANCHOR_ALPHA = 1 / 760;

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
  /** Learned attack/defence multipliers — the goals model (see strength.ts). */
  strength: TeamStrength;
  /** Recent over/under-performance against the team's own rating. */
  momentum: MomentumState;
}

export interface ReplayOptions {
  homeAdvantage?: number;
  k?: number;
  carryover?: number;
  /** Weight on the goal-difference multiplier (0 = win/draw/loss only). */
  goalWeight?: number;
  /** Seasons counted toward goal averages; 0 = all. */
  scoringFromSeason?: number;

  // --- the goals model ---
  /** League goals per match. Defaults to the average over the FIRST season
   * present, which is information available before the walk-forward starts. */
  goalsAnchor?: number;
  goalSensitivity?: number;
  homeGoalShare?: number;
  /**
   * How fast the league goals anchor tracks the league's own recent scoring.
   * 0 freezes it at `goalsAnchor` for the whole replay.
   */
  anchorAlpha?: number;
  /** Learning rate for attack/defence. 0 turns the whole layer off. */
  strengthAlpha?: number;
  strengthShrink?: number;
  strengthCarryover?: number;
  /** Which half of the goal residual to learn (see strength.ts). */
  strengthMode?: StrengthMode;

  // --- the moment ---
  /** Elo points a full-strength form surprise is worth. 0 turns form off. */
  momentumWeight?: number;
  momentumAlpha?: number;
  /** Elo points lost at maximum fixture congestion. 0 turns the calendar off. */
  restWeight?: number;

  /**
   * Called BEFORE anything updates, with the pre-match state AND the model's
   * pre-match expectation. The λ handed over is the same one the replay uses to
   * learn, so a backtest reading it is scoring the shipped model by construction
   * rather than by a copy of its arithmetic.
   */
  onMatch?: (info: {
    match: ReplayMatch;
    home: FbTeamState;
    away: FbTeamState;
    lambda: { home: number; away: number };
    /** Elo actually used, after form and calendar adjustments. */
    effectiveElo: { home: number; away: number };
    adjustments: {
      momentum: { home: number; away: number };
      rest: { home: number; away: number };
      restDays: { home: number | null; away: number | null };
    };
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
    strength: neutralStrength(),
    momentum: freshMomentum(),
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
  const goalSensitivity = opts.goalSensitivity ?? GOAL_SENSITIVITY;
  const homeGoalShare = opts.homeGoalShare ?? HOME_GOAL_SHARE;
  const strengthAlpha = opts.strengthAlpha ?? STRENGTH_ALPHA;
  const strengthShrink = opts.strengthShrink ?? STRENGTH_SHRINK_MATCHES;
  const strengthCarry = opts.strengthCarryover ?? STRENGTH_CARRYOVER;
  const strengthMode = opts.strengthMode ?? STRENGTH_MODE;
  const momentumWeight = opts.momentumWeight ?? MOMENTUM_ELO;
  const momentumAlpha = opts.momentumAlpha ?? MOMENTUM_ALPHA;
  const restWeight = opts.restWeight ?? CONGESTION_ELO;
  // The anchor must not come from the future. Absent an explicit one, use the
  // average of the earliest season present — known before the replay starts.
  const anchorAlpha = opts.anchorAlpha ?? ANCHOR_ALPHA;
  // Warm-started from the earliest season, then tracked forward. Scoring rates
  // drift across a decade (the Premier League gained ~0.3 goals a match between
  // 2007 and 2021), and a frozen anchor quietly biases every total.
  let anchor = opts.goalsAnchor ?? firstSeasonGoalAverage(matches);

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
      for (const s of states.values()) {
        s.elo = carryOver(s.elo, carry);
        s.strength = carryOverStrength(s.strength, strengthCarry);
        // Form does NOT survive a summer: a run of results in May says nothing
        // about a squad that has since been rebuilt and had a pre-season.
        s.momentum.surprise = 0;
      }
      season = m.season;
    }

    const home = get(m.home_id);
    const away = get(m.away_id);

    // --- the moment: form and the calendar, as Elo offsets ---
    const restDaysHome = home.lastDate ? daysBetween(home.lastDate, m.match_date) : null;
    const restDaysAway = away.lastDate ? daysBetween(away.lastDate, m.match_date) : null;
    const momHome = momentumElo(home.momentum, momentumWeight);
    const momAway = momentumElo(away.momentum, momentumWeight);
    const restHome = restAdjustment(restDaysHome, restWeight);
    const restAway = restAdjustment(restDaysAway, restWeight);
    const effHome = home.elo + momHome + restHome;
    const effAway = away.elo + momAway + restAway;

    // --- the goals model: what the model expected, BEFORE seeing the result ---
    const lambda = expectedGoals(effHome, effAway, anchor, {
      homeAdvantage: homeAdv,
      goalSensitivity,
      homeGoalShare,
      homeStrength: shrinkStrength(home.strength, home.matches, strengthShrink),
      awayStrength: shrinkStrength(away.strength, away.matches, strengthShrink),
    });

    opts.onMatch?.({
      match: m,
      home,
      away,
      lambda,
      effectiveElo: { home: effHome, away: effAway },
      adjustments: {
        momentum: { home: momHome, away: momAway },
        rest: { home: restHome, away: restAway },
        restDays: { home: restDaysHome, away: restDaysAway },
      },
    });

    // --- update ---
    const expected = eloExpectation(home.elo, away.elo, homeAdv);
    const actual = m.home_goals > m.away_goals ? 1 : m.home_goals === m.away_goals ? 0.5 : 0;
    const mult = goalDifferenceMultiplier(m.home_goals - m.away_goals, goalWeight);
    const shift = k * mult * (actual - expected);
    home.elo += shift;
    away.elo -= shift;

    // Attack/defence learn from the part of the scoreline the model missed. Fed
    // the same λ it was judged on, so what it absorbs is genuinely the residual.
    updateStrengths(
      home.strength,
      away.strength,
      lambda.home,
      lambda.away,
      m.home_goals,
      m.away_goals,
      { alpha: strengthAlpha, mode: strengthMode },
    );

    // Form is the surprise against the rating — the same expectation the Elo
    // update just used, which is why it needs no separate notion of "good result".
    updateMomentum(home.momentum, actual, expected, m.match_date, momentumAlpha);
    updateMomentum(away.momentum, 1 - actual, 1 - expected, m.match_date, momentumAlpha);

    home.matches++;
    away.matches++;
    home.lastDate = m.match_date;
    away.lastDate = m.match_date;

    if (anchorAlpha > 0) {
      anchor = anchor * (1 - anchorAlpha) + anchorAlpha * (m.home_goals + m.away_goals);
    }

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

/** Average goals per match over the earliest season in the list. */
export function firstSeasonGoalAverage(matches: ReplayMatch[]): number {
  if (matches.length === 0) return 2.7;
  const first = matches[0].season;
  let n = 0;
  let goals = 0;
  for (const m of matches) {
    if (m.season !== first) break;
    goals += m.home_goals + m.away_goals;
    n++;
  }
  return n > 0 ? goals / n : 2.7;
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
    // seeded_from is cleared here on purpose: this row comes from matches actually
    // played in this division, so whatever transplant preceded it is now history.
    `INSERT INTO fb_team_ratings (team_id, league, elo, matches_played, last_date, gf, ga)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, team_id) DO UPDATE SET
       elo = excluded.elo, matches_played = excluded.matches_played,
       last_date = excluded.last_date, gf = excluded.gf, ga = excluded.ga,
       seeded_from = NULL`,
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

  // The division gap, measured per country from clubs that actually made the jump.
  // AFTER the loop, because it replays both divisions and needs their ratings to
  // exist. See promotion.ts for the numbers and why they are not one constant.
  for (const league of leagues) {
    if (secondDivisionOf(league as LeagueId)) {
      storePromotionGap(league as LeagueId, measurePromotionGap(league as LeagueId));
    }
  }

  // El Dixon-Coles jerárquico, que es de donde salen las λ de las predicciones. Se
  // ajusta aquí y no al predecir: un ajuste son cientos de milisegundos y una pantalla
  // pide sesenta predicciones, así que ajustar por petición multiplicaría por sesenta
  // un trabajo que solo cambia cuando entran resultados nuevos.
  for (const league of leagues) {
    storeDcParams(league, fitLeagueDc(league as LeagueId));
  }
  return out;
}

/**
 * Los hiperparámetros del ajuste, elegidos midiendo (`npm run study:dc`).
 *
 * Semivida de un año y σ = 0.30, elegidos puntuando las temporadas de ENTRENAMIENTO
 * (2023-2024) sobre una rejilla de cuatro decays × tres encogimientos. La validación
 * no participó en la elección; ver la nota en predict.ts para lo que dio después.
 */
export const DC_HYPER = {
  xi: Math.LN2 / 365,
  sigmaAttack: 0.3,
  sigmaDefence: 0.3,
};

/**
 * Ajustar el Dixon-Coles de una liga con todo su histórico.
 *
 * `asOf` es la fecha del último partido y no «hoy»: los pesos del decay se cuentan
 * desde el final de los datos, así que un archivo que lleva parado tres meses no ve
 * cómo se le evapora el peso de sus partidos más recientes.
 */
export function fitLeagueDc(league: LeagueId): DcParams | null {
  const rows = getDb()
    .prepare(
      `SELECT match_date date, home_id homeId, away_id awayId,
              home_goals homeGoals, away_goals awayGoals
       FROM fb_matches WHERE league = ? ORDER BY match_date`,
    )
    .all(league) as unknown as DcMatch[];
  if (rows.length < 100) return null;
  return fitDixonColes(rows, rows[rows.length - 1].date, DC_HYPER);
}

/**
 * Give a club promoted into `league` a rating, so its fixtures get a real model.
 *
 * Called when a fixture names a club the top division has never seen. Without it
 * the card falls back to the market's implied numbers and no breakdown at all —
 * which is what a reader saw on Atlético Madrid vs Málaga, and what they see for
 * every promoted club until it has played.
 *
 * The rating is its SECOND-DIVISION Elo plus that country's measured gap, and the
 * row is written with `matches_played = 0` on purpose: it is a transplant, not
 * earned history, and everything downstream that keys off games played — the
 * reliability band, the "pocos partidos" warning — should treat it as such.
 *
 * Returns what was done so the caller can say it on the card, or null when the club
 * is not in the second division either (a cup opponent from a third tier, a
 * foreign side in a friendly) — in which case there is genuinely nothing to build a
 * model from and the honest answer is still the market's numbers.
 */
export function seedPromotedTeam(
  league: LeagueId,
  teamId: string,
): { elo: number; from: LeagueId; offset: number; sd: number } | null {
  const gap = getPromotionGap(league);
  if (!gap) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT elo FROM fb_team_ratings WHERE league = ? AND team_id = ?')
    .get(gap.from, teamId) as unknown as { elo: number } | undefined;
  if (!row) return null;
  const elo = round1(row.elo + gap.offset);
  const name = (
    db.prepare('SELECT name FROM fb_teams WHERE league = ? AND id = ?').get(gap.from, teamId) as
      | { name: string }
      | undefined
  )?.name;
  db.prepare(
    `INSERT INTO fb_teams (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO NOTHING`,
  ).run(teamId, league, name ?? teamId);
  db.prepare(
    `INSERT INTO fb_team_ratings
       (team_id, league, elo, matches_played, last_date, gf, ga, seeded_from)
     VALUES (?, ?, ?, 0, NULL, NULL, NULL, ?)
     ON CONFLICT(league, team_id) DO NOTHING`,
  ).run(teamId, league, elo, gap.from);
  return { elo, from: gap.from, offset: gap.offset, sd: gap.sd };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

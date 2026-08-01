// ===========================================================================
// FOOTBALL MODEL
// ===========================================================================
// Football breaks the pattern used by the other two sports, in one way that
// changes everything: THE DRAW. About a quarter of matches end level, so a
// prediction is a three-way distribution, and a model that only produces
// "probability the home side wins" has nothing to say about the most common
// single scoreline in the sport.
//
// The chain here is:
//
//   Elo gap + home advantage  →  expected goals for each side
//                             →  a Poisson distribution over exact scores
//                             →  1X2, over/under, both-teams-to-score
//
// Deriving every market from ONE distribution is the point. It is not just tidy:
// it makes the numbers impossible to contradict each other. Quote 1X2 from an Elo
// curve and over/under from a separate goals average, and you can end up telling
// someone a match is 70% likely to be won by the home side and 60% likely to
// finish 0-0. Here that cannot happen — every figure is a sum over the same grid.
//
// DIXON-COLES. Plain Poisson treats the two teams' goals as independent, and
// measurably gets the low scores wrong: 0-0, 1-0, 0-1 and 1-1 happen more often
// than independence predicts (defensive matches suppress both sides at once).
// Dixon & Coles (1997) correct exactly those four cells with one parameter, rho.
// It is a small correction, and it is fitted here rather than assumed.
//
// Every constant is fitted by `npm run backtest:fb` on real matches, which can
// switch each piece off (--home 0, --rho 0, …) so its contribution is measured.
// See docs/FOOTBALL.md.
// ===========================================================================

export const INITIAL_ELO = 1500;
export const MEAN_ELO = 1500;

/**
 * Home advantage in Elo points. Football's home edge is large and slow-moving;
 * fitted on real league matches (see the backtest).
 */
export const HOME_ADVANTAGE = 65;

/** Base K-factor. Football teams play ~38 league matches a season, so a single
 * result should move a rating less than in tennis but more than in the NBA. */
export const K_FACTOR = 20;

/** Fraction of a rating that survives the summer (transfers, promotion). */
export const SEASON_CARRYOVER = 0.85;

/**
 * Goal-difference weighting on K. Winning 5-0 says more than 1-0, with sharply
 * diminishing returns — the standard football-Elo treatment.
 */
export function goalDifferenceMultiplier(goalDiff: number, weight = 1): number {
  if (weight === 0) return 1;
  const g = Math.abs(goalDiff);
  const raw = g <= 1 ? 1 : g === 2 ? 1.5 : (11 + g) / 8;
  return 1 + weight * (raw - 1);
}

/** Expected score (0..1) in the Elo sense, used only to UPDATE ratings. */
export function eloExpectation(homeElo: number, awayElo: number, homeAdvantage: number): number {
  return 1 / (1 + Math.pow(10, -(homeElo + homeAdvantage - awayElo) / 400));
}

export function carryOver(elo: number, carryover = SEASON_CARRYOVER): number {
  return MEAN_ELO + (elo - MEAN_ELO) * carryover;
}

// ---------------------------------------------------------------------------
// Elo → expected goals
// ---------------------------------------------------------------------------
/**
 * Convert a rating gap into each side's expected goals.
 *
 * The league's own average goals per team is the anchor, so a division that
 * averages 1.6 goals a side is not forced onto the Bundesliga's 1.7. The Elo gap
 * then tilts that baseline multiplicatively: the stronger side is expected to
 * score more AND concede less, which is what actually happens.
 *
 *   tilt          = 10^(gap · GOAL_SENSITIVITY / 400)
 *   λ_home        = baseline_home · tilt
 *   λ_away        = baseline_away / tilt
 *
 * GOAL_SENSITIVITY is fitted; it decides how strongly rating differences move the
 * scoreline rather than just the win probability.
 */
export const GOAL_SENSITIVITY = 0.32;

/**
 * Share of a league's total goals scored by the home side.
 *
 * NOTE this and HOME_ADVANTAGE both encode the home edge, so they are
 * substitutes: raising one wants the other lowered. Fitted jointly (the optimum
 * is a flat ridge); 65 Elo + 0.52 was chosen over equally-scoring pairs because
 * it keeps the home edge as an explicit Elo quantity the breakdown can show,
 * with the goal split carrying only the residual.
 */
export const HOME_GOAL_SHARE = 0.52;

export function expectedGoals(
  homeElo: number,
  awayElo: number,
  leagueGoalsPerMatch: number,
  opts: {
    homeAdvantage?: number;
    neutral?: boolean;
    goalSensitivity?: number;
    homeGoalShare?: number;
  } = {},
): { home: number; away: number } {
  const adv = opts.neutral ? 0 : (opts.homeAdvantage ?? HOME_ADVANTAGE);
  const sens = opts.goalSensitivity ?? GOAL_SENSITIVITY;
  const share = opts.neutral ? 0.5 : (opts.homeGoalShare ?? HOME_GOAL_SHARE);
  const gap = homeElo + adv - awayElo;
  const tilt = Math.pow(10, (gap * sens) / 400);
  const baseHome = leagueGoalsPerMatch * share;
  const baseAway = leagueGoalsPerMatch * (1 - share);
  // Clamp: a Poisson mean below ~0.15 or above ~5 produces score distributions
  // no real league match has ever looked like, and it only happens when a rating
  // is built from almost no data.
  return {
    home: clamp(baseHome * tilt, 0.15, 5),
    away: clamp(baseAway / tilt, 0.15, 5),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Score distribution
// ---------------------------------------------------------------------------
/** Poisson probability of exactly k events with mean λ. */
export function poisson(k: number, lambda: number): number {
  // Computed in log space: λ^k and k! both overflow/underflow quickly, and the
  // ratio is well behaved even when neither term is.
  let logFactorial = 0;
  for (let i = 2; i <= k; i++) logFactorial += Math.log(i);
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial);
}

/**
 * Dixon-Coles correction for the four low-scoring cells.
 *
 * The SIGN matters and is easy to get backwards: a NEGATIVE rho is what raises
 * 0-0 and 1-1 (tau = 1 − rho > 1 for 1-1), which is the direction real football
 * needs — independent Poisson underpredicts draws. A positive rho suppresses
 * exactly the cells that were already too rare. rho = 0 leaves plain Poisson
 * untouched; the effect here is small but consistently positive.
 */
export const DIXON_COLES_RHO = -0.1;

export function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  lambdaHome: number,
  lambdaAway: number,
  rho = DIXON_COLES_RHO,
): number {
  if (rho === 0) return 1;
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

/** How many goals per side the grid covers. Beyond 8 the mass is negligible. */
const MAX_GOALS = 8;

export interface ScoreDistribution {
  /** grid[h][a] = probability of exactly h-a. Sums to 1. */
  grid: number[][];
  lambdaHome: number;
  lambdaAway: number;
}

/** Full distribution over exact scores, Dixon-Coles adjusted and normalised. */
export function scoreDistribution(
  lambdaHome: number,
  lambdaAway: number,
  rho = DIXON_COLES_RHO,
): ScoreDistribution {
  const grid: number[][] = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    grid[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p =
        poisson(h, lambdaHome) *
        poisson(a, lambdaAway) *
        dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      // The correction can in principle push a cell slightly negative for
      // extreme λ; clamping keeps the distribution a distribution.
      grid[h][a] = Math.max(0, p);
      total += grid[h][a];
    }
  }
  // Renormalise: truncating at 8 goals and clamping both lose a little mass, and
  // probabilities that don't sum to 1 would quietly bias every market below.
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) grid[h][a] /= total;
  }
  return { grid, lambdaHome, lambdaAway };
}

export interface MarketProbabilities1X2 {
  home: number;
  draw: number;
  away: number;
}

/** 1X2 from the grid: sum the cells where each outcome happens. */
export function outcomeProbabilities(dist: ScoreDistribution): MarketProbabilities1X2 {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      const p = dist.grid[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  return { home, draw, away };
}

/** P(total goals > line). The line is a half-goal, so no push is possible. */
export function overProbability(dist: ScoreDistribution, line = 2.5): number {
  let over = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      if (h + a > line) over += dist.grid[h][a];
    }
  }
  return over;
}

/** P(both teams score at least one). */
export function bothTeamsScoreProbability(dist: ScoreDistribution): number {
  let p = 0;
  for (let h = 1; h < dist.grid.length; h++) {
    for (let a = 1; a < dist.grid[h].length; a++) p += dist.grid[h][a];
  }
  return p;
}

export interface ScoreLine {
  home: number;
  away: number;
  probability: number;
}

/** The most likely exact scores, highest first. */
export function topScorelines(dist: ScoreDistribution, count = 6): ScoreLine[] {
  const all: ScoreLine[] = [];
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      all.push({ home: h, away: a, probability: dist.grid[h][a] });
    }
  }
  return all.sort((x, y) => y.probability - x.probability).slice(0, count);
}

/** Expected total goals implied by the distribution (≈ λ_home + λ_away). */
export function expectedTotalGoals(dist: ScoreDistribution): number {
  let total = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) total += (h + a) * dist.grid[h][a];
  }
  return total;
}

/**
 * RANKED PROBABILITY SCORE — the right accuracy metric for football.
 *
 * Brier treats the three outcomes as unordered, so predicting a home win when the
 * match was drawn is punished exactly as hard as predicting a home win when the
 * away side won. But the outcomes ARE ordered (home / draw / away), and being
 * "one step" wrong is genuinely a better forecast than being two steps wrong. RPS
 * is the standard football measure precisely because it accounts for that.
 *
 * Lower is better; 0 is a perfect forecast.
 */
export function rankedProbabilityScore(
  probs: MarketProbabilities1X2,
  actual: 'H' | 'D' | 'A',
): number {
  const p = [probs.home, probs.draw, probs.away];
  const o = [actual === 'H' ? 1 : 0, actual === 'D' ? 1 : 0, actual === 'A' ? 1 : 0];
  let cumP = 0;
  let cumO = 0;
  let sum = 0;
  // Sum over the first two cumulative differences (the third is always 0).
  for (let i = 0; i < 2; i++) {
    cumP += p[i];
    cumO += o[i];
    sum += (cumP - cumO) ** 2;
  }
  return sum / 2;
}

/** Strip the bookmaker margin from three-way decimal odds. */
export function impliedFrom1X2(
  oddsHome: number,
  oddsDraw: number,
  oddsAway: number,
): (MarketProbabilities1X2 & { overround: number }) | null {
  if (!(oddsHome > 1) || !(oddsDraw > 1) || !(oddsAway > 1)) return null;
  const rawH = 1 / oddsHome;
  const rawD = 1 / oddsDraw;
  const rawA = 1 / oddsAway;
  const overround = rawH + rawD + rawA;
  return {
    home: rawH / overround,
    draw: rawD / overround,
    away: rawA / overround,
    overround,
  };
}

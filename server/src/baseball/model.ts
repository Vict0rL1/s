// ===========================================================================
// THE BASEBALL MODEL
// ===========================================================================
// Same shape as football — one run distribution, every market summed out of it —
// but three things about baseball force real changes:
//
//   1. THE STARTING PITCHER. One player, announced the day before, who is
//      responsible for suppressing roughly two thirds of the opposition's
//      innings. Nothing in the other three sports is remotely comparable: a team
//      behind its ace and the same team behind its fifth starter are different
//      teams, and the market prices them that way. This is the model's headline
//      feature, and section 3 of docs/BASEBALL.md is what it was measured to be
//      worth.
//
//   2. RUNS ARE NOT POISSON. Goals in football are close enough to Poisson to
//      model directly; runs are not, and the reason is baseball's structure — an
//      inning does not end on a clock, it ends on three outs, so a rally has no
//      natural cap and big innings cluster. Real MLB run distributions have a
//      variance roughly TWICE their mean. Poisson forces variance = mean, and the
//      result is a model that badly understates both shutouts and blowouts — the
//      exact tails the totals market lives in. A negative binomial fixes it with
//      one extra parameter.
//
//   3. THE SCORECARD CAN BE TIED, BUT THE GAME CANNOT. Nine innings level means
//      extra innings, not a draw. So the diagonal of the run grid is real
//      probability mass that has to be resolved into a winner rather than
//      reported as an outcome, which is the mirror image of the football problem.
// ===========================================================================

export const INITIAL_ELO = 1500;

/**
 * Home advantage, in Elo points.
 *
 * Small by the standards of the other three sports, and correctly so: MLB home
 * teams win about 54% of the time, against ~60% in football and ~60% in the NBA.
 * Baseball's home edge is the smallest in major team sport, and a model that
 * borrowed basketball's 100 would be wrong by a mile.
 */
export const HOME_ADVANTAGE = 24;

/**
 * K-factor.
 *
 * Tiny, because a season is 162 games and one of them means very little. The best
 * team in baseball loses 60 times a year; a K that let a single result move the
 * rating meaningfully would be modelling noise. This is the parameter that most
 * separates baseball from football (K = 20 over 38 games).
 */
export const K_FACTOR = 5;

/** Fraction of a rating that survives the off-season. */
export const SEASON_CARRYOVER = 0.8;

/** Run-differential weighting on K, capped — see runDifferentialMultiplier. */
export const RUN_DIFF_WEIGHT = 1.2;

/**
 * How strongly the Elo gap tilts expected runs.
 *
 * Lower than football's 0.32 because baseball outcomes are far noisier relative
 * to team quality: the spread between the best and worst offences in a season is
 * roughly 3.2 to 5.6 runs a game, which is a much narrower band than the Elo
 * spread alone would suggest.
 */
export const RUN_SENSITIVITY = 0.25;

/** Share of a game's runs scored by the home side, at equal strength. */
export const HOME_RUN_SHARE = 0.505;

/**
 * Negative binomial dispersion, r.
 *
 * Variance = μ + μ²/r. At μ ≈ 4.5 runs and the observed variance ≈ 9.4, r lands
 * near 4. As r → ∞ the distribution collapses back to Poisson, so `--dispersion
 * 1e9` in the backtest recovers the naive model and shows what this is worth.
 */
export const RUN_DISPERSION = 4.5;

/** Highest run total the grid enumerates per side. */
export const MAX_RUNS = 15;

/**
 * Probability the home team wins once the game goes to extra innings.
 *
 * Not 0.5: the home side bats last, and in extras that is worth a little more
 * than usual because it only needs one run to end it. Also not the full home
 * advantage, because both teams are already there.
 */
export const EXTRA_INNINGS_HOME = 0.53;

// ---------------------------------------------------------------------------
// Elo
// ---------------------------------------------------------------------------
export function eloExpectation(homeElo: number, awayElo: number, homeAdvantage = HOME_ADVANTAGE): number {
  return 1 / (1 + Math.pow(10, (awayElo - (homeElo + homeAdvantage)) / 400));
}

/**
 * Weighting on K by run differential.
 *
 * Deliberately gentle and hard-capped. A 15-1 win is not fifteen times the
 * evidence of a 2-1 win — it usually means a bullpen was emptied in a lost cause,
 * and letting it move a rating accordingly is how a model ends up overrating
 * teams that beat up on bad ones.
 */
export function runDifferentialMultiplier(diff: number, weight = RUN_DIFF_WEIGHT): number {
  if (weight === 0) return 1;
  const capped = Math.min(Math.abs(diff), 6);
  return 1 + weight * (Math.log1p(capped) / Math.log(7) - 0.35);
}

export function carryOver(elo: number, carry = SEASON_CARRYOVER): number {
  return INITIAL_ELO + (elo - INITIAL_ELO) * carry;
}

// ---------------------------------------------------------------------------
// The starting pitcher
// ---------------------------------------------------------------------------
/**
 * Nominal league runs allowed per start. Only a fallback: the live model measures
 * a pitcher as a RATIO against what it expected of an average starter in that
 * exact matchup, which needs no league constant at all.
 *
 * Read that definition twice, because the obvious alternative is a trap. The
 * natural statistic is a pitcher's runs allowed per nine innings — but Retrosheet
 * event files do not attribute innings without simulating every out, so the only
 * honest quantity available is "runs the opposition scored in his starts". That
 * includes whatever the bullpen gave up after he left.
 *
 * The first version of this model computed a fake RA9 by assuming a nominal 5⅓
 * innings per start, and the arithmetic quietly exploded: charging a starter his
 * team's whole game and then dividing by five and a third innings makes EVERY
 * pitcher look like a 7.4 RA9 disaster, every run factor pinned at its upper
 * clamp, and the predicted run total 2.25 runs a game too high. The model was
 * confidently wrong in a way no accuracy figure would have shown.
 *
 * So the rate is per START, measured against the league's own per-start average.
 * Both sides of the ratio are then the same quantity and it centres on 1 by
 * construction. The bullpen contamination does not vanish — it is absorbed into
 * PITCHER_WEIGHT, which is fitted against this exact definition.
 */
export const LEAGUE_RUNS_PER_START = 4.4;

/**
 * Starts needed before a pitcher's own record is trusted at half weight.
 *
 * Fifteen — most of a season — and the size is the finding. A pitcher with three
 * starts who has allowed one run is not an ace, he is an average pitcher who has
 * had a good month, and the backtest is emphatic about it: shrinkage keeps
 * improving all the way out to 25 starts and only then flattens.
 *
 * This and PITCHER_WEIGHT are substitutes — heavier shrinkage simply lets a
 * larger weight through for the same net effect — so the ridge is flat and the
 * pair was chosen from the middle of it.
 */
export const PITCHER_REGRESSION_STARTS = 15;

/**
 * How much of a starter's measured edge reaches the scoreboard.
 *
 * NOT 1.0, and the reason is the bullpen: a starter goes about 5⅓ innings of a
 * nine-inning game, so even a pitcher who allowed nothing at all controls only
 * around 60% of the runs his team concedes. The rest belongs to relievers this
 * model does not rate separately. That the fitted value lands near 0.55 — close
 * to the actual share of innings a modern starter throws — is a good sign the
 * number is measuring what it claims to.
 */
export const PITCHER_WEIGHT = 0.55;

/**
 * A starter's run-suppression ratio, shrunk toward 1 (= exactly average).
 *
 * `sumRatio` is the running total of (runs his team allowed) ÷ (runs the model
 * expected them to allow, with an AVERAGE starter on the mound). Measuring the
 * ratio rather than the raw rate is what makes this opponent-adjusted for free:
 * a pitcher who spent April against the three best offences in the league is not
 * penalised for it, because the denominator already knew they were good.
 *
 * Below 1 = suppresses runs. Returns null with no starts on record — which is a
 * different thing from "average", and the caller treats it as such.
 */
export function pitcherRating(
  sumRatio: number,
  starts: number,
  regressionStarts = PITCHER_REGRESSION_STARTS,
): number | null {
  if (starts <= 0) return null;
  const raw = sumRatio / starts;
  const w = starts / (starts + regressionStarts);
  return 1 + (raw - 1) * w;
}

/**
 * The multiplier a starting pitcher applies to the runs his team allows.
 *
 * Below 1 for a pitcher better than average. Clamped, because the arithmetic is
 * linear and a rating of 0.9 runs per nine over a hot stretch would otherwise
 * produce a forecast no baseball game has ever looked like.
 */
export function pitcherRunFactor(rating: number | null, weight = PITCHER_WEIGHT): number {
  if (rating == null || weight === 0) return 1;
  return clamp(1 + weight * (rating - 1), 0.7, 1.35);
}

/**
 * Each team's own runs-scored / runs-allowed rate, in the total. Measured, worth
 * nothing, shipped OFF.
 *
 * The gap looked obvious and large: `expectedRuns` takes the LEAGUE's runs per game
 * and never asks how much these two teams score. In 2019 the Astros scored 5.7 a
 * game and the Tigers 3.6, and basketball's model does use exactly this signal
 * (expectedPoints, from ppg and papg). The rates are already tracked in the replay
 * and already persisted as rs/ra.
 *
 * Fitted the way basketball does it — what this offence scores against what that
 * defence concedes, shrunk toward the league mean — and swept across shrinkage
 * weights, walk-forward over six cut points from 2014 to 2024:
 *
 *   w = 0.3   0 de 6 mejoran   Brier over/under 0.24624 → 0.24653
 *   w = 0.5   0 de 6           0.24624 → 0.24688
 *   w = 0.7   0 de 6           0.24624 → 0.24735
 *   w = 1.0   0 de 6           0.24624 → 0.24830
 *
 * Every weight, every cut point, worse. The interesting detail is that the MAE of
 * the total improves very slightly (3.4980 → 3.4955) while the Brier worsens: the
 * rates nudge the mean toward truth and add more variance than they remove, which is
 * what a signal that is mostly noise plus already-counted information looks like.
 * The Elo tilt and the starting pitcher were carrying it.
 *
 * Non-zero and re-run `npm run backtest:bsb` to reproduce.
 */
export const TEAM_RATE_WEIGHT = 0;

// ---------------------------------------------------------------------------
// Expected runs
// ---------------------------------------------------------------------------
export interface ExpectedRuns {
  home: number;
  away: number;
  /** The same figures with both starters treated as average — the denominator a
   * pitcher's own rating is measured against. */
  baseHome: number;
  baseAway: number;
}

export function expectedRuns(
  homeElo: number,
  awayElo: number,
  leagueRunsPerGame: number,
  opts: {
    homeAdvantage?: number;
    neutral?: boolean;
    runSensitivity?: number;
    homeRunShare?: number;
    /** Run-suppression ratio of each side's STARTING pitcher, if announced. */
    homePitcher?: number | null;
    awayPitcher?: number | null;
    pitcherWeight?: number;
    /**
     * How much this STADIUM moves the run total. 1.23 at Coors, 0.90 in Seattle.
     *
     * Applies to BOTH sides, unlike the pitcher factors: thin air and a deep
     * outfield do not care who is batting. Undefined leaves it out entirely, which
     * is what the replay that FITS the factors has to do — see parkFactors.ts.
     */
    parkFactor?: number | null;
  } = {},
): ExpectedRuns {
  const adv = opts.neutral ? 0 : (opts.homeAdvantage ?? HOME_ADVANTAGE);
  const sens = opts.runSensitivity ?? RUN_SENSITIVITY;
  const share = opts.neutral ? 0.5 : (opts.homeRunShare ?? HOME_RUN_SHARE);
  const gap = homeElo + adv - awayElo;
  const tilt = Math.pow(10, (gap * sens) / 400);
  // A pitcher suppresses the runs the OPPOSITION scores, so each side's factor
  // lands on the other side's total. Getting this the wrong way round produces a
  // model that thinks an ace helps his own offence.
  const homeFactor = pitcherRunFactor(opts.awayPitcher ?? null, opts.pitcherWeight);
  const awayFactor = pitcherRunFactor(opts.homePitcher ?? null, opts.pitcherWeight);
  // The stadium scales both sides equally. Note it multiplies the BASE too, so the
  // "both starters average" denominator a pitcher's rating is measured against is
  // also a Coors-adjusted denominator — otherwise an ace pitching in Denver would
  // be blamed for the altitude.
  const park = opts.parkFactor ?? 1;
  const baseHome = clamp(leagueRunsPerGame * share * tilt * park, 1.2, 14);
  const baseAway = clamp(((leagueRunsPerGame * (1 - share)) / tilt) * park, 1.2, 14);
  return {
    home: clamp(baseHome * homeFactor, 1.2, 14),
    away: clamp(baseAway * awayFactor, 1.2, 14),
    baseHome,
    baseAway,
  };
}

// ---------------------------------------------------------------------------
// The run distribution
// ---------------------------------------------------------------------------
/** Negative binomial pmf with mean `mean` and dispersion `r`. */
export function negativeBinomial(mean: number, r: number, maxK: number): number[] {
  const out: number[] = [];
  if (!(r > 0) || !Number.isFinite(r) || r > 1e6) {
    // r → ∞ is exactly Poisson; kept as a real branch so `--dispersion 1e9`
    // in the backtest measures the naive model rather than silently failing.
    let p = Math.exp(-mean);
    for (let k = 0; k <= maxK; k++) {
      out.push(p);
      p = (p * mean) / (k + 1);
    }
    return out;
  }
  const p = r / (r + mean);
  let term = Math.pow(p, r); // P(X = 0)
  for (let k = 0; k <= maxK; k++) {
    out.push(term);
    term = (term * (r + k) * (1 - p)) / (k + 1);
  }
  return out;
}

export interface RunDistribution {
  /** grid[homeRuns][awayRuns], normalised to sum to 1, diagonal resolved. */
  grid: number[][];
  home: number[];
  away: number[];
  lambdaHome: number;
  lambdaAway: number;
  /** Mass that sat on the diagonal before it was split — i.e. P(extra innings). */
  extraInnings: number;
}

/**
 * The joint distribution over final scores.
 *
 * The two sides are treated as independent, which is a real approximation but a
 * much safer one than in football: the low-scoring correlation Dixon-Coles
 * corrects for (both teams stuck on 0 or 1) has no baseball equivalent, because
 * the sides do not interact within an inning — each half-inning is one offence
 * against one defence, taking turns.
 */
export function runDistribution(
  lambdaHome: number,
  lambdaAway: number,
  dispersion = RUN_DISPERSION,
  maxRuns = MAX_RUNS,
  extraHome = EXTRA_INNINGS_HOME,
): RunDistribution {
  const home = negativeBinomial(lambdaHome, dispersion, maxRuns);
  const away = negativeBinomial(lambdaAway, dispersion, maxRuns);
  const grid: number[][] = [];
  let total = 0;
  for (let h = 0; h <= maxRuns; h++) {
    grid[h] = [];
    for (let a = 0; a <= maxRuns; a++) {
      const p = home[h] * away[a];
      grid[h][a] = p;
      total += p;
    }
  }
  if (total > 0) {
    for (let h = 0; h <= maxRuns; h++) {
      for (let a = 0; a <= maxRuns; a++) grid[h][a] /= total;
    }
  }

  // ---- resolve the diagonal ----
  // A FINAL baseball score is never tied: 3 of the 37,262 games in this database
  // are, and all three were called off. Modelling the two sides independently
  // nevertheless puts ~9% of the mass on the diagonal, which is not a result — it
  // is the probability of going to extra innings, and extra innings end with
  // somebody one run ahead.
  //
  // So each tied cell (k,k) is pushed to (k+1,k) or (k,k+1). That is both honest
  // (every cell left in the grid is a score that can actually happen) and
  // realistic (the winner scores in the tenth). Doing it HERE rather than in the
  // win probability means the totals, the run line and the margins all inherit it
  // automatically and cannot disagree with each other.
  let extraInnings = 0;
  for (let k = 0; k <= maxRuns; k++) {
    const tied = grid[k][k];
    if (tied <= 0) continue;
    extraInnings += tied;
    grid[k][k] = 0;
    if (k + 1 <= maxRuns) {
      grid[k + 1][k] += tied * extraHome;
      grid[k][k + 1] += tied * (1 - extraHome);
    } else if (k > 0) {
      // At the very top of the grid there is no k+1 to push into. Pushing DOWN
      // instead keeps the invariant exact — "no cell on the diagonal" is a claim
      // the card makes in words, so it has to be true for every cell, not for
      // most of them. The mass involved is ~5e-6, but an invariant that holds
      // almost always is not an invariant.
      grid[k][k - 1] += tied * extraHome;
      grid[k - 1][k] += tied * (1 - extraHome);
    }
  }

  return { grid, home, away, lambdaHome, lambdaAway, extraInnings };
}

export interface WinProbability {
  home: number;
  away: number;
  /** Probability the nine innings end level and the game goes to extras. */
  extraInnings: number;
}

/**
 * Win probability, read off the grid.
 *
 * The diagonal is not a result — it is the probability of extra innings — so it
 * is split rather than reported. Ignoring it instead (renormalising the two sides
 * over the off-diagonal) would be subtly wrong: about 9% of MLB games are tied
 * after nine, and the home side wins slightly more than half of them.
 */
export function winProbability(dist: RunDistribution): WinProbability {
  let home = 0;
  let away = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      const p = dist.grid[h][a];
      if (h > a) home += p;
      else if (h < a) away += p;
    }
  }
  const total = home + away;
  return {
    home: total > 0 ? home / total : 0.5,
    away: total > 0 ? away / total : 0.5,
    extraInnings: dist.extraInnings,
  };
}

/** Probability the combined total goes over `line` (a .5 line never pushes). */
export function overProbability(dist: RunDistribution, line = 8.5): number {
  let over = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      if (h + a > line) over += dist.grid[h][a];
    }
  }
  return over;
}

/**
 * The run line: baseball's fixed −1.5 / +1.5 handicap.
 *
 * `homeCovers` is the home team winning by two or more; `awayCovers` is the away
 * team winning outright OR losing by exactly one. Extra innings are folded in
 * using the same split as the win probability, because a tie after nine can still
 * finish 1-0 in the eleventh — and by convention an extra-innings win almost
 * always lands inside the 1.5.
 */
export function runLine(dist: RunDistribution): {
  homeCovers: number;
  awayCovers: number;
} {
  let homeBy2Plus = 0;
  let rest = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      const p = dist.grid[h][a];
      if (h - a >= 2) homeBy2Plus += p;
      else rest += p;
    }
  }
  // Nothing special is needed for extra innings here: the distribution already
  // pushed those games to a one-run margin, which is exactly right — an
  // extra-innings winner almost never clears −1.5.
  return { homeCovers: homeBy2Plus, awayCovers: rest };
}

export interface ScoreLine {
  home: number;
  away: number;
  probability: number;
}

export function topScorelines(dist: RunDistribution, count = 6): ScoreLine[] {
  const all: ScoreLine[] = [];
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      all.push({ home: h, away: a, probability: dist.grid[h][a] });
    }
  }
  return all.sort((x, y) => y.probability - x.probability).slice(0, count);
}

/** Trim the grid for transport; `tail` keeps the total honest at 1. */
export function gridForDisplay(
  dist: RunDistribution,
  maxRuns = 10,
): { cells: number[][]; maxRuns: number; tail: number } {
  const cells: number[][] = [];
  let shown = 0;
  for (let h = 0; h <= maxRuns; h++) {
    cells[h] = [];
    for (let a = 0; a <= maxRuns; a++) {
      const p = dist.grid[h]?.[a] ?? 0;
      cells[h][a] = Math.round(p * 1e6) / 1e6;
      shown += p;
    }
  }
  return { cells, maxRuns, tail: Math.round(Math.max(0, 1 - shown) * 1e6) / 1e6 };
}

export interface RunMargin {
  margin: number;
  probability: number;
}

/** Winning margin, the diagonals of the grid. Margin 0 = extra innings. */
export function marginDistribution(dist: RunDistribution, maxMargin = 6): RunMargin[] {
  const by = new Map<number, number>();
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      const m = Math.max(-maxMargin, Math.min(maxMargin, h - a));
      by.set(m, (by.get(m) ?? 0) + dist.grid[h][a]);
    }
  }
  const out: RunMargin[] = [];
  for (let m = maxMargin; m >= -maxMargin; m--) {
    out.push({ margin: m, probability: Math.round((by.get(m) ?? 0) * 1e6) / 1e6 });
  }
  return out;
}

export function expectedTotalRuns(dist: RunDistribution): number {
  let total = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) total += (h + a) * dist.grid[h][a];
  }
  return total;
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------
export interface MarketProbabilities {
  home: number;
  away: number;
  overround: number;
}

/** Two-way moneyline odds → vig-free probabilities. */
export function impliedFromMoneyline(
  oddsHome: number,
  oddsAway: number,
): MarketProbabilities | null {
  if (!(oddsHome > 1) || !(oddsAway > 1)) return null;
  const rawHome = 1 / oddsHome;
  const rawAway = 1 / oddsAway;
  const overround = rawHome + rawAway;
  if (!(overround > 0)) return null;
  return { home: rawHome / overround, away: rawAway / overround, overround };
}

/**
 * Pythagorean expectation — how many games a team "should" have won given the
 * runs it scored and allowed. 1.83 is the exponent Bill James settled on and it
 * still holds up.
 */
export function pythagorean(runsScored: number, runsAllowed: number, exponent = 1.83): number | null {
  if (runsScored <= 0 && runsAllowed <= 0) return null;
  const rs = Math.pow(runsScored, exponent);
  const ra = Math.pow(runsAllowed, exponent);
  if (rs + ra <= 0) return null;
  return rs / (rs + ra);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

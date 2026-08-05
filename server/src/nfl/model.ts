// The American football model.
//
// Everything the card shows — the winner, the handicap at any line, the total,
// the margin bands, the likely final scores — comes out of ONE distribution over
// (home points, away points). That is the same discipline as the other four
// sports and it is what the audit checks: a card cannot say the home team wins
// 62% of the time in one panel and price a pick'em handicap at 55% in another,
// because both are read off the same grid.
//
// What is different here is the SHAPE of that distribution.
//
// ---------------------------------------------------------------------------
// Why not a normal curve
// ---------------------------------------------------------------------------
// Basketball's margin is close to normal, so basketball prices its spread off a
// normal curve and that is fine. American football scores in 3s and 7s, and the
// margin distribution inherits the lumps:
//
//     margin   3 →  15.1% of games        margin   9 →  1.6%
//     margin   7 →   9.0%                 margin  12 →  1.7%
//     margin  10 →   5.5%                 margin  15 →  1.5%
//     margin  14 →   4.9%                 margin  11 →  2.4%
//
// (7,276 games, 1999-2025.) A normal curve puts roughly equal mass on 9 and 10;
// the real game puts 3.4× more on 10. Those are not decorative differences —
// "3" and "7" are the two numbers every NFL handicap is set around, so a smooth
// curve is wrong exactly where it is being asked the question.
//
// So the margin distribution here is a normal curve MULTIPLIED by a table of
// per-margin weights measured from the games themselves, then renormalised.
// Fitted on 2006-2017 and tested on 2018-2025, that is worth +0.123 nats of
// log-likelihood per game — the distribution is 1.13× more likely to have
// produced the season that actually happened. The weights were fitted around
// the model's OWN expected margin, not the market's, so the gain is the model's.
//
// The same treatment applied to the TOTAL is worth far less (+0.024 nats) and
// the fitted table looks more like noise than structure, so those weights are
// shrunk 75% of the way toward 1 — a level itself chosen out of sample.

import type { LeagueId } from './types.ts';

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------
export const INITIAL_ELO = 1500;

/**
 * K, fitted by sweep on 2010+ log loss.
 *
 * Low, because an NFL season is 17 games: a K big enough to react inside a
 * season is a K that overreacts to one Sunday. 18 measured best; 14 and 25 were
 * both worse.
 */
export const K_FACTOR = 18;

/**
 * Where the home-field estimate starts, in Elo points.
 *
 * Only matters for the 1999 run-in; from there the tracker takes over.
 */
export const HOME_ADVANTAGE_START = 55;

/**
 * How fast the home-field estimate follows the league.
 *
 * THE ONE PLACE THIS MODEL REFUSES A CONSTANT. Home field was worth +2.75 points
 * a game in 1999-2007, +1.92 in 2020-2025, and +0.30 in the empty stadiums of
 * 2020. Fitting one number over 27 seasons produces a number that is wrong in
 * every one of them: a fixed advantage scores 0.6383 log loss on 2020-2025,
 * a tracked one 0.6353.
 *
 * 1/512 is about two seasons of memory (a season is ~272 games). Faster (1/128)
 * chases noise; slower (1/1024) missed 2020 almost entirely.
 */
export const HOME_ADVANTAGE_ALPHA = 1 / 512;

/**
 * How much of a team's rating survives the off-season.
 *
 * 0.6 — the lowest of the five sports, and it should be: the draft, free agency
 * and a hard salary cap exist precisely to stop NFL teams staying the same.
 * Measured: 0.6 → 0.6312 log loss, 0.8 → 0.6344, 1.0 (no regression) → 0.6464.
 */
export const SEASON_CARRYOVER = 0.6;

/**
 * Elo points per point of expected margin.
 *
 * This single number converts "better team" into "by how much", so it sets the
 * scale of the expected margin, the handicap prices AND the win probability —
 * and those three do not want the same value.
 *
 *      per-point   margin sd     log loss
 *          18        13.44        0.6309
 *          20        13.40        0.6306   ← shipped
 *          22        13.38        0.6313
 *          24        13.39        0.6324
 *
 * 22 wins on margin spread by 0.02 points, which nobody can see; 20 wins on log
 * loss, which is the headline probability on the card. Fitting on margin spread
 * alone left the win probabilities visibly under-confident — the 85-90% bucket
 * came in at 95% and the 35-40% bucket at 32%. Widening the expected margin
 * slightly sharpens them back, at a cost in margin accuracy of two hundredths of
 * a point.
 */
export const ELO_PER_POINT = 20;

/**
 * Margin-of-victory multiplier, the 538 form.
 *
 * The biggest single win in the model: without it, log loss goes from 0.6312 to
 * 0.6469 and the margin residual from 13.40 to 13.74. A 30-point win and a
 * 1-point win are not the same evidence, and an Elo that treats them alike
 * throws away most of what a football score tells you.
 *
 * The denominator damps blowouts by already-strong favourites, which is what
 * stops a good team beating a bad one 45-3 from inflating past its real level.
 */
export function movMultiplier(marginAbs: number, eloDiffForWinner: number): number {
  return Math.log(marginAbs + 1) * (2.2 / (eloDiffForWinner * 0.001 + 2.2));
}

/**
 * Days of rest, and division games.
 *
 * Both measured, both worth nothing, both shipped OFF rather than deleted so the
 * measurement stays reproducible.
 *
 *   rest (Elo per day of difference)   0 → 0.6312   4 → 0.6308   12 → 0.6323
 *   the bye week (extra Elo)           0 → 0.6312  15 → 0.6310   30 → 0.6312
 *   division game (home edge scaling)  0 → 0.6312 −20% → 0.6312 −40% → 0.6314
 *
 * The bye-week bounce and the "division games are always close" rule are two of
 * the most repeated claims in NFL punditry. Over 4,000 games neither shows up at
 * the fourth decimal place. Set them non-zero and re-run the backtest to see for
 * yourself.
 */
export const REST_ELO_PER_DAY = 0;
export const BYE_WEEK_ELO = 0;
export const DIVISION_HOME_SCALE = 0;

// ---------------------------------------------------------------------------
// Scoring rates, for the total
// ---------------------------------------------------------------------------
/** EWMA weight on the newest game for a team's points for / against. */
export const SCORING_ALPHA = 0.1;
/** How much of a team's scoring level survives the winter. */
export const SCORING_CARRYOVER = 0.6;
/** Where the league's points-per-game anchor starts. */
export const LEAGUE_TOTAL_START = 44;
/** How fast that anchor follows the league. Two seasons of memory. */
export const LEAGUE_TOTAL_ALPHA = 1 / 512;

// ---------------------------------------------------------------------------
// The starting quarterback
// ---------------------------------------------------------------------------
// A team rating alone cannot answer "who is playing quarterback", and in this
// sport that is the biggest single roster question there is: 52% of team-seasons
// in the archive start more than one quarterback, so one team number silently
// averages a starter and his backup and is wrong for both.
//
// THE DECOMPOSITION. A side's rating is `teamElo + qbAdjustment`, where the
// adjustment is an offset around zero — a league-average quarterback adds
// nothing. Each result's Elo shift is SPLIT between the two: the team takes
// (1 − QB_SPLIT), the quarterback takes QB_SPLIT. Splitting rather than crediting
// both in full is what keeps one win from being counted twice.
//
// MEASURED, walk-forward, on the 27-season archive. The weight was fitted at
// three different train/test boundaries and came out at 0.35 every time, with the
// out-of-sample win log loss improving 0.46%, 0.46% and 0.49%:
//
//   corte 2008:  0.62857 → 0.62570      corte 2012:  0.63018 → 0.62731
//   corte 2016:  0.63375 → 0.63064
//
// The reason to believe it is signal and not a fitted curiosity is WHERE the gain
// sits. On the 989 held-out games started by someone other than the team's usual
// starter, log loss improves 1.78% — four times the overall figure — and the
// margin's standard deviation drops from 13.51 to 13.21. The model got better
// precisely in the games the quarterback column was added to explain.
export const QB_SPLIT = 0.35;

/**
 * How much of a quarterback's offset survives the winter.
 *
 * Higher than the team's 0.6: a roster is rebuilt every spring, a quarterback's
 * arm is not. Fitted alongside QB_SPLIT.
 */
export const QB_CARRYOVER = 0.85;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------
// Two adjustments to the expected TOTAL (never to the margin — wind hurts both
// offences, so it does not favour either side).
//
// WIND. Monotone across every band in the archive, which is why this survived
// where rest and bye weeks did not. Mean residual of the model's own expected
// total, outdoor games only:
//
//     0–4 mph  +0.57      9–12 mph  −1.00      17–20 mph  −3.19
//     5–8 mph   0.00     13–16 mph  −2.19       21+ mph   −5.06
//
// Fitted slope −0.2075 points per mph on 2001–2012, −0.2855 on 2013+ — same sign,
// same order of magnitude, so it replicates.
//
// ROOF. Indoor games outscore the model's expectation by 2.44 points, and this is
// NOT the wind effect wearing a different hat: fitted jointly, out-of-sample RMSE
// of the total goes 13.6140 (neither) → 13.5692 (wind) → 13.5716 (roof) → 13.5245
// (both). Each term earns its place.
//
// HONEST LIMIT, because it changes what these buy you. nflverse publishes the
// roof for scheduled games but no weather forecast, so the roof term moves an
// upcoming prediction and the wind term cannot. Wind still matters: applied
// during the replay it stops a windy afternoon in Buffalo being charged to the
// offence, so the scoring rates the forecast is built from measure the team
// rather than the weather.
export const WIND_TOTAL_PER_MPH = -0.2075;

/**
 * The wind speed the adjustment is measured against: the archive's mean outdoor
 * wind. Centring on it rather than on zero means a typical breezy afternoon moves
 * nothing, and only the unusual games get pushed.
 */
export const WIND_REFERENCE_MPH = 8.64;

/** Points between an indoor game and an outdoor one, all else equal. */
export const INDOOR_TOTAL_POINTS = 2.44;

/**
 * Share of games played under a roof — 24.95% across the archive.
 *
 * THE BUG THIS FIXES. The first version simply added 2.44 points indoors and
 * nothing outdoors, and the backtest caught it immediately: the mean total error
 * went from −0.04 to −0.61, meaning the model had started over-predicting every
 * total. 2.44 × 0.2753 = 0.67 on the backtest's own indoor share, which is the
 * whole discrepancy.
 *
 * The reason is that the expected total is built from each team's points-per-game
 * EWMAs, and those are measured from real scores — so they ALREADY contain the
 * average effect of the venues teams play in. An adjustment on top has to
 * redistribute between games, not raise the league. Centring on the indoor share
 * makes it sum to zero: 0.25 × (2.44 × 0.75) − 0.75 × (2.44 × 0.25) = 0.
 */
export const INDOOR_SHARE = 0.2495;

/**
 * The conditions adjustment to an expected total, in points. Zero-mean by
 * construction — see INDOOR_SHARE.
 *
 * `wind` is null indoors and for any game not yet played, and null means "no
 * information" rather than "no wind" — a dome and a still day in Buffalo are not
 * the same thing, and treating a missing reading as zero would push every
 * scheduled game as though it were unusually calm.
 */
export function conditionsTotalAdjustment(
  roof: string | null | undefined,
  wind: number | null | undefined,
): number {
  if (roof == null) return 0;
  const indoor = /dome|closed/i.test(roof);
  if (indoor) return INDOOR_TOTAL_POINTS * (1 - INDOOR_SHARE);
  const roofTerm = -INDOOR_TOTAL_POINTS * INDOOR_SHARE;
  // Wind is already centred on the mean outdoor reading, so it too averages out.
  const windTerm = wind == null ? 0 : WIND_TOTAL_PER_MPH * (wind - WIND_REFERENCE_MPH);
  return roofTerm + windTerm;
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------
/**
 * Spread of the margin around its expectation, measured on 2006+.
 *
 * For scale: the CLOSING LINE's residual is 13.20 on the same games. The model
 * is 0.3 points wider than the sharpest price in sports, which is the honest
 * summary of where it stands.
 */
export const MARGIN_SIGMA = 13.5;

/** Spread of the total around its expectation. The market's is 13.23. */
export const TOTAL_SIGMA = 13.6;

/** Margins beyond this are folded into the tail. Rare enough not to matter. */
export const MAX_MARGIN = 70;
/** Support of the total. A 0-0 and a 70-63 are both inside it. */
export const MAX_TOTAL = 110;

/**
 * The key numbers, as multipliers on a normal curve.
 *
 * Measured as (games with this margin) ÷ (games a normal curve expected), over
 * 2006-2025 with the model's own expected margin. Read them as "the scoreboard
 * lands here N times as often as a smooth curve would say":
 *
 *     3 → 2.75×    the field goal, and by far the most important number in the sport
 *     7 → 1.84×    the touchdown
 *    14 → 1.44×    two touchdowns
 *    10 → 1.22×    touchdown + field goal
 *     9 → 0.36×    a margin that needs an unusual combination to reach
 *     0 → 0.10×    overtime resolves nearly every tie; 15 in 7,276 games survived
 *
 * Symmetric in the sign of the margin: 3 is a key number whether the home team
 * or the away team wins by it, which the data confirms — ±3 is the most frequent
 * margin in every bucket of closing spread, including games where the away team
 * is favoured by a touchdown or more. The lumps belong to the scoreboard, not to
 * the matchup.
 */
export const MARGIN_KEY_WEIGHTS: Record<number, number> = {
  0: 0.095, 1: 0.765, 2: 0.791, 3: 2.753, 4: 0.964, 5: 0.726,
  6: 1.268, 7: 1.835, 8: 0.830, 9: 0.364, 10: 1.223, 11: 0.543,
  12: 0.435, 13: 0.667, 14: 1.436, 15: 0.491, 16: 0.730, 17: 1.205,
  18: 0.919, 19: 0.485, 20: 0.993, 21: 1.374, 22: 0.593, 23: 0.785,
  24: 1.570, 25: 0.865, 26: 0.746, 27: 1.064, 28: 1.791,
};

/**
 * The same idea for the total, shrunk 75% toward 1.
 *
 * Unshrunk these are worth +0.020 nats out of sample; at 0.75 shrinkage, +0.024.
 * Both are a fifth of what the margin weights are worth, and the raw table has
 * no legible structure — which is the signature of fitting noise, so it gets
 * pulled most of the way back toward "no adjustment".
 */
export const TOTAL_KEY_WEIGHTS: Record<number, number> = {
  22: 0.977, 23: 1.629, 24: 0.800, 25: 0.665, 26: 1.365, 27: 1.242,
  28: 0.663, 29: 1.028, 30: 1.422, 31: 0.830, 32: 0.821, 33: 1.397,
  34: 1.115, 35: 0.797, 36: 1.037, 37: 1.378, 38: 0.812, 39: 0.847,
  40: 1.179, 41: 1.244, 42: 0.684, 43: 1.234, 44: 1.280, 45: 0.916,
  46: 0.826, 47: 1.138, 48: 1.031, 49: 0.834, 50: 0.931, 51: 1.375,
  52: 0.903, 53: 0.690, 54: 0.936, 55: 1.059, 56: 0.574, 57: 1.072,
  58: 1.090, 59: 0.845, 60: 0.649, 61: 0.898, 62: 0.997, 63: 0.866,
  64: 0.890, 65: 1.326, 66: 1.053, 67: 0.775,
};

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------
export function eloExpectation(eloDiff: number): number {
  return 1 / (1 + 10 ** (-eloDiff / 400));
}

export function carryOver(elo: number, factor = SEASON_CARRYOVER): number {
  return INITIAL_ELO + (elo - INITIAL_ELO) * factor;
}

/** Φ(z), Abramowitz & Stegun 7.1.26 via erf. */
export function normalCdf(z: number): number {
  // erf approximation, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Mass a normal curve puts on the integer n, with the continuity correction. */
function normalPmf(n: number, mu: number, sigma: number): number {
  return Math.max(normalCdf((n + 0.5 - mu) / sigma) - normalCdf((n - 0.5 - mu) / sigma), 1e-12);
}

export interface Distribution {
  /** margin[m + MAX_MARGIN] = P(home points − away points = m). */
  margin: number[];
  /** total[t] = P(home points + away points = t). */
  total: number[];
  expectedMargin: number;
  expectedTotal: number;
}

/**
 * The distribution the whole card is read from.
 *
 * Margin and total are built separately and treated as independent. That is not
 * an assumption made for convenience — the measured correlation between |margin|
 * and total is +0.062 over 2010-2025, which is as close to independent as two
 * quantities from the same scoreboard get. Blowouts are only very slightly
 * higher-scoring than close games.
 */
export function buildDistribution(
  expectedMargin: number,
  expectedTotal: number,
  opts: { marginWeights?: boolean; totalWeights?: boolean; marginSigma?: number; totalSigma?: number } = {},
): Distribution {
  const useMargin = opts.marginWeights !== false;
  const useTotal = opts.totalWeights !== false;
  const ms = opts.marginSigma ?? MARGIN_SIGMA;
  const ts = opts.totalSigma ?? TOTAL_SIGMA;

  const margin = new Array<number>(2 * MAX_MARGIN + 1).fill(0);
  let mz = 0;
  for (let m = -MAX_MARGIN; m <= MAX_MARGIN; m++) {
    let p = normalPmf(m, expectedMargin, ms);
    if (useMargin) p *= MARGIN_KEY_WEIGHTS[Math.abs(m)] ?? 1;
    margin[m + MAX_MARGIN] = p;
    mz += p;
  }
  for (let i = 0; i < margin.length; i++) margin[i] /= mz;

  const total = new Array<number>(MAX_TOTAL + 1).fill(0);
  let tz = 0;
  for (let t = 0; t <= MAX_TOTAL; t++) {
    let p = normalPmf(t, expectedTotal, ts);
    if (useTotal) p *= TOTAL_KEY_WEIGHTS[t] ?? 1;
    total[t] = p;
    tz += p;
  }
  for (let t = 0; t <= MAX_TOTAL; t++) total[t] /= tz;

  return { margin, total, expectedMargin, expectedTotal };
}

export const marginProb = (d: Distribution, m: number): number =>
  Math.abs(m) > MAX_MARGIN ? 0 : d.margin[m + MAX_MARGIN];

/**
 * P(home wins), P(tie), P(away wins).
 *
 * The tie is tiny (0.2% of games) but real, and it is the reason a moneyline is
 * void rather than lost when a game ends level. Reporting it separately rather
 * than folding it into one side is the same choice football's draw forced, at
 * one seventieth the size.
 */
export function outcomeProbabilities(d: Distribution): { home: number; tie: number; away: number } {
  let home = 0;
  let away = 0;
  for (let m = 1; m <= MAX_MARGIN; m++) {
    home += marginProb(d, m);
    away += marginProb(d, -m);
  }
  return { home, tie: marginProb(d, 0), away };
}

/**
 * P(the home team covers a handicap).
 *
 * `line` is the home team's handicap the way a bookmaker writes it: −6.5 means
 * the home team must win by 7 or more. A whole-number line can PUSH — the stake
 * comes back — which is exactly the case the key numbers make common, so it is
 * reported rather than swept into one side.
 */
export function coverProbability(
  d: Distribution,
  line: number,
  side: 'home' | 'away' = 'home',
): { cover: number; push: number; fail: number } {
  let cover = 0;
  let push = 0;
  let fail = 0;
  for (let m = -MAX_MARGIN; m <= MAX_MARGIN; m++) {
    const p = marginProb(d, m);
    // The away team's margin is the negative of the home team's, so its
    // handicap is applied to −m. Computing the away side as `cover(d, −line)`
    // instead — which looks right and is not — prices a DIFFERENT home handicap
    // and silently breaks the mirror: the audit caught it as
    // "home.cover ≠ away.fail", 0.284 against 0.469 on the same game.
    const adjusted = (side === 'home' ? m : -m) + line;
    if (adjusted > 0) cover += p;
    else if (adjusted === 0) push += p;
    else fail += p;
  }
  return { cover, push, fail };
}

/** P(over), P(push), P(under) for a total line. Same push logic. */
export function overProbability(
  d: Distribution,
  line: number,
): { over: number; push: number; under: number } {
  let over = 0;
  let push = 0;
  let under = 0;
  for (let t = 0; t <= MAX_TOTAL; t++) {
    const p = d.total[t];
    if (t > line) over += p;
    else if (t === line) push += p;
    else under += p;
  }
  return { over, push, under };
}

export interface MarginBand {
  /** Inclusive bounds on the home margin; null = open ended. */
  from: number | null;
  to: number | null;
  probability: number;
  label: string;
}

/**
 * Margin split into the bands a viewer actually thinks in.
 *
 * The boundaries are the scoring units, not round numbers: one score (1-8),
 * two scores (9-16), three (17-24), more. "Within one score" is the phrase every
 * broadcast uses in the fourth quarter, and it is the honest way to say that a
 * 7-point lead is not safe.
 */
export function marginBands(d: Distribution): MarginBand[] {
  const spans: { from: number | null; to: number | null; label: string }[] = [
    { from: 25, to: null, label: 'local por 25+' },
    { from: 17, to: 24, label: 'local por 17-24' },
    { from: 9, to: 16, label: 'local por 9-16' },
    { from: 1, to: 8, label: 'local por 1-8' },
    { from: 0, to: 0, label: 'empate' },
    { from: -8, to: -1, label: 'visitante por 1-8' },
    { from: -16, to: -9, label: 'visitante por 9-16' },
    { from: -24, to: -17, label: 'visitante por 17-24' },
    { from: null, to: -25, label: 'visitante por 25+' },
  ];
  return spans.map((s) => {
    let p = 0;
    for (let m = -MAX_MARGIN; m <= MAX_MARGIN; m++) {
      if (s.from !== null && m < s.from) continue;
      if (s.to !== null && m > s.to) continue;
      p += marginProb(d, m);
    }
    return { from: s.from, to: s.to, probability: p, label: s.label };
  });
}

export interface Scoreline {
  home: number;
  away: number;
  label: string;
  probability: number;
}

/**
 * The most likely final scores.
 *
 * A score is fixed by its margin and its total together, and the two must agree
 * on parity: home = (total + margin) / 2 has to be a whole number, so an odd
 * total can only pair with an odd margin. Enumerating the pairs that satisfy
 * that and renormalising is what keeps this panel consistent with the handicap
 * and total panels above it — the audit checks exactly that.
 */
export function likelyScorelines(d: Distribution, count = 6): Scoreline[] {
  const out: Scoreline[] = [];
  let z = 0;
  for (let m = -MAX_MARGIN; m <= MAX_MARGIN; m++) {
    const pm = marginProb(d, m);
    if (pm < 1e-9) continue;
    for (let t = Math.abs(m); t <= MAX_TOTAL; t += 2) {
      const pt = d.total[t];
      if (pt < 1e-9) continue;
      const home = (t + m) / 2;
      const away = (t - m) / 2;
      if (home < 0 || away < 0) continue;
      const p = pm * pt;
      z += p;
      out.push({ home, away, label: `${home}-${away}`, probability: p });
    }
  }
  out.forEach((s) => {
    s.probability /= z;
  });
  out.sort((a, b) => b.probability - a.probability);
  return out.slice(0, count);
}

/**
 * Points a team is expected to score, split out of the total by the margin.
 *
 * Pure arithmetic: home = (total + margin) / 2. Shown because "24 to 20" reads
 * as football and "expected margin +4 on a total of 44" does not.
 */
export function expectedPoints(expectedMargin: number, expectedTotal: number): {
  home: number;
  away: number;
} {
  return {
    home: (expectedTotal + expectedMargin) / 2,
    away: (expectedTotal - expectedMargin) / 2,
  };
}

/**
 * Pythagorean expectation with the NFL exponent.
 *
 * 2.37 rather than baseball's 1.83 — football scores are lumpier, so the same
 * point differential implies a stronger record.
 */
export function pythagorean(pointsFor: number, pointsAgainst: number): number | null {
  if (pointsFor <= 0 && pointsAgainst <= 0) return null;
  const e = 2.37;
  const f = pointsFor ** e;
  const a = pointsAgainst ** e;
  if (f + a === 0) return null;
  return f / (f + a);
}

/** Leagues without an archive still get a card; it just says so. */
export function hasModel(league: LeagueId, configured: LeagueConfig[]): boolean {
  return configured.find((l) => l.id === league)?.nflverse === true;
}

type LeagueConfig = import('./types.ts').LeagueConfig;

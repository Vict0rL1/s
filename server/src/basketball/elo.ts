// ===========================================================================
// BASKETBALL ELO
// ===========================================================================
// Same core idea as the tennis engine, but basketball differs in four ways that
// each need modelling, and getting them wrong matters more than any refinement:
//
//   1. HOME COURT. A tennis match has no home team. An NBA home team wins ~59%
//      of the time against an equal opponent, so the home side gets a bonus in
//      Elo points before the probability is computed — and neutral-venue games
//      (finals, cup ties, the 2020 bubble) must NOT get it.
//
//   2. SCORE MARGIN. Basketball scores carry far more information than a tennis
//      scoreline: winning by 25 says something a 1-point win does not. The
//      K-factor is scaled by the margin, damped for favourites so beating a weak
//      team badly doesn't inflate a rating (an already-strong team is EXPECTED
//      to win big).
//
//   3. SEASONS. Rosters turn over every summer; a championship team can lose its
//      best player. Ratings are regressed toward the league mean between
//      seasons, so a new season starts from "mostly what we knew, but less sure".
//      Tennis needs nothing like this — players don't get traded.
//
//   4. SCHEDULE. Teams play back-to-backs and fly across time zones. Days of
//      rest is a real, measurable effect, and unlike tennis it applies to almost
//      every game rather than a rare returning-from-injury case.
//
// Every constant here is fitted by `npm run backtest:bb`, which replays real
// games walk-forward and can switch each piece off (--home 0, --mov 0, …) so its
// contribution is measured rather than assumed. See docs/BASKETBALL.md.
// ===========================================================================

export const INITIAL_ELO = 1500;

/** League-average rating that between-season regression pulls toward. */
export const MEAN_ELO = 1500;

/**
 * Home-court advantage in Elo points. ~100 points ≈ 64% for an otherwise equal
 * matchup; fitted below to the observed home win rate. Applied to the home
 * team's rating for the PREDICTION only — never stored in the rating itself,
 * which would double-count it the next time that team plays at home.
 */
export const HOME_ADVANTAGE = 100;

/** Base K-factor, before the margin multiplier. */
export const K_FACTOR = 20;

/** Fraction of a team's distance from the mean that carries into next season. */
export const SEASON_CARRYOVER = 0.75;

/** Elo points per point of expected margin (used for the spread estimate). */
export const ELO_PER_POINT = 28;

/** Win probability for the home team, given both ratings. */
export function homeWinProbability(
  homeElo: number,
  awayElo: number,
  opts: { neutral?: boolean; homeAdvantage?: number } = {},
): number {
  const adv = opts.neutral ? 0 : (opts.homeAdvantage ?? HOME_ADVANTAGE);
  const diff = homeElo + adv - awayElo;
  return 1 / (1 + Math.pow(10, -diff / 400));
}

/**
 * Margin-of-victory multiplier on K (FiveThirtyEight's formulation).
 *
 *   mult = (margin + 3)^0.8 / (7.5 + 0.006 · eloDiffFromWinnersView)
 *
 * The numerator rewards bigger wins with diminishing returns. The denominator is
 * the important half: it grows with how much the winner was already favoured, so
 * a strong team blowing out a weak one moves less than an upset blowout. Without
 * that damping, good teams' ratings run away from reality.
 *
 * @param margin absolute final points difference (≥ 1)
 * @param eloDiffWinner winner's rating minus loser's, INCLUDING home advantage
 */
export function movMultiplier(margin: number, eloDiffWinner: number, weight = 1): number {
  if (weight === 0) return 1;
  const m = Math.max(1, Math.abs(margin));
  const raw = Math.pow(m + 3, 0.8) / (7.5 + 0.006 * eloDiffWinner);
  // weight = 1 is the full effect; 0 disables it; values between interpolate, so
  // the backtest can measure partial credit.
  return 1 + weight * (raw - 1);
}

/**
 * Regress a rating toward the league mean between seasons.
 * carryover 1 = keep everything (no roster turnover), 0 = everyone resets.
 */
export function carryOver(elo: number, carryover = SEASON_CARRYOVER): number {
  return MEAN_ELO + (elo - MEAN_ELO) * carryover;
}

/**
 * Rest adjustment in Elo points, from days since the team's previous game.
 *
 * Fitted from residuals (see docs/BASKETBALL.md): the second night of a
 * back-to-back is a real penalty, one day of rest is the normal baseline, and
 * extra rest beyond two days adds little. Returned as a signed adjustment to
 * that team's rating for this game only.
 */
export function restAdjustment(daysRest: number | null, weight = 1): number {
  if (weight === 0 || daysRest == null) return 0;
  // 0 days = back-to-back (played yesterday), 1 = normal, 2–6 = rested.
  //
  // Beyond a week the gap stops meaning "rested" and starts meaning something
  // the model cannot see — the All-Star break, a suspension, the off-season, or
  // simply that the data ends there. Crediting a bonus for that would reward
  // ignorance, so it returns to neutral.
  if (daysRest >= LONG_LAYOFF_DAYS) return 0;
  const table: Record<number, number> = { 0: -35, 1: 0, 2: 10 };
  const base = daysRest >= 3 ? 12 : (table[daysRest] ?? 0);
  return base * weight;
}

/** Days after which a gap is a layoff of unknown cause, not rest. */
export const LONG_LAYOFF_DAYS = 7;

/**
 * Expected points margin for the home team. The Elo gap maps to points at
 * roughly 28 Elo per point in the NBA — the standard conversion, and the one
 * that lets the app quote a spread comparable to a bookmaker's line.
 */
export function expectedMargin(
  homeElo: number,
  awayElo: number,
  opts: { neutral?: boolean; homeAdvantage?: number; eloPerPoint?: number } = {},
): number {
  const adv = opts.neutral ? 0 : (opts.homeAdvantage ?? HOME_ADVANTAGE);
  const diff = homeElo + adv - awayElo;
  return diff / (opts.eloPerPoint ?? ELO_PER_POINT);
}

/**
 * Expected total points, from each team's scoring and conceding rates relative
 * to the league average.
 *
 * points_home ≈ (attack_home + defence_away) / 2, and likewise for the away
 * side, where attack/defence are the team's per-game rates. Deliberately simple
 * and stated as such: without possession counts there is no true pace figure, so
 * this is an average-based estimate, not a tempo model.
 */
export function expectedPoints(
  home: { ppg: number | null; papg: number | null },
  away: { ppg: number | null; papg: number | null },
  leagueAvg: number,
): { home: number; away: number; total: number } | null {
  if (home.ppg == null || home.papg == null || away.ppg == null || away.papg == null) return null;
  const homePts = (home.ppg + away.papg) / 2;
  const awayPts = (away.ppg + home.papg) / 2;
  // Anchor to the league average so a small sample can't produce absurd totals.
  const shrink = 0.85;
  const h = homePts * shrink + leagueAvg * (1 - shrink);
  const a = awayPts * shrink + leagueAvg * (1 - shrink);
  return { home: round1(h), away: round1(a), total: round1(h + a) };
}

// ===========================================================================
// UNCERTAINTY: from a point estimate to a distribution
// ===========================================================================
// `expectedMargin` and `expectedPoints` answer "how much", not "how likely" — and
// the two markets people actually bet in basketball are both questions of the
// second kind: does the favourite cover, does the total go over. A single number
// cannot answer either, and quoting one next to a spread invites the reader to
// treat it as certain.
//
// Basketball is the easiest of the four sports to fix this for, because the
// margin really is close to normal. Measured over 58.281 games, the residual
// (actual margin minus predicted):
//
//     sd = 11.72,  within ±1σ 70.1% (a normal says 68.3%),
//                  within ±2σ 95.1% (a normal says 95.4%)
//
// and it barely moves across eras — 11.67 before 1990, 11.68 in the 1990s and
// 2000s, 11.93 from 2010. A distribution this stable is worth trusting.

/**
 * Spread of the margin around its prediction, in points — the FALLBACK.
 *
 * This is NOT the spread of margins in general (12.9): it is the spread of what
 * the model gets WRONG, which is smaller because the rating explains some of it.
 * Using the raw figure would make every forecast less confident than it earned.
 *
 * ===========================================================================
 * WHY IT IS NOW MEASURED PER LEAGUE INSTEAD OF FROZEN HERE
 * ===========================================================================
 * 11.7 was measured on an archive that ended in June 2015. Once the current seasons
 * arrived the residual turned out not to be a constant at all — it is a trend:
 *
 *     todo el archivo   12.00
 *     desde 2006        12.47
 *     desde 2015        13.35
 *     desde 2020        14.00
 *
 * The modern NBA plays faster and shoots more threes, so margins really are wider.
 * At 11.7 only 61.3 % of margins land inside ±1σ where a normal says 68.3 %, and
 * 90.3 % inside ±2σ against 95.4 %. That is not a rounding error, it is the wrong
 * curve — and the card prints that curve as its margin bands.
 *
 * THE ONE ARGUMENT AGAINST, stated because it is real: on the Brier of covering a
 * half-point handicap set at the MODEL'S OWN line, 11.7 wins at five of six
 * walk-forward cut points, by about 0.0003. That metric only probes the centre of the
 * distribution, where the CDF is nearly straight and a narrower σ happens to push the
 * quote further from 50 %. Fixing a seven-point coverage error is worth 0.0003 of
 * Brier on one particular line.
 *
 * So the shipped value is measured from recent seasons at recompute time and stored
 * per league — see `measureMarginSigma` in ratings.ts. Any constant would be stale
 * again in three years, because the thing it describes is moving. This remains the
 * fallback for a league with too few games to measure.
 */
export const MARGIN_SIGMA = 11.7;

/** Seasons of history the measured σ is fitted on. */
export const SIGMA_SEASONS = 6;
/** Below this, a measured σ is noise and the fallback is better. */
export const SIGMA_MIN_GAMES = 1500;

/**
 * Spread of the total around its prediction, in points.
 *
 * Wider in relative terms than the margin, and worse behaved: measured at 19.3
 * from 2010 and 20.9 in the 1990s and 2000s. Without possession counts there is
 * no real pace model here, so 20 is an honest number rather than a tuned one.
 */
export const TOTAL_SIGMA = 20;

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * Probability the home team beats a handicap.
 *
 * `line` is the home team's spread in the usual sign convention: −6.5 means the
 * home side must win by 7 or more. Half-point lines never push, which is why
 * books use them.
 */
export function coverProbability(
  expectedHomeMargin: number,
  line: number,
  sigma = MARGIN_SIGMA,
): number {
  return normalCdf((expectedHomeMargin + line) / sigma);
}

/** Probability the combined score goes over `line`. */
export function overProbability(
  expectedTotal: number,
  line: number,
  sigma = TOTAL_SIGMA,
): number {
  return 1 - normalCdf((line - expectedTotal) / sigma);
}

export interface MarginBand {
  /** Inclusive lower and upper bound of the home margin, in points. */
  from: number;
  to: number;
  label: string;
  probability: number;
}

/**
 * The margin split into readable bands, for the card.
 *
 * Buckets rather than a continuous curve because that is how anyone reads a
 * basketball game: a one-possession finish, a comfortable win, a blowout.
 */
export function marginBands(expectedHomeMargin: number, sigma = MARGIN_SIGMA): MarginBand[] {
  const edges = [-Infinity, -20, -10, -5, 0, 5, 10, 20, Infinity];
  const labels = [
    'visitante por 20+', 'visitante por 10-20', 'visitante por 5-10', 'visitante por 1-5',
    'local por 1-5', 'local por 5-10', 'local por 10-20', 'local por 20+',
  ];
  const out: MarginBand[] = [];
  for (let i = 0; i < labels.length; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const pLo = lo === -Infinity ? 0 : normalCdf((lo - expectedHomeMargin) / sigma);
    const pHi = hi === Infinity ? 1 : normalCdf((hi - expectedHomeMargin) / sigma);
    out.push({
      from: lo === -Infinity ? -99 : lo,
      to: hi === Infinity ? 99 : hi,
      label: labels[i],
      probability: Math.round((pHi - pLo) * 1e5) / 1e5,
    });
  }
  return out;
}

/**
 * CALIBRATION
 * -----------
 * As in tennis, the raw Elo curve is over-confident on real results, so the
 * rating gap is shrunk before becoming a probability. The factor is fitted by
 * `npm run backtest:bb -- --calibration <n>`; 1 means no calibration.
 */
export const CALIBRATION_SCALE = 1;

export function calibratedHomeWinProbability(
  homeElo: number,
  awayElo: number,
  opts: {
    neutral?: boolean;
    homeAdvantage?: number;
    scale?: number;
  } = {},
): number {
  const adv = opts.neutral ? 0 : (opts.homeAdvantage ?? HOME_ADVANTAGE);
  const diff = (homeElo + adv - awayElo) * (opts.scale ?? CALIBRATION_SCALE);
  return 1 / (1 + Math.pow(10, -diff / 400));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

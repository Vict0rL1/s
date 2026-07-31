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

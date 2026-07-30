// ===========================================================================
// ELO RATING ENGINE  (explainable, not a black box)
// ===========================================================================
//
// Elo assigns every player a single number (their "rating"). The gap between two
// players' ratings maps directly to a win probability, and after each match the
// ratings shift toward the actual result. Nothing here is hidden — every number
// the model produces can be traced back to these three formulas.
//
// 1) EXPECTED SCORE (win probability from a rating gap)
//        E_A = 1 / (1 + 10 ^ ((R_B - R_A) / 400))
//    A 0-point gap → 50%. Every +400 points ≈ 10x more likely to win
//    (≈91% vs a 400-point-lower opponent).
//
// 2) UPDATE after a match (S = 1 for the winner, 0 for the loser)
//        R_A' = R_A + K * (S_A - E_A)
//    Win when you were expected to (E_A high) → small gain. Upset win
//    (E_A low) → big gain. The loser mirrors it.
//
// 3) DYNAMIC K-FACTOR (how much a single match moves the rating)
//        K(n) = 250 / (n + 5) ^ 0.4      (n = matches the player has played)
//    New players (small n) move fast so their rating finds its level quickly;
//    veterans (large n) are stable. This is the approach popularised by
//    FiveThirtyEight / Tennis Abstract for tennis Elo.
//
// SURFACE-SPECIFIC ELO
//    Clay, grass and hard courts reward different skills, so on top of one
//    "overall" rating we keep a separate rating per surface. A clay match only
//    updates the player's clay rating (and their overall); it never touches
//    their grass rating. Carpet / unknown surfaces update overall only.
// ===========================================================================

import type { MatchRow, TourId } from '../types.ts';

export const INITIAL_ELO = 1500;

/** Probability that player A beats player B given their ratings. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * CALIBRATION
 * -----------
 * The raw Elo curve is over-confident on real data: measured on ATP matches
 * (see `npm run backtest`), matches predicted at ~85% were won ~76% of the time.
 * That happens because a single rating gap can't capture how noisy tennis is
 * (injuries, off days, match-ups), so extreme probabilities are too extreme.
 *
 * Fix: shrink the rating gap toward zero by a constant factor before converting
 * it to a probability. This is standard probability calibration (equivalent to
 * temperature scaling on the logit). The factor was fitted from the backtest's
 * calibration table — re-run the backtest after changing the model to re-check.
 */
export const CALIBRATION_SCALE = 0.7;

/** Win probability with the calibration factor applied (what the app reports). */
export function calibratedExpectedScore(
  ratingA: number,
  ratingB: number,
  scale: number = CALIBRATION_SCALE,
): number {
  return 1 / (1 + Math.pow(10, ((ratingB - ratingA) * scale) / 400));
}

/** Dynamic K-factor: large for newcomers, small for veterans. */
export function kFactor(matchesPlayed: number): number {
  return 250 / Math.pow(matchesPlayed + 5, 0.4);
}

export type SurfaceKey = 'hard' | 'clay' | 'grass';

/** Map Sackmann's raw surface string to one of our tracked surface keys. */
export function surfaceKey(raw: string | null | undefined): SurfaceKey | null {
  switch ((raw || '').toLowerCase()) {
    case 'hard':
      return 'hard';
    case 'clay':
      return 'clay';
    case 'grass':
      return 'grass';
    default:
      return null; // Carpet / unknown → overall only
  }
}

/** Mutable rating state kept per player while replaying match history. */
interface RatingState {
  overall: number;
  hard: number;
  clay: number;
  grass: number;
  nOverall: number;
  nHard: number;
  nClay: number;
  nGrass: number;
  lastDate: string | null;
}

function freshState(): RatingState {
  return {
    overall: INITIAL_ELO,
    hard: INITIAL_ELO,
    clay: INITIAL_ELO,
    grass: INITIAL_ELO,
    nOverall: 0,
    nHard: 0,
    nClay: 0,
    nGrass: 0,
    lastDate: null,
  };
}

export interface ComputedRating {
  player_id: number;
  tour: TourId;
  overall: number;
  hard: number;
  clay: number;
  grass: number;
  matches_played: number;
  last_date: string | null;
}

/**
 * Replay every match in chronological order and return each player's final
 * ratings. Matches must all belong to the same tour.
 */
export function computeRatings(matches: MatchRow[], tour: TourId): ComputedRating[] {
  const states = new Map<number, RatingState>();
  const get = (id: number): RatingState => {
    let s = states.get(id);
    if (!s) {
      s = freshState();
      states.set(id, s);
    }
    return s;
  };

  // Chronological order is essential: a rating only reflects matches before it.
  const ordered = [...matches].sort((a, b) =>
    a.tourney_date === b.tourney_date ? a.id - b.id : a.tourney_date < b.tourney_date ? -1 : 1,
  );

  for (const m of ordered) {
    const w = get(m.winner_id);
    const l = get(m.loser_id);

    // --- Overall rating update ---
    const eW = expectedScore(w.overall, l.overall);
    const kW = kFactor(w.nOverall);
    const kL = kFactor(l.nOverall);
    w.overall += kW * (1 - eW);
    l.overall += kL * (0 - (1 - eW)); // loser's expected = 1 - eW
    w.nOverall += 1;
    l.nOverall += 1;
    w.lastDate = m.tourney_date;
    l.lastDate = m.tourney_date;

    // --- Surface-specific rating update ---
    const sk = surfaceKey(m.surface);
    if (sk) {
      const wSurf = w[sk];
      const lSurf = l[sk];
      const eWs = expectedScore(wSurf, lSurf);
      const nW = sk === 'hard' ? w.nHard : sk === 'clay' ? w.nClay : w.nGrass;
      const nL = sk === 'hard' ? l.nHard : sk === 'clay' ? l.nClay : l.nGrass;
      w[sk] = wSurf + kFactor(nW) * (1 - eWs);
      l[sk] = lSurf + kFactor(nL) * (0 - (1 - eWs));
      if (sk === 'hard') {
        w.nHard += 1;
        l.nHard += 1;
      } else if (sk === 'clay') {
        w.nClay += 1;
        l.nClay += 1;
      } else {
        w.nGrass += 1;
        l.nGrass += 1;
      }
    }
  }

  const out: ComputedRating[] = [];
  for (const [player_id, s] of states) {
    out.push({
      player_id,
      tour,
      overall: round1(s.overall),
      hard: round1(s.hard),
      clay: round1(s.clay),
      grass: round1(s.grass),
      matches_played: s.nOverall,
      last_date: s.lastDate,
    });
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

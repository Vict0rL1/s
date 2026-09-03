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
 * temperature scaling on the logit). The factor is fitted from the backtest's
 * calibration table — re-run `npm run backtest` after changing the model, and
 * compare candidates with `--calibration <n>`.
 *
 * Fitted on 22,062 out-of-sample ATP matches (2015–2026): 0.75 matched or beat
 * every alternative on Brier/log loss and kept predicted-vs-observed within
 * ~1 pp up to the 90% band (uncalibrated was off by 6–8 pp there).
 */
export const CALIBRATION_SCALE = 0.75;

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

// ---------------------------------------------------------------------------
// MARGIN OF VICTORY
// ---------------------------------------------------------------------------
// Plain Elo only sees who won. But 6-0 6-0 and 7-6 6-7 7-6 say very different
// things about the gap between two players, and throwing that away discards
// information sitting right there in the scoreline.
//
// So the K-factor is scaled by how dominant the win was, measured as the
// winner's share of all games played. Averaged over 44k ATP matches that share
// is 0.615, and that is the pivot: an average-margin win moves the rating
// exactly as much as before, a blowout moves it more, a squeaker less. Centring
// on the observed mean (rather than 0.5) is what keeps the ratings on the same
// scale instead of inflating every K.
//
// Whether this actually helps is measured, not assumed:
// `npm run backtest -- --mov <weight>` scores any weight, including 0 (off).
// ---------------------------------------------------------------------------

/** Mean share of games won by the winner across ATP matches (measured). */
export const MEAN_DOMINANCE = 0.615;

/**
 * Weight on margin of victory. Fitted with `npm run backtest -- --mov <w>`;
 * see docs/MODEL.md for the comparison table. 0 disables the adjustment.
 */
export const MOV_WEIGHT = 4;

/** Bounds on the multiplier, so one freak scoreline can't dominate a rating. */
const MOV_MIN = 0.6;
const MOV_MAX = 1.5;

/**
 * Winner's share of the games played, from a score string like "6-3 7-6(7)".
 * Returns null when the margin is not meaningful:
 *   • retirements / walkovers — the score reflects an injury, not dominance;
 *   • unparseable or partial scores.
 */
export function gameDominance(score: string | null | undefined): number | null {
  if (!score) return null;
  const up = score.toUpperCase();
  if (/RET|W\/?O|WALKOVER|DEF|ABD|UNFINISHED|NA$/.test(up)) return null;
  let winnerGames = 0;
  let loserGames = 0;
  let sets = 0;
  for (const token of score.trim().split(/\s+/)) {
    // Leading "6-3" of each set; a tiebreak suffix like "7-6(7)" is ignored
    // because games, not points, are the unit here.
    const m = token.match(/^(\d+)-(\d+)/);
    if (!m) return null;
    winnerGames += Number(m[1]);
    loserGames += Number(m[2]);
    sets++;
  }
  const total = winnerGames + loserGames;
  // A completed match is at least two sets and 12 games; anything less is a
  // truncated or malformed score.
  if (sets < 2 || total < 12) return null;
  return winnerGames / total;
}

/**
 * K-factor multiplier for a match's margin. 1 when the margin is unknown, so a
 * retirement simply falls back to plain Elo instead of being guessed at.
 */
export function movMultiplier(
  score: string | null | undefined,
  weight: number = MOV_WEIGHT,
): number {
  if (weight === 0) return 1;
  const dominance = gameDominance(score);
  if (dominance === null) return 1;
  const raw = 1 + weight * (dominance - MEAN_DOMINANCE);
  return Math.min(MOV_MAX, Math.max(MOV_MIN, raw));
}

// ---------------------------------------------------------------------------
// LAYOFF ("rust")
// ---------------------------------------------------------------------------
// Elo has no concept of time: a rating earned before a six-month injury is
// applied as if the player never stopped. Measured on 34k out-of-sample ATP
// matches, that costs real accuracy — and in the direction most people guess
// wrong. Bucketing the model's residual by how much rest each player had
// relative to their opponent:
//
//   rest vs opponent   observed − predicted
//   ≥ 60 days more          −4.3 pp      ← more rested does WORSE
//   14–60 days more         −3.5 pp
//   ±4 days (normal)         0.0 pp
//   14–60 days less         +3.5 pp
//   ≥ 60 days less          +4.2 pp      ← match-sharp does BETTER
//
// So a layoff is a penalty, not an advantage: ring rust and the (unobserved)
// injury that usually caused the layoff both point the same way. The effect
// saturates — the difference between 4 and 8 months off is small compared with
// the difference between 1 week and 2 months.
//
// Note the resolution: dates in the history are TOURNAMENT start dates, so this
// really measures "time since the last event", not since the last match. Matches
// inside one tournament all share a date, which is why the free window below
// starts at a week rather than a day.
//
// Fitted with `npm run backtest -- --rest <maxElo>` (0 disables).
// ---------------------------------------------------------------------------

/** Days between events that count as a normal schedule — no penalty. */
const REST_FREE_DAYS = 7;
/** Days at which the layoff penalty reaches its maximum. */
const REST_FULL_DAYS = 90;
/** Elo points subtracted at full layoff. Fitted; see docs/MODEL.md. */
export const REST_MAX_PENALTY = 60;

/**
 * Elo penalty (≤ 0) for a player's layoff. `daysSinceLastMatch` null → 0, so a
 * player with no history is never penalised for data we don't have.
 */
export function layoffAdjustment(
  daysSinceLastMatch: number | null | undefined,
  maxPenalty: number = REST_MAX_PENALTY,
): number {
  if (maxPenalty === 0 || daysSinceLastMatch == null) return 0;
  const over = daysSinceLastMatch - REST_FREE_DAYS;
  if (over <= 0) return 0;
  const ramp = Math.min(1, over / (REST_FULL_DAYS - REST_FREE_DAYS));
  return -maxPenalty * ramp;
}

// ---------------------------------------------------------------------------
// FORMAT (best of 3 vs best of 5)
// ---------------------------------------------------------------------------
// More sets means less variance, so the better player converts their edge more
// often. One calibration factor for both formats therefore has to be wrong in
// both: measured over the same 34k matches, the favourite's win rate came in
// 2.1 pp BELOW the stated probability at best-of-3 and 3.1 pp ABOVE it at
// best-of-5. Two factors instead of one — more shrinking for the noisier format,
// less for the longer one.
//
// Fitted with `npm run backtest -- --bo3 <s> --bo5 <s>`.
// ---------------------------------------------------------------------------

export const CALIBRATION_SCALE_BO3 = 0.68;
export const CALIBRATION_SCALE_BO5 = 0.86;

/** Calibration factor for a match format (falls back to the pooled value). */
export function calibrationScaleFor(bestOf: number | null | undefined): number {
  if (bestOf === 5) return CALIBRATION_SCALE_BO5;
  if (bestOf === 3) return CALIBRATION_SCALE_BO3;
  return CALIBRATION_SCALE;
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

    // How dominant was the win? Scales both updates below (1 if unknown).
    const mov = movMultiplier(m.score);

    // --- Overall rating update ---
    const eW = expectedScore(w.overall, l.overall);
    const kW = kFactor(w.nOverall) * mov;
    const kL = kFactor(l.nOverall) * mov;
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
      w[sk] = wSurf + kFactor(nW) * mov * (1 - eWs);
      l[sk] = lSurf + kFactor(nL) * mov * (0 - (1 - eWs));
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

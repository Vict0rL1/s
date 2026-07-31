// ===========================================================================
// RELIABILITY = how much this particular prediction can be trusted
// ===========================================================================
// A probability alone hides how much evidence is behind it. "62.4%" for a match
// between two players with 800 tour matches each is a very different claim from
// "62.4%" for two qualifiers with 8 matches in the database — yet the number
// looks identical. That is the single most misleading thing a predictor can do.
//
// So alongside every probability we report how solid it is, from three things we
// actually know:
//
//   1. How many matches back the ratings (overall, and on THIS surface).
//   2. How stale the player's data is (a rating from two years ago describes a
//      player who may no longer exist).
//
// From those we derive an uncertainty band in percentage points. The chain is:
//
//   σ_rating ≈ C / √(n + 1)          rating noise shrinks with matches played
//   σ_gap     = √(σ₁² + σ₂²)         the two players' noise adds in quadrature
//   dP/dgap   = scale · ln10/400 · p(1−p)    slope of the Elo curve at p
//   margin    = σ_gap · dP/dgap
//
// HONEST ABOUT WHAT THIS IS: it is a first-order error propagation with a
// hand-set noise scale (C), not a fitted Bayesian posterior — the ratings aren't
// tracked with a variance, so there is no exact σ to read off. The ORDER of the
// bands is what's validated: `npm run backtest` groups matches by reliability
// tier and prints the Brier score of each, so the claim "low reliability really
// is less accurate" is measured rather than asserted.
// ===========================================================================

import { CALIBRATION_SCALE } from './elo.ts';

/**
 * Rating noise in Elo points for a player with a single match. Everything scales
 * as C/√n from here: ~1 match → ±175, 25 matches → ±49, 100 → ±25, 500 → ±11.
 */
const ELO_SIGMA_C = 250;

/** Extra rating noise per year of staleness (capped), for a player who stopped. */
const STALE_SIGMA_PER_YEAR = 40;
const STALE_SIGMA_CAP = 120;

/** Must match SURFACE_WEIGHT in predict.ts: the rating is mostly surface-based. */
const SURFACE_WEIGHT = 0.7;

/** Below this many effective matches a rating is barely more than a guess. */
const MIN_MATCHES_FOR_ANY_CONFIDENCE = 10;
/** At/above this, and with a tight band, a prediction is treated as solid. */
const MATCHES_FOR_HIGH = 60;

const MARGIN_HIGH_MAX = 3.5; // pp — tighter than this counts as "high"
const MARGIN_LOW_MIN = 8; // pp — wider than this is "low" whatever the sample

const STALE_DAYS_HIGH_MAX = 180;
const STALE_DAYS_LOW_MIN = 365;

export type ReliabilityLevel = 'high' | 'medium' | 'low';

/** What we know about the evidence behind one player's rating. */
export interface PlayerDataDepth {
  /** Matches by this player in the history. */
  matches: number;
  /** Matches by this player on the surface being played. */
  surfaceMatches: number;
  /**
   * Days between this player's most recent match and the newest match in the
   * database. Measured against the data (not today) so a stale DOWNLOAD isn't
   * mistaken for a player who stopped competing.
   */
  daysStale: number | null;
}

export interface Reliability {
  level: ReliabilityLevel;
  /** Spanish label for the UI. */
  label: string;
  /** ± band on the probability, in percentage points (~1σ). */
  marginPp: number;
  /** The probability range implied by that band, as 0..1 (clamped). */
  range: { low: number; high: number };
  /** Plain-Spanish reasons, strongest first. Empty when nothing is lacking. */
  reasons: string[];
  /** Effective sample size behind each side's rating (surface-weighted). */
  effectiveMatches: { p1: number; p2: number };
}

/**
 * Effective sample behind the blended rating actually used for this match. The
 * rating is 70% surface / 30% overall, so the evidence is weighted the same way:
 * a clay specialist with 400 clay matches is well described on clay and poorly
 * described on grass, and this reflects that.
 */
function effectiveSample(d: PlayerDataDepth): number {
  return SURFACE_WEIGHT * d.surfaceMatches + (1 - SURFACE_WEIGHT) * d.matches;
}

function sigmaFor(d: PlayerDataDepth): number {
  const n = Math.max(0, effectiveSample(d));
  const sample = ELO_SIGMA_C / Math.sqrt(n + 1);
  const staleYears = (d.daysStale ?? 0) / 365;
  const stale = Math.min(staleYears * STALE_SIGMA_PER_YEAR, STALE_SIGMA_CAP);
  // Independent sources of error → add in quadrature.
  return Math.sqrt(sample * sample + stale * stale);
}

/**
 * Uncertainty band + tier for a prediction.
 *
 * @param prob1 the model probability being qualified (0..1)
 * @param d1 evidence behind player 1, @param d2 behind player 2
 * @param names used only to word the reasons
 */
export function computeReliability(
  prob1: number,
  d1: PlayerDataDepth,
  d2: PlayerDataDepth,
  names: { p1: string; p2: string },
): Reliability {
  const s1 = sigmaFor(d1);
  const s2 = sigmaFor(d2);
  const sigmaGap = Math.sqrt(s1 * s1 + s2 * s2);

  // Slope of the calibrated Elo curve at this probability: how many probability
  // points one Elo point of gap is worth here. Steepest near 50%, flat at the
  // extremes — which is why a wide rating band matters less for a 95% call.
  const slope = (CALIBRATION_SCALE * Math.LN10 * prob1 * (1 - prob1)) / 400;
  const marginPp = round1(Math.min(sigmaGap * slope * 100, 25));

  const n1 = effectiveSample(d1);
  const n2 = effectiveSample(d2);
  const worstN = Math.min(n1, n2);
  const worstStale = Math.max(d1.daysStale ?? 0, d2.daysStale ?? 0);

  const reasons: string[] = [];
  // Name the weaker side explicitly — "poca información" is useless if the user
  // can't tell WHICH player it applies to.
  for (const [d, name] of [
    [d1, names.p1],
    [d2, names.p2],
  ] as const) {
    const n = effectiveSample(d);
    if (d.matches < MIN_MATCHES_FOR_ANY_CONFIDENCE) {
      reasons.push(`${name} tiene solo ${d.matches} partido(s) en el historial.`);
    } else if (n < MATCHES_FOR_HIGH) {
      reasons.push(
        `Pocos partidos de ${name} en esta superficie (${d.surfaceMatches}); ` +
          `su Elo de superficie es poco estable.`,
      );
    }
    if ((d.daysStale ?? 0) >= STALE_DAYS_LOW_MIN) {
      reasons.push(
        `${name} llevaba ${humanGap(d.daysStale as number)} sin jugar al cierre de los datos: ` +
          `su Elo describe al jugador que era entonces, no necesariamente al de hoy.`,
      );
    }
  }

  let level: ReliabilityLevel;
  if (
    worstN < MIN_MATCHES_FOR_ANY_CONFIDENCE ||
    marginPp >= MARGIN_LOW_MIN ||
    worstStale >= STALE_DAYS_LOW_MIN
  ) {
    level = 'low';
  } else if (
    worstN >= MATCHES_FOR_HIGH &&
    marginPp <= MARGIN_HIGH_MAX &&
    worstStale <= STALE_DAYS_HIGH_MAX
  ) {
    level = 'high';
  } else {
    level = 'medium';
  }

  const label =
    level === 'high'
      ? 'fiabilidad alta'
      : level === 'medium'
        ? 'fiabilidad media'
        : 'fiabilidad baja';

  return {
    level,
    label,
    marginPp,
    range: {
      low: clamp01(prob1 - marginPp / 100),
      high: clamp01(prob1 + marginPp / 100),
    },
    reasons,
    effectiveMatches: { p1: Math.round(n1), p2: Math.round(n2) },
  };
}

/** A layoff in the largest unit that still reads naturally ("~4 años", not "229 meses"). */
function humanGap(days: number): string {
  const months = Math.round(days / 30);
  if (months < 24) return `~${months} meses`;
  const years = Math.round(days / 365);
  return years === 1 ? '~1 año' : `~${years} años`;
}

function clamp01(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100000) / 100000;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

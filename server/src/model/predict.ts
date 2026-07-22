// ===========================================================================
// PREDICTION = how the signals combine
// ===========================================================================
// Every signal is expressed in Elo points so the combination is transparent and
// auditable. For each player we build an "effective rating" for THIS match:
//
//   1. Surface blend:  R_eff = 0.7 * (surface Elo) + 0.3 * (overall Elo)
//      → mostly the surface rating, anchored by overall form/level.
//      (If the surface is unknown we fall back to overall only.)
//   2. + recent-form delta        (bounded, see form.ts)
//   3. + head-to-head delta       (bounded + shrunk, see h2h.ts; from p1's view)
//
//   model P(p1 wins) = expectedScore(R_eff_p1_adjusted, R_eff_p2_adjusted)
//
// Then we compare that against the vig-free market probability (market.ts) to
// flag agreement / possible value. The verdict names the favoured player and a
// confidence tier derived purely from how far the probability sits from 50%.
// ===========================================================================

import { expectedScore, surfaceKey } from './elo.ts';
import { computeForm, type FormSignal } from './form.ts';
import { computeH2H, type H2HSignal } from './h2h.ts';
import {
  compareToMarket,
  impliedProbabilities,
  type MarketComparison,
  type MarketProbabilities,
} from './market.ts';
import {
  getEloRank,
  getH2HMeetings,
  getPlayer,
  getRating,
  getRecentForm,
  getServeStats,
  getSurfaceRecord,
} from '../repo.ts';
import type { ServeStats, SurfaceRecord, TourId } from '../types.ts';

const SURFACE_WEIGHT = 0.7; // weight on surface Elo vs overall Elo

export const DISCLAIMER =
  'Estimación estadística basada en Elo, forma reciente, head-to-head y odds de mercado. ' +
  'NO considera lesiones de último momento, clima, cansancio ni motivación (p. ej. exhibiciones). ' +
  'No es una certeza ni una recomendación para apostar.';

export type ConfidenceTier = 'toss_up' | 'slight' | 'clear' | 'strong';

export interface EffectiveRating {
  overall: number;
  surface: number | null; // surface-specific Elo (null if surface unknown)
  surfaceKey: string | null;
  effective: number; // blended, pre-adjustment
}

export interface PlayerLite {
  id: number;
  name: string;
  country: string | null;
}

/** One driver of the verdict, expressed as Elo points in favour of p1 (signed). */
export interface ReasoningFactor {
  key: 'rating' | 'form' | 'h2h';
  label: string;
  pointsForP1: number;
}

export interface Reasoning {
  factors: ReasoningFactor[];
  topFactor: ReasoningFactor | null;
  text: string; // plain-language summary (Spanish)
}

export interface ExpectedScore {
  favoredSide: 1 | 2 | null;
  likelySets: string; // e.g. "2-0", "3-1"
  note: string;
}

export interface Prediction {
  tour: TourId;
  surface: string;
  players: { p1: PlayerLite; p2: PlayerLite };
  ratings: { p1: EffectiveRating; p2: EffectiveRating };
  ranks: { p1: number; p2: number }; // rank by overall Elo within the tour
  form: { p1: FormSignal; p2: FormSignal };
  last5: { p1: boolean[]; p2: boolean[] }; // most recent first (true = win)
  surfaceRecord: { p1: SurfaceRecord; p2: SurfaceRecord };
  serve: { p1: ServeStats; p2: ServeStats };
  h2h: H2HSignal; // deltas expressed from p1's perspective
  adjustedRatings: { p1: number; p2: number };
  model: { prob1: number; prob2: number };
  market: MarketComparison;
  reasoning: Reasoning;
  expectedScore: ExpectedScore;
  verdict: {
    favoredSide: 1 | 2 | null;
    favoredName: string | null;
    confidence: ConfidenceTier;
    marginPct: number; // |prob − 50%| in percentage points
  };
  disclaimer: string;
}

function effectiveRating(
  rating: { overall: number; hard: number; clay: number; grass: number },
  surface: string,
): EffectiveRating {
  const sk = surfaceKey(surface);
  if (!sk) {
    return { overall: rating.overall, surface: null, surfaceKey: null, effective: rating.overall };
  }
  const surfaceElo = rating[sk];
  const effective = SURFACE_WEIGHT * surfaceElo + (1 - SURFACE_WEIGHT) * rating.overall;
  return {
    overall: rating.overall,
    surface: surfaceElo,
    surfaceKey: sk,
    effective: Math.round(effective * 10) / 10,
  };
}

function confidenceTier(prob1: number): ConfidenceTier {
  const gap = Math.abs(prob1 - 0.5);
  if (gap < 0.05) return 'toss_up';
  if (gap < 0.12) return 'slight';
  if (gap < 0.25) return 'clear';
  return 'strong';
}

/**
 * Break the adjusted-rating gap into its drivers so we can explain WHY the model
 * favours someone. Each factor is the points it contributes to the gap in p1's
 * favour: gap = (rating) + (form) + (h2h).
 */
function buildReasoning(
  p1Name: string,
  p2Name: string,
  ratingGap: number, // eff1 - eff2
  formGap: number, // form1.delta - form2.delta
  h2hGap: number, // 2 * h2h.delta
): Reasoning {
  const factors: ReasoningFactor[] = [
    { key: 'rating', label: 'Elo (nivel + superficie)', pointsForP1: round1(ratingGap) },
    { key: 'form', label: 'Forma reciente', pointsForP1: round1(formGap) },
    { key: 'h2h', label: 'Head-to-head', pointsForP1: round1(h2hGap) },
  ];
  const ranked = [...factors].sort((a, b) => Math.abs(b.pointsForP1) - Math.abs(a.pointsForP1));
  const top = ranked[0];
  const totalGap = ratingGap + formGap + h2hGap;
  const favored = totalGap >= 0 ? p1Name : p2Name;

  let text: string;
  if (!top || Math.abs(top.pointsForP1) < 1) {
    text = 'Ambos jugadores están muy igualados en todas las señales.';
  } else {
    const driverName = top.pointsForP1 >= 0 ? p1Name : p2Name;
    const agrees = driverName === favored;
    text = agrees
      ? `El modelo favorece a ${favored}; la señal que más pesa es su ventaja en ${top.label.toLowerCase()}.`
      : `El modelo favorece ligeramente a ${favored}, aunque en ${top.label.toLowerCase()} ` +
        `la ventaja es para ${driverName}.`;
  }
  return { factors, topFactor: top ?? null, text };
}

/** Rough scoreline estimate from the win probability. Honest: it's a heuristic. */
function estimateScoreline(prob1: number, bestOf: number | null): ExpectedScore {
  const favoredSide: 1 | 2 | null = prob1 === 0.5 ? null : prob1 > 0.5 ? 1 : 2;
  const pWin = Math.max(prob1, 1 - prob1);
  const setsToWin = bestOf === 5 ? 3 : 2;
  let likelySets: string;
  let note: string;
  if (pWin >= 0.75) {
    likelySets = `${setsToWin}-0`;
    note = 'Probablemente en sets corridos.';
  } else if (pWin >= 0.6) {
    likelySets = `${setsToWin}-1`;
    note = 'Favorito, pero puede ceder un set.';
  } else {
    likelySets = `${setsToWin}-${setsToWin - 1}`;
    note = 'Muy parejo: puede irse a set decisivo.';
  }
  return { favoredSide, likelySets, note };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build a full, explainable prediction between two players on a given surface.
 * `market` is optional decimal odds {odds1, odds2} for the same p1/p2 order.
 */
export function buildPrediction(
  tour: TourId,
  p1Id: number,
  p2Id: number,
  surface: string,
  market?: { odds1: number | null; odds2: number | null } | null,
  bestOf = 3,
): Prediction {
  const p1 = getPlayer(tour, p1Id);
  const p2 = getPlayer(tour, p2Id);
  const r1 = getRating(tour, p1Id);
  const r2 = getRating(tour, p2Id);

  const eff1 = effectiveRating(r1, surface);
  const eff2 = effectiveRating(r2, surface);

  const form1Results = getRecentForm(tour, p1Id);
  const form2Results = getRecentForm(tour, p2Id);
  const form1 = computeForm(form1Results);
  const form2 = computeForm(form2Results);

  const h2h = computeH2H(getH2HMeetings(tour, p1Id, p2Id), p1Id, p2Id);

  // Combine: effective rating + form + head-to-head (h2h.delta favours p1).
  const adj1 = eff1.effective + form1.delta + h2h.delta;
  const adj2 = eff2.effective + form2.delta - h2h.delta;

  const prob1 = expectedScore(adj1, adj2);
  const prob2 = 1 - prob1;

  let marketProbs: MarketProbabilities | null = null;
  if (market && market.odds1 && market.odds2) {
    marketProbs = impliedProbabilities(market.odds1, market.odds2);
  }
  const marketComparison = compareToMarket(prob1, marketProbs);

  const favoredSide: 1 | 2 | null = prob1 === 0.5 ? null : prob1 > 0.5 ? 1 : 2;
  const favoredName = favoredSide === 1 ? p1?.name ?? null : favoredSide === 2 ? p2?.name ?? null : null;

  const p1Name = p1?.name ?? `#${p1Id}`;
  const p2Name = p2?.name ?? `#${p2Id}`;
  const reasoning = buildReasoning(
    p1Name,
    p2Name,
    eff1.effective - eff2.effective,
    form1.delta - form2.delta,
    2 * h2h.delta,
  );

  return {
    tour,
    surface,
    players: {
      p1: { id: p1Id, name: p1Name, country: p1?.country ?? null },
      p2: { id: p2Id, name: p2Name, country: p2?.country ?? null },
    },
    ratings: { p1: eff1, p2: eff2 },
    ranks: { p1: getEloRank(tour, p1Id), p2: getEloRank(tour, p2Id) },
    form: { p1: form1, p2: form2 },
    last5: {
      p1: form1Results.slice(0, 5).map((r) => r.won),
      p2: form2Results.slice(0, 5).map((r) => r.won),
    },
    surfaceRecord: {
      p1: getSurfaceRecord(tour, p1Id, surface),
      p2: getSurfaceRecord(tour, p2Id, surface),
    },
    serve: { p1: getServeStats(tour, p1Id), p2: getServeStats(tour, p2Id) },
    h2h,
    adjustedRatings: { p1: Math.round(adj1 * 10) / 10, p2: Math.round(adj2 * 10) / 10 },
    model: { prob1: round3(prob1), prob2: round3(prob2) },
    market: marketComparison,
    reasoning,
    expectedScore: estimateScoreline(prob1, bestOf),
    verdict: {
      favoredSide,
      favoredName,
      confidence: confidenceTier(prob1),
      marginPct: Math.round(Math.abs(prob1 - 0.5) * 1000) / 10,
    },
    disclaimer: DISCLAIMER,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

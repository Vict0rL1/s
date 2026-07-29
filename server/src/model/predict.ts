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

/** Plain-language "what is most likely to happen" for this match. */
export interface MatchSummary {
  headline: string;
  bullets: string[];
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
  summary: MatchSummary;
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

const SURFACE_ES: Record<string, string> = { hard: 'dura', clay: 'arcilla', grass: 'hierba' };

/**
 * Write the "what's most likely to happen" summary in plain Spanish. Everything
 * here restates numbers already computed above — no new modelling — so the text
 * can never disagree with the figures shown next to it. Uncertainty is stated
 * explicitly (a coin-flip is described as such, not dressed up as a pick).
 */
function buildSummary(args: {
  p1: string;
  p2: string;
  prob1: number;
  confidence: ConfidenceTier;
  expected: ExpectedScore;
  surface: string;
  eff1: EffectiveRating;
  eff2: EffectiveRating;
  form1: FormSignal;
  form2: FormSignal;
  h2h: H2HSignal;
  serve1: ServeStats;
  serve2: ServeStats;
  rec1: SurfaceRecord;
  rec2: SurfaceRecord;
  market: MarketComparison;
}): MatchSummary {
  const { p1, p2, prob1, confidence, expected, h2h, market } = args;
  const favIsP1 = prob1 >= 0.5;
  const fav = favIsP1 ? p1 : p2;
  const dog = favIsP1 ? p2 : p1;
  const favProb = Math.round(Math.max(prob1, 1 - prob1) * 100);
  const surfName = SURFACE_ES[args.surface.toLowerCase()] ?? args.surface.toLowerCase();

  // --- Headline ---
  const headline =
    confidence === 'toss_up'
      ? `Partido muy parejo: ligerísima ventaja para ${fav} (${favProb}%–${100 - favProb}%). ` +
        `Cualquiera de los dos puede ganar.`
      : `Lo más probable: gana ${fav} (${favProb}%), ` +
        `${expected.likelySets} en sets. ${expected.note}`;

  const bullets: string[] = [];

  // --- Surface / rating ---
  const favEff = favIsP1 ? args.eff1 : args.eff2;
  const dogEff = favIsP1 ? args.eff2 : args.eff1;
  if (favEff.surface != null && dogEff.surface != null) {
    // Judge "who is better" on the very numbers shown, so the words can't
    // contradict the figures (a 2-point gap is not an advantage).
    const favS = Math.round(favEff.surface);
    const dogS = Math.round(dogEff.surface);
    const leader = favS >= dogS ? fav : dog;
    bullets.push(
      Math.abs(favS - dogS) >= 25
        ? `En ${surfName}, ${leader} llega con mejor Elo (${Math.max(favS, dogS)} vs ${Math.min(favS, dogS)}).`
        : `Nivel muy parejo en ${surfName} (${favS} vs ${dogS}); la ventaja viene de otras señales.`,
    );
  } else {
    bullets.push(
      `Superficie no identificada: la predicción usa el Elo general (${Math.round(favEff.overall)} vs ${Math.round(dogEff.overall)}).`,
    );
  }

  // --- Surface record ---
  const favRec = favIsP1 ? args.rec1 : args.rec2;
  const dogRec = favIsP1 ? args.rec2 : args.rec1;
  if (favRec.wins + favRec.losses >= 5 && dogRec.wins + dogRec.losses >= 5) {
    bullets.push(
      `Historial en ${surfName}: ${fav} ${favRec.wins}–${favRec.losses}, ${dog} ${dogRec.wins}–${dogRec.losses}.`,
    );
  }

  // --- Form ---
  const favForm = favIsP1 ? args.form1 : args.form2;
  const dogForm = favIsP1 ? args.form2 : args.form1;
  const streakTxt = (f: FormSignal, who: string) =>
    f.streak >= 2
      ? `${who} llega con ${f.streak} victorias seguidas`
      : f.streak <= -2
        ? `${who} llega con ${-f.streak} derrotas seguidas`
        : null;
  const favStreak = streakTxt(favForm, fav);
  const dogStreak = streakTxt(dogForm, dog);
  if (favStreak || dogStreak) {
    bullets.push(`Forma: ${[favStreak, dogStreak].filter(Boolean).join('; ')}.`);
  } else {
    bullets.push(
      `Forma reciente parecida (${Math.round(favForm.winRate * 100)}% vs ${Math.round(dogForm.winRate * 100)}% de victorias).`,
    );
  }

  // --- Head-to-head ---
  if (h2h.total === 0) {
    bullets.push('Nunca se han enfrentado, así que no hay historial directo que pese.');
  } else {
    const favWins = favIsP1 ? h2h.p1Wins : h2h.p2Wins;
    const dogWins = favIsP1 ? h2h.p2Wins : h2h.p1Wins;
    const leader = favWins > dogWins ? fav : dog;
    const hi = Math.max(favWins, dogWins);
    const lo = Math.min(favWins, dogWins);
    if (favWins === dogWins) {
      bullets.push(`El head-to-head está igualado ${hi}–${lo} en ${h2h.total} enfrentamientos.`);
    } else if (h2h.total <= 2) {
      // One or two meetings is anecdote, not dominance — say it plainly.
      bullets.push(
        `Solo se han enfrentado ${h2h.total} ${h2h.total === 1 ? 'vez' : 'veces'} ` +
          `(ganó ${leader}): poco peso en la predicción.`,
      );
    } else {
      bullets.push(
        hi - lo >= 2
          ? `${leader} domina el head-to-head ${hi}–${lo}.`
          : `El head-to-head está muy ajustado (${hi}–${lo} para ${leader}).`,
      );
    }
  }

  // --- Serve edge ---
  const favServe = favIsP1 ? args.serve1 : args.serve2;
  const dogServe = favIsP1 ? args.serve2 : args.serve1;
  if (favServe.acePct != null && dogServe.acePct != null) {
    const diff = favServe.acePct - dogServe.acePct;
    if (Math.abs(diff) >= 3) {
      const better = diff > 0 ? fav : dog;
      bullets.push(
        `${better} tiene el saque más fuerte (${Math.max(favServe.acePct, dogServe.acePct)}% de aces vs ${Math.min(favServe.acePct, dogServe.acePct)}%).`,
      );
    }
  }

  // --- Market agreement ---
  if (market.market) {
    const marketFavProb = Math.round((favIsP1 ? market.market.implied1 : market.market.implied2) * 100);
    const gap = favProb - marketFavProb;
    if (Math.abs(gap) < 5) {
      bullets.push(`Las casas de apuestas coinciden (${marketFavProb}% para ${fav}).`);
    } else if (gap > 0) {
      bullets.push(
        `El modelo es más optimista con ${fav} (${favProb}%) que el mercado (${marketFavProb}%): posible value en ${fav}.`,
      );
    } else {
      bullets.push(
        `El mercado ve a ${fav} más favorito (${marketFavProb}%) que el modelo (${favProb}%): el valor estaría en ${dog}.`,
      );
    }
  } else {
    bullets.push('Sin cuotas disponibles para comparar con el mercado.');
  }

  return { headline, bullets };
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

  const confidence = confidenceTier(prob1);
  const expected = estimateScoreline(prob1, bestOf);
  const serve1 = getServeStats(tour, p1Id);
  const serve2 = getServeStats(tour, p2Id);
  const rec1 = getSurfaceRecord(tour, p1Id, surface);
  const rec2 = getSurfaceRecord(tour, p2Id, surface);
  const summary = buildSummary({
    p1: p1Name,
    p2: p2Name,
    prob1,
    confidence,
    expected,
    surface,
    eff1,
    eff2,
    form1,
    form2,
    h2h,
    serve1,
    serve2,
    rec1,
    rec2,
    market: marketComparison,
  });

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
    surfaceRecord: { p1: rec1, p2: rec2 },
    serve: { p1: serve1, p2: serve2 },
    h2h,
    adjustedRatings: { p1: Math.round(adj1 * 10) / 10, p2: Math.round(adj2 * 10) / 10 },
    model: { prob1: round3(prob1), prob2: round3(prob2) },
    market: marketComparison,
    reasoning,
    expectedScore: expected,
    summary,
    verdict: {
      favoredSide,
      favoredName,
      confidence,
      marginPct: Math.round(Math.abs(prob1 - 0.5) * 1000) / 10,
    },
    disclaimer: DISCLAIMER,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

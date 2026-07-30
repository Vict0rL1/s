// ---------------------------------------------------------------------------
// MARKET ODDS → IMPLIED PROBABILITY
// ---------------------------------------------------------------------------
// Bookmakers quote decimal odds. The naive implied probability is 1/odds, but
// the two sides always sum to MORE than 100% — that surplus is the bookmaker's
// margin ("vig" / "overround"). We remove it by normalising the two sides so
// they sum to 100%, giving the market's true implied probability.
//
//   raw_i      = 1 / odds_i
//   overround  = raw_1 + raw_2            (e.g. 1.05 → 5% margin)
//   implied_i  = raw_i / overround        (vig-free, sums to 1)
//
// "Value" = model probability − market probability. A large positive gap means
// the model thinks a side is more likely than the market prices it — a possible
// edge. (See the honesty note in docs/MODEL.md before acting on it.)
// ---------------------------------------------------------------------------

export const VALUE_THRESHOLD = 0.05; // 5 percentage points

export interface MarketProbabilities {
  odds1: number;
  odds2: number;
  implied1: number; // vig-free probability for player 1
  implied2: number;
  overround: number; // bookmaker margin, e.g. 1.045
}

/** Convert a two-way decimal-odds market into vig-free implied probabilities. */
export function impliedProbabilities(odds1: number, odds2: number): MarketProbabilities | null {
  if (!(odds1 > 1) || !(odds2 > 1)) return null;
  const raw1 = 1 / odds1;
  const raw2 = 1 / odds2;
  const overround = raw1 + raw2;
  // Round one side and derive the other so the pair always sums to exactly 1 —
  // rounding both independently can yield 50.0%/50.1% and undermine the figures
  // shown side by side. 5 decimals keeps far more resolution than we display.
  const implied1 = round5(raw1 / overround);
  return {
    odds1,
    odds2,
    implied1,
    implied2: round5(1 - implied1),
    overround: Math.round(overround * 100000) / 100000,
  };
}

function round5(n: number): number {
  return Math.round(n * 100000) / 100000;
}

export type ValueVerdict = 'value_p1' | 'value_p2' | 'agree' | 'no_market';

export interface MarketComparison {
  market: MarketProbabilities | null;
  edge1: number | null; // model prob − market prob for player 1 (signed)
  verdict: ValueVerdict;
}

/** Compare the model's probability for p1 against the vig-free market probability. */
export function compareToMarket(
  modelProb1: number,
  market: MarketProbabilities | null,
): MarketComparison {
  if (!market) return { market: null, edge1: null, verdict: 'no_market' };
  const edge1 = modelProb1 - market.implied1;
  let verdict: ValueVerdict = 'agree';
  if (edge1 >= VALUE_THRESHOLD) verdict = 'value_p1';
  else if (edge1 <= -VALUE_THRESHOLD) verdict = 'value_p2';
  return { market, edge1: round5(edge1), verdict };
}

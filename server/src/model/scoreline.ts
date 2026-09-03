// ===========================================================================
// SCORELINE DISTRIBUTION — "what is most likely to happen", with real numbers
// ===========================================================================
// The model produces one number: P(player 1 wins the match). From it we can
// derive the probability of each possible scoreline, instead of guessing.
//
// Step 1 — recover the per-set probability `p`.
//   A best-of-3 match is won by taking 2 sets:
//     P(match) = p² + 2p²(1−p)          = p²(3 − 2p)
//   A best-of-5 needs 3 sets:
//     P(match) = p³ + 3p³(1−p) + 6p³(1−p)²
//   Both are strictly increasing in p, so we invert them by bisection.
//
// Step 2 — expand the scorelines from that same `p`:
//   best-of-3:  2-0 = p²            2-1 = 2p²(1−p)
//   best-of-5:  3-0 = p³            3-1 = 3p³(1−p)      3-2 = 6p³(1−p)²
//
// SIMPLIFYING ASSUMPTION (stated plainly): sets are treated as independent and
// identically distributed. Real tennis has momentum, and serving order matters,
// so treat these as well-grounded estimates, not exact truths. They do sum to
// the model's match probability by construction, which keeps the display
// coherent with the headline number.
// ===========================================================================

/** Probability of winning a best-of-N match given a per-set probability. */
function matchProbFromSetProb(p: number, bestOf: number): number {
  if (bestOf === 5) {
    const q = 1 - p;
    return p ** 3 * (1 + 3 * q + 6 * q * q);
  }
  return p * p * (3 - 2 * p);
}

/** Invert the above: find the per-set probability implied by a match probability. */
export function setProbFromMatchProb(matchProb: number, bestOf: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (matchProbFromSetProb(mid, bestOf) < matchProb) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ScorelineOutcome {
  /** 1 or 2 — which player wins with this scoreline. */
  side: 1 | 2;
  label: string; // e.g. "2-1"
  probability: number; // 0..1
}

export interface ScorelineDistribution {
  bestOf: number;
  setProb1: number; // p1's probability of taking any given set
  outcomes: ScorelineOutcome[]; // every possible scoreline, most likely first
  /** Probability the match goes the full distance (3rd or 5th set). */
  decidingSetProbability: number;
  /** Probability the favourite wins without dropping a set. */
  straightSetsProbability: number;
}

/**
 * Full scoreline distribution for a match, derived from the model's probability.
 * `prob1` is P(player 1 wins).
 */
export function scorelineDistribution(prob1: number, bestOf: number): ScorelineDistribution {
  const n = bestOf === 5 ? 5 : 3;
  const p = setProbFromMatchProb(prob1, n);
  const q = 1 - p;

  const outcomes: ScorelineOutcome[] = [];
  if (n === 3) {
    outcomes.push({ side: 1, label: '2-0', probability: p * p });
    outcomes.push({ side: 1, label: '2-1', probability: 2 * p * p * q });
    outcomes.push({ side: 2, label: '0-2', probability: q * q });
    outcomes.push({ side: 2, label: '1-2', probability: 2 * q * q * p });
  } else {
    outcomes.push({ side: 1, label: '3-0', probability: p ** 3 });
    outcomes.push({ side: 1, label: '3-1', probability: 3 * p ** 3 * q });
    outcomes.push({ side: 1, label: '3-2', probability: 6 * p ** 3 * q * q });
    outcomes.push({ side: 2, label: '0-3', probability: q ** 3 });
    outcomes.push({ side: 2, label: '1-3', probability: 3 * q ** 3 * p });
    outcomes.push({ side: 2, label: '2-3', probability: 6 * q ** 3 * p * p });
  }

  outcomes.sort((a, b) => b.probability - a.probability);

  // Deciding set = the loser of the match still took (sets-to-win − 1) sets:
  //   best-of-3 → 2pq          best-of-5 → 6p²q²
  const decidingSet = n === 3 ? 2 * p * q : 6 * p * p * q * q;
  const favP = Math.max(p, q);
  const straight = n === 3 ? favP * favP : favP ** 3;

  return {
    bestOf: n,
    setProb1: round4(p),
    outcomes: outcomes.map((o) => ({ ...o, probability: round4(o.probability) })),
    decidingSetProbability: round4(decidingSet),
    straightSetsProbability: round4(straight),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

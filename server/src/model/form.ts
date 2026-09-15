// ---------------------------------------------------------------------------
// RECENT FORM
// ---------------------------------------------------------------------------
// A player's rating is a long-run average; "form" captures whether they are
// hot or cold *right now*. We look at the last N matches, weight the most recent
// ones more (exponential decay), and turn the weighted win-rate into a small,
// bounded Elo adjustment. It is intentionally small: form nudges the prediction,
// it does not dominate the rating.
// ---------------------------------------------------------------------------

/** Max Elo points form can add or subtract. Keeps it a nudge, not a takeover. */
export const FORM_MAX_DELTA = 40;
const FORM_WINDOW = 10; // matches considered
const DECAY = 0.85; // weight multiplier per step further back in time

export interface FormResult {
  won: boolean;
  date: string; // YYYYMMDD
}

export interface FormSignal {
  sampleSize: number;
  winRate: number; // plain win rate over the window (0..1)
  weightedWinRate: number; // recency-weighted (0..1)
  streak: number; // +n = n wins in a row, -n = n losses in a row (most recent)
  delta: number; // Elo points to add for this player
}

/**
 * @param results recent matches for one player, MOST RECENT FIRST.
 */
export function computeForm(results: FormResult[]): FormSignal {
  const window = results.slice(0, FORM_WINDOW);
  if (window.length === 0) {
    return { sampleSize: 0, winRate: 0.5, weightedWinRate: 0.5, streak: 0, delta: 0 };
  }

  let wins = 0;
  let weightedWins = 0;
  let weightTotal = 0;
  window.forEach((r, i) => {
    const w = Math.pow(DECAY, i); // i=0 is the most recent
    if (r.won) {
      wins += 1;
      weightedWins += w;
    }
    weightTotal += w;
  });

  const winRate = wins / window.length;
  const weightedWinRate = weightedWins / weightTotal;

  // Streak: walk from the most recent match while the outcome stays the same.
  let streak = 0;
  const first = window[0].won;
  for (const r of window) {
    if (r.won === first) streak += 1;
    else break;
  }
  streak = first ? streak : -streak;

  // Center on 0.5 (average form → 0 delta) and scale to the bounded range.
  const raw = (weightedWinRate - 0.5) * (FORM_MAX_DELTA * 2);
  const delta = clamp(raw, -FORM_MAX_DELTA, FORM_MAX_DELTA);

  return {
    sampleSize: window.length,
    winRate: round(winRate),
    weightedWinRate: round(weightedWinRate),
    streak,
    delta: Math.round(delta * 10) / 10,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

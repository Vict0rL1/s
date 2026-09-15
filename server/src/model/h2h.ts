// ---------------------------------------------------------------------------
// HEAD-TO-HEAD (H2H)
// ---------------------------------------------------------------------------
// Some players consistently trouble specific opponents in ways ratings miss
// (style match-ups). We fold the direct H2H record into a small Elo delta, but
// SHRINK it toward zero when there are few meetings — 1 win in 1 meeting is
// almost noise, 8 wins in 10 is a real signal. Shrinkage = n / (n + K).
// ---------------------------------------------------------------------------

export const H2H_MAX_DELTA = 35;
const SHRINK_K = 4; // meetings needed before H2H carries ~half its weight

export interface H2HMeeting {
  date: string; // YYYYMMDD
  winnerId: number;
  tourney_name: string | null;
  surface: string | null;
  round: string | null;
  score: string | null;
}

export interface H2HSignal {
  total: number;
  p1Wins: number;
  p2Wins: number;
  /** Elo delta applied to player 1 (positive favours p1). p2 gets the negative. */
  delta: number;
  recent: H2HMeeting[]; // most recent first, capped
}

/**
 * @param meetings every match these two have played, any order.
 * @param p1Id     player 1's id (the delta is expressed from p1's perspective).
 */
export function computeH2H(meetings: H2HMeeting[], p1Id: number, p2Id: number): H2HSignal {
  const relevant = meetings.filter(
    (m) =>
      (m.winnerId === p1Id || m.winnerId === p2Id),
  );
  const p1Wins = relevant.filter((m) => m.winnerId === p1Id).length;
  const p2Wins = relevant.filter((m) => m.winnerId === p2Id).length;
  const total = p1Wins + p2Wins;

  let delta = 0;
  if (total > 0) {
    const p1Rate = p1Wins / total; // 0..1
    const shrink = total / (total + SHRINK_K); // 0..1, grows with sample size
    delta = (p1Rate - 0.5) * (H2H_MAX_DELTA * 2) * shrink;
    delta = Math.max(-H2H_MAX_DELTA, Math.min(H2H_MAX_DELTA, delta));
  }

  const recent = [...relevant]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 5);

  return {
    total,
    p1Wins,
    p2Wins,
    delta: Math.round(delta * 10) / 10,
    recent,
  };
}

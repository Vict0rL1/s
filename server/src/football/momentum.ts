// ===========================================================================
// MOMENTUM AND THE CALENDAR — "el momento" of a team
// ===========================================================================
// Elo is a long memory. That is its virtue and its blind spot: a side that has
// been transformed since October still carries October in its rating, because a
// fixed K-factor only lets each result move it so far.
//
// Two things are meant by "a team's moment", and they are NOT the same thing, so
// they are modelled and MEASURED separately:
//
//   1. FORM — is this team currently playing above or below its own rating?
//      Note the "its own": raw recent results are almost useless here, because
//      four wins over the bottom four say nothing. What counts is the SURPRISE —
//      results against what the rating expected, which is exactly the quantity
//      Elo already computes and then throws away after using it once.
//
//   2. THE CALENDAR — a side playing its third match in seven days is not the
//      same side. Congestion is real, physical and, unlike form, has nothing to
//      do with how well the team has been playing.
//
// Both are honest candidates and both are easy to fool yourself about. Form in
// particular is largely REDUNDANT with Elo by construction — Elo is itself an
// accumulation of surprises — so it will only earn its place if the backtest says
// so. `--momentum 0` and `--rest 0` switch each off, and docs/FOOTBALL.md reports
// what each one was actually worth.
// ===========================================================================

export interface MomentumState {
  /**
   * EWMA of (actual result − Elo expectation), in [−1, 1].
   *
   * Positive means the team has been beating its own rating; that is a claim
   * about the rating being stale, not about the opponents being weak.
   */
  surprise: number;
  /** Date of the previous match, YYYYMMDD. */
  lastDate: string | null;
}

/**
 * How fast the surprise EWMA forgets.
 *
 * 0.25 gives a half-life of about 2.5 matches, so "form" means the last month or
 * so, not the last half-season. A slower one just re-derives the Elo.
 */
export const MOMENTUM_ALPHA = 0.25;

/**
 * Elo points a sustained surprise of +1 is worth — and the verdict on form.
 *
 * ZERO, MEASURED. On 17.200 matches, every non-zero weight made the forecast
 * worse, monotonically:
 *
 *   peso   0 →  RPS 0.20630     (nada)
 *         15 →  RPS 0.20640
 *         30 →  RPS 0.20659
 *         70 →  RPS 0.20752
 *
 * That shape — no peak, just steady damage — is what a redundant signal looks
 * like. It is also exactly what should have been expected: Elo IS an accumulated
 * surprise. Adding a faster-moving copy of it on top does not tell the model
 * anything new, it just doubles the weight on the last five matches. "This team
 * is on a run" is real; it has already been priced into the rating.
 *
 * Kept, with `--momentum`, so the finding can be re-run rather than believed.
 */
export const MOMENTUM_ELO = 0;

export function freshMomentum(): MomentumState {
  return { surprise: 0, lastDate: null };
}

/** Fold one result into the EWMA. `actual` is 1 / 0.5 / 0, `expected` is the Elo expectation. */
export function updateMomentum(
  state: MomentumState,
  actual: number,
  expected: number,
  date: string,
  alpha = MOMENTUM_ALPHA,
): void {
  state.surprise = state.surprise * (1 - alpha) + alpha * (actual - expected) * 2;
  state.lastDate = date;
}

/** The Elo bonus a team's current form is worth. */
export function momentumElo(state: MomentumState, weight = MOMENTUM_ELO): number {
  return clamp(state.surprise, -1, 1) * weight;
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------
/** A normal league week. At or above this, rest is a non-issue. */
export const NORMAL_REST_DAYS = 6;
/** Below this there is no more penalty to add — the squad is as stretched as it gets. */
export const MIN_REST_DAYS = 2;
/**
 * Elo points lost at full congestion — also zero, also measured.
 *
 * This one is worth being careful about, because "no effect" and "no data" look
 * identical in a table and only one of them is a finding. Here there is plenty of
 * data: in this corpus **15.3% of team-matches are played on three days' rest or
 * fewer, and 26.5% on four or fewer** — Boxing Day, midweek league rounds, the
 * Spanish and German winter fixtures. So congestion is well represented, and at
 * every weight tried it still moved RPS by less than 0.0001 (0.20630 → 0.20632 at
 * 15 Elo, → 0.20636 at 30).
 *
 * The honest reading is not "fatigue is a myth" but "the fatigue this corpus can
 * see is already in the rating". What it CANNOT see is the interesting case: a
 * side that played a Champions League tie on Wednesday and rotated eight players
 * on Saturday. That is a lineup fact, not a calendar fact — see players.ts.
 *
 * Kept behind `--rest`.
 */
export const CONGESTION_ELO = 0;

/**
 * Beyond this, a gap is a break rather than rest: the winter shutdown, an
 * international window, the start of a season. Teams come back rusty rather than
 * fresh, so the adjustment returns to neutral instead of growing without bound.
 *
 * Getting this wrong is how a model ends up claiming a side is unbeatable because
 * it has had four thousand days off.
 */
export const LONG_BREAK_DAYS = 21;

export function daysBetween(from: string, to: string): number {
  const parse = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * Elo adjustment for how much rest a side has had. Zero or negative — rest is
 * never a bonus here, only its absence is a penalty.
 */
export function restAdjustment(daysRest: number | null, weight = CONGESTION_ELO): number {
  if (daysRest == null || weight === 0) return 0;
  if (daysRest >= NORMAL_REST_DAYS || daysRest >= LONG_BREAK_DAYS) return 0;
  const d = Math.max(MIN_REST_DAYS, daysRest);
  // Linear from no penalty at NORMAL_REST_DAYS to the full weight at MIN_REST_DAYS.
  const severity = (NORMAL_REST_DAYS - d) / (NORMAL_REST_DAYS - MIN_REST_DAYS);
  return -weight * severity;
}

/** Human wording for the breakdown panel. */
export function describeRest(daysRest: number | null): string | null {
  if (daysRest == null) return null;
  if (daysRest >= LONG_BREAK_DAYS) return `${daysRest} días sin jugar (parón, no descanso)`;
  if (daysRest >= NORMAL_REST_DAYS) return `${daysRest} días de descanso (semana normal)`;
  return `solo ${daysRest} días desde su último partido`;
}

export function describeMomentum(state: MomentumState): string {
  const s = state.surprise;
  if (Math.abs(s) < 0.08) return 'rinde justo lo que dice su Elo';
  if (s > 0.3) return 'muy por encima de su Elo en las últimas jornadas';
  if (s > 0) return 'algo por encima de su Elo últimamente';
  if (s > -0.3) return 'algo por debajo de su Elo últimamente';
  return 'muy por debajo de su Elo en las últimas jornadas';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

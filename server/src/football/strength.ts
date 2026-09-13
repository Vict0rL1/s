// ===========================================================================
// ATTACK AND DEFENCE STRENGTH — the goals model proper
// ===========================================================================
// Elo answers one question: how good is this team? It compresses everything
// into a single number, and in doing so it throws away HOW a team is good.
//
// Two clubs on 1650 Elo can be completely different objects. One wins 1-0 every
// week with a wall for a defence; the other wins 3-2. Feeding both into the same
// Elo→goals curve gives them the same scoreline distribution, which is wrong for
// both — and the exact-score, over/under and both-teams-to-score markets are made
// almost entirely of that difference.
//
// So each team carries two multipliers on top of its rating:
//
//   attack  > 1  → scores more than its rating alone would suggest
//   defence > 1  → concedes more than its rating alone would suggest
//
//   λ_home = base_home · tilt(Elo) · attack_home · defence_away
//   λ_away = base_away / tilt(Elo) · attack_away · defence_home
//
// They are learned ONLINE from the residual — what the team actually scored
// divided by what the model expected it to score — so no extra data source is
// needed: the same match feed that trains the Elo trains these.
//
// TWO CHOICES THAT MATTER
//
// 1. The residual is split evenly between the scoring side's attack and the
//    conceding side's defence. A 4-0 does not tell you whether the attack was
//    exceptional or the defence was awful; splitting it is the honest reading,
//    and over a season the repeated evidence separates the two by itself.
//
// 2. Learning happens in LOG space with a pseudo-count. A 0-0 gives a raw ratio
//    of exactly zero, whose logarithm is −∞; without the pseudo-count one
//    goalless draw would erase a team's attack rating outright. `(goals + c) /
//    (λ + c)` keeps every update finite and damps the noise of a low-scoring
//    sport, where a single deflection is 100% of a 1-0.
//
// Every constant below is fitted by `npm run backtest:fb`, which can turn the
// whole layer off with `--attack 0`.
// ===========================================================================

export interface TeamStrength {
  /** Multiplier on goals scored. 1 = exactly what the rating predicts. */
  attack: number;
  /** Multiplier on goals conceded. 1 = exactly what the rating predicts. */
  defence: number;
}

/**
 * WHICH PART OF THE RESIDUAL TO LEARN.
 *
 * A match residual splits cleanly into two halves that mean different things:
 *
 *   shared part  — both sides scored more (or fewer) than expected. This is the
 *                  TEMPO of the fixture: how open the game was. Elo knows nothing
 *                  about it, because tempo does not decide who wins.
 *
 *   split part   — one side beat its expectation and the other missed theirs.
 *                  This is quality, and Elo is ALREADY an accumulation of exactly
 *                  this: the goal-difference-weighted update absorbs it match by
 *                  match. Learning it a second time here is double counting, and
 *                  it measurably shows up as worse forecasts.
 *
 * So the default keeps only the shared half. See docs/FOOTBALL.md for the numbers
 * that settled it; `--attack-mode full|tempo|style` reruns the comparison.
 */
export type StrengthMode = 'full' | 'tempo' | 'style';
export const STRENGTH_MODE: StrengthMode = 'tempo';

/**
 * EWMA learning rate on the log residual — and the verdict on this whole layer.
 *
 * IT IS ZERO, ON PURPOSE, BECAUSE IT WAS MEASURED AND IT DID NOT WORK.
 *
 * On 17.200 matches the best setting found (mode `full`, α = 0.02) trades one
 * metric for another and wins nothing overall:
 *
 *   RPS               0.20630 → 0.20611   better  (paired t = 2.97)
 *   error de goles    1.3239  → 1.3162    better
 *   marcador exacto   2.9131  → 2.9145    WORSE   (paired t = −2.27)
 *   over/under 2.5    53.1%   → 52.8%     worse
 *   ambos marcan      0.24889 → 0.24978   worse
 *
 * Two significant effects of ~0.1% pointing in opposite directions is the
 * signature of a knob fitting noise, not of a signal. And the metric it damages
 * — the likelihood of the score that actually happened — is precisely the one the
 * exact-score grid is made of, which is what this layer existed to improve.
 *
 * The reason is structural rather than a bug: the Elo update is already weighted
 * by goal difference, so the quality half of the residual has been learned once
 * before it gets here. Learning it twice extrapolates. Restricting the layer to
 * the half Elo genuinely cannot know (`tempo`) does not rescue it either —
 * team-level scoring tempo simply is not persistent enough from match to match.
 *
 * The code stays, and so does `--attack`, so the finding is reproducible rather
 * than a claim in a document. Set it above 0 to turn the layer back on.
 */
export const STRENGTH_ALPHA = 0;

/**
 * Pseudo-goals added to both sides of the residual ratio.
 *
 * Football is low-scoring enough that the raw ratio is violent: expecting 1.4 and
 * conceding 3 is a ratio of 2.14 off one deflection and one penalty. The
 * pseudo-count pulls every observation toward 1 by an amount that matters most
 * exactly where the sample is thinnest (0 and 1 goals).
 */
export const STRENGTH_PSEUDO = 1.0;

/**
 * Hard limits on either multiplier.
 *
 * Not cosmetic: an unbounded multiplier compounds with the Elo tilt, and a team
 * on a freak run can reach a λ no league match has ever looked like. ±35% is
 * roughly the spread between the best and worst attacks in a real division once
 * the rating is already accounted for.
 */
export const STRENGTH_MIN = 0.65;
export const STRENGTH_MAX = 1.35;

/**
 * Matches before the multipliers are trusted at full weight.
 *
 * A promoted club with four matches played has an attack rating made of four
 * numbers. Shrinking toward 1 by sample size means it starts as "whatever the
 * Elo says" and earns its own scoring profile as evidence accumulates.
 */
export const STRENGTH_SHRINK_MATCHES = 12;

/**
 * Fraction of a strength that survives the off-season, in log space.
 *
 * Lower than the Elo carryover (0.85) on purpose: scoring profile is the part of
 * a team most changed by a transfer window. Sell the striker and the attack
 * rating should be closer to neutral in August than the rating is.
 */
export const STRENGTH_CARRYOVER = 0.7;

export function neutralStrength(): TeamStrength {
  return { attack: 1, defence: 1 };
}

function clampStrength(v: number): number {
  return Math.min(STRENGTH_MAX, Math.max(STRENGTH_MIN, v));
}

/**
 * Update both teams' strengths from one played match.
 *
 * `lambdaHome`/`lambdaAway` must be the goals the model expected BEFORE the match
 * — including the multipliers themselves, so what is learned is genuinely the
 * part the model missed and not the part it already had.
 */
export function updateStrengths(
  home: TeamStrength,
  away: TeamStrength,
  lambdaHome: number,
  lambdaAway: number,
  goalsHome: number,
  goalsAway: number,
  opts: { alpha?: number; pseudo?: number; mode?: StrengthMode } = {},
): void {
  const alpha = opts.alpha ?? STRENGTH_ALPHA;
  if (alpha <= 0) return;
  const c = opts.pseudo ?? STRENGTH_PSEUDO;
  const mode = opts.mode ?? STRENGTH_MODE;

  let logResidualHome = Math.log((goalsHome + c) / (lambdaHome + c));
  let logResidualAway = Math.log((goalsAway + c) / (lambdaAway + c));

  // See StrengthMode: 'tempo' keeps only the part of the residual the two sides
  // share, 'style' only the part that separates them.
  if (mode !== 'full') {
    const shared = (logResidualHome + logResidualAway) / 2;
    if (mode === 'tempo') {
      logResidualHome = shared;
      logResidualAway = shared;
    } else {
      logResidualHome -= shared;
      logResidualAway -= shared;
    }
  }

  // Half of each residual to the side that scored, half to the side that
  // conceded. The two teams move in the same direction on the same evidence,
  // which is what makes "who was responsible" wash out over a season.
  //
  // Note there is deliberately no pull toward 1 here. λ already contains the
  // current multipliers, so a model that is right produces a residual of zero and
  // the rating simply stays put; an EWMA that also decayed would drag a correctly
  // rated team back to neutral for no reason. Neutrality is restored by the two
  // places it belongs: shrinkage while the sample is small, and the summer.
  const step = (base: number, delta: number): number =>
    clampStrength(Math.exp(Math.log(base) + alpha * delta * 0.5));

  const ha = step(home.attack, logResidualHome);
  const ad = step(away.defence, logResidualHome);
  const aa = step(away.attack, logResidualAway);
  const hd = step(home.defence, logResidualAway);

  home.attack = ha;
  home.defence = hd;
  away.attack = aa;
  away.defence = ad;
}

/** Regress a strength toward neutral across the summer. */
export function carryOverStrength(s: TeamStrength, carry = STRENGTH_CARRYOVER): TeamStrength {
  return {
    attack: Math.exp(Math.log(s.attack) * carry),
    defence: Math.exp(Math.log(s.defence) * carry),
  };
}

/**
 * The strength to actually USE in a prediction: shrunk toward neutral by how
 * many matches are behind it.
 */
export function shrinkStrength(
  s: TeamStrength,
  matches: number,
  shrinkMatches = STRENGTH_SHRINK_MATCHES,
): TeamStrength {
  if (shrinkMatches <= 0) return s;
  const w = matches / (matches + shrinkMatches);
  return {
    attack: Math.exp(Math.log(s.attack) * w),
    defence: Math.exp(Math.log(s.defence) * w),
  };
}

/** Plain-language description of a strength pair, for the breakdown panel. */
export function describeStrength(s: TeamStrength): string {
  const signed = (v: number) => `${v >= 1 ? '+' : '−'}${Math.abs(Math.round((v - 1) * 100))}%`;
  const att =
    Math.abs(s.attack - 1) < 0.03
      ? 'marca lo que dicta su Elo'
      : `marca ${signed(s.attack)} respecto a lo que dicta su Elo`;
  const def =
    Math.abs(s.defence - 1) < 0.03
      ? 'encaja lo que dicta su Elo'
      : `encaja ${signed(s.defence)}`;
  return `${att}; ${def}`;
}

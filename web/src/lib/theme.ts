// ===========================================================================
// DESIGN TOKENS
// ===========================================================================
// One place for every colour, so the four sports read as one product instead of
// four apps that happen to share a tab bar.
//
// THE RULE THAT MATTERS: data colours are SHARED and validated; sport identity is
// chrome only.
//
// Before this file each sport had invented its own: football lime/slate/sky,
// baseball amber/sky, basketball orange. That is not just untidy — the football
// set was measurably broken. Its "away" sky (#38bdf8) and its "draw" slate
// (#94a3b8) sat ΔE 11.6 apart in normal vision, under the 15 floor, so the two
// bars people most need to tell apart were hard to tell apart even with full
// colour vision. The slate also failed the chroma floor outright (it reads as
// grey, which is what "no data" should look like, not "the draw").
//
// The replacement is one three-colour categorical set used by all four sports,
// validated on this app's dark surface across ALL pairs (not just adjacent ones,
// because the score matrix puts the three blocks in contact):
//
//     lightness band   PASS    chroma floor   PASS
//     CVD separation   PASS  worst pair ΔE 9.4 (deutan)
//     normal vision    PASS  worst pair ΔE 20.9
//     contrast         PASS  all three ≥ 3:1 on the surface
//
// Home is blue and away is orange in every sport now, which also means the colour
// means the same thing when you switch tabs.
//
// A softer, more muted trio was tried and rejected: it passed too, but with less
// room (CVD ΔE 8.2 against 9.4, normal vision 17.8 against 20.9). Trading safety
// margin for a slightly calmer look is the wrong trade when the whole point of
// the colour is telling two teams apart. What DOES make it calmer, without
// costing anything, is using less of it — see the note on ink below.

/**
 * THE RULE FOR TEXT: a number is never painted in a series colour.
 *
 * Values, labels and legends wear ink; a small coloured chip beside them carries
 * the identity. The card used to render a 28px probability in full-saturation
 * blue and another in full-saturation orange, which is a lot of shouting for two
 * figures that are simply "the answer" — and it makes the number harder to read
 * than plain white would. Colour marks WHO; ink states WHAT.
 */
export const INK = {
  primary: '#e8eaed',
  secondary: '#9aa1ac',
  muted: '#7b828d',
} as const;

/**
 * The neutral ramp, as Tailwind classes.
 *
 * Six steps, and every one of them is a true grey. The app used to write text in
 * Tailwind's `slate`, which is a blue-tinted grey: on a blue-black page with a
 * blue "home" series, that put a third, weaker blue on screen competing with the
 * two that carry meaning. Neutral text lets the only hue in the interface be the
 * data.
 */
export const TEXT = {
  /** Headlines and the answer itself. */
  strong: 'text-[#e8eaed]',
  /** Body copy. */
  body: 'text-[#c3c9d1]',
  /** Secondary figures, hints under a value. */
  soft: 'text-[#9aa1ac]',
  /** Labels, captions, timestamps. */
  muted: 'text-[#7b828d]',
  /** Separators, "—" placeholders. Barely there on purpose. */
  faint: 'text-[#5c636c]',
} as const;

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------
// Near-neutral, not navy. The page used to be #0a0f1e, a distinctly blue black,
// which put a hue on every pixel and left the data colours competing with the
// background instead of standing out of it. A near-neutral surface means the
// only hue on screen belongs to the data.
export const SURFACE_PAGE = '#0b0d11';
export const SURFACE_CARD = '#14161b';
/** The surface the categorical palette was validated against. */
export const SURFACE = SURFACE_CARD;

// ---------------------------------------------------------------------------
// Data colours — categorical, shared by all four sports
// ---------------------------------------------------------------------------
export const HOME_COLOR = '#3987e5'; // blue  — home team / player 1
export const AWAY_COLOR = '#d95926'; // orange — away team / player 2
export const DRAW_COLOR = '#199e70'; // aqua  — the draw (football only)

/** Neutral, for "no data" / disabled marks. Deliberately the only grey in a chart. */
export const NEUTRAL_COLOR = '#64748b';

// ---------------------------------------------------------------------------
// Status — reserved, never reused as a series colour
// ---------------------------------------------------------------------------
export const STATUS = {
  good: '#199e70',
  warning: '#c98500',
  critical: '#e66767',
} as const;

/** Reliability tiers wear status colours and always ship with a word, never colour alone. */
export const RELIABILITY_STYLE: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  medium: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  low: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
};

// ---------------------------------------------------------------------------
// Sport identity — CHROME ONLY. Never a data mark.
// ---------------------------------------------------------------------------
export type SportId = 'football' | 'basketball' | 'baseball' | 'tennis';

export interface SportTheme {
  id: SportId;
  label: string;
  emoji: string;
  /** Tab underline, active league pill, focus ring. Never a bar or a cell. */
  accent: string;
  accentSoft: string;
}

export const SPORT_THEMES: Record<SportId, SportTheme> = {
  football: { id: 'football', label: 'Fútbol', emoji: '⚽', accent: '#4ade80', accentSoft: 'rgba(74,222,128,0.12)' },
  basketball: { id: 'basketball', label: 'Baloncesto', emoji: '🏀', accent: '#fb923c', accentSoft: 'rgba(251,146,60,0.12)' },
  baseball: { id: 'baseball', label: 'Béisbol', emoji: '⚾', accent: '#facc15', accentSoft: 'rgba(250,204,21,0.12)' },
  tennis: { id: 'tennis', label: 'Tenis', emoji: '🎾', accent: '#a78bfa', accentSoft: 'rgba(167,139,250,0.12)' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Append an alpha channel to a hex colour, for sequential shading within a hue. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

/**
 * Ink to place ON a filled mark.
 *
 * Dark ink once the fill is solid enough to carry it, light ink otherwise — the
 * rule that keeps a heat-map cell legible at both ends of its ramp.
 */
export function inkOn(strength: number): string {
  return strength > 0.55 ? '#0b1220' : '#cbd5e1';
}

export const pct = (p: number, digits = 1): string => `${(p * 100).toFixed(digits)}%`;

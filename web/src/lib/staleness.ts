// Is the history behind a sport's Elo actually current?
//
// ===========================================================================
// WHY THIS IS NOT "MORE THAN SIX MONTHS OLD"
// ===========================================================================
// An Elo rating is only as current as the newest match behind it. The tennis tab
// had a warning for this; the other four did not — so the NBA tab was serving
// ratings built on a history that ends in **June 2015** with nothing on screen to
// say so, and the football tab one that ends in **2020**. That is the single most
// misleading thing the app could do, because a confidently-drawn 63 % is
// indistinguishable from a well-founded one.
//
// The obvious rule — "warn if the newest match is more than six months old" — is
// wrong, and wrong in the way that matters: it fires every August on the NFL tab,
// whose newest match is correctly February's Super Bowl. A warning that cries wolf
// each off-season teaches the reader to ignore it, which is worse than no warning.
//
// So the test is against EACH SPORT'S OWN OFF-SEASON. A gap the length of a normal
// summer break is normal; a gap longer than that means a season is missing.

/** The sports whose history recency is worth checking. */
export type StaleSport = 'football' | 'basketball' | 'baseball' | 'nfl' | 'tennis';

/**
 * Longest NORMAL gap with no matches, in days, per sport — the off-season.
 *
 * From the real calendars: European league football breaks from mid-May to
 * mid-August (~3 months); the NBA from mid-June to mid-October (~4); MLB from
 * early November to late March (~5½); the NFL from the Super Bowl in February to
 * early September (~7, the longest of the five); tennis barely stops at all, just
 * late November to the first week of January.
 */
const OFF_SEASON_DAYS: Record<StaleSport, number> = {
  football: 92,
  basketball: 122,
  baseball: 167,
  nfl: 205,
  tennis: 45,
};

/**
 * Slack on top of the off-season before complaining.
 *
 * Off-season lengths shift by a few weeks year to year, and a source can lag the
 * last week of a season by days. Six weeks means a genuine "we are one season
 * behind" still trips it — that gap is months, not weeks — while an ordinary
 * summer never does.
 */
const SLACK_DAYS = 42;

/** Parses both storage formats the API returns: "20250928" and ISO. */
function parseThrough(through: string): Date | null {
  const s = through.trim();
  if (/^\d{8}$/.test(s)) {
    const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface Staleness {
  /** Newest match in the history. */
  through: Date;
  daysOld: number;
  /** Rounded to one decimal, for the message. */
  yearsOld: number;
  /** Past this sport's off-season plus slack — the ratings are missing a season. */
  stale: boolean;
}

/**
 * How current `through` is for `sport`, or null when there is nothing to judge.
 *
 * Returns null for a missing date and for the synthetic demo dataset: the seed's
 * matches are invented, so "how old are they" is not a question with a useful
 * answer, and the demo badge already says the data is not real.
 */
export function staleness(
  sport: StaleSport,
  through: string | null | undefined,
  isDemo = false,
  now = new Date(),
): Staleness | null {
  if (isDemo || !through) return null;
  const d = parseThrough(through);
  if (!d) return null;
  const daysOld = Math.round((now.getTime() - d.getTime()) / 86_400_000);
  return {
    through: d,
    daysOld,
    yearsOld: Math.round((daysOld / 365.25) * 10) / 10,
    stale: daysOld > OFF_SEASON_DAYS[sport] + SLACK_DAYS,
  };
}

/**
 * The four-word version of the warning, for a collapsed header.
 *
 * The full paragraph explains what to run and why; this is what survives when the
 * reader has folded the header away. It has to survive: the paragraph is the one
 * piece of that block that changes what someone should DO with the numbers, and
 * hiding it silently would make the app quietly misleading.
 *
 * Null when the data is current, so the chip simply is not there.
 */
export function staleLabel(info: Staleness | null): string | null {
  if (!info?.stale) return null;
  return `datos de ${info.through.toLocaleDateString('es', { month: 'short', year: 'numeric' })}`;
}

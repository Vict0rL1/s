// How long a fixture stays in the schedule after it kicks off.
//
// ===========================================================================
// WHY THIS FILTER EXISTS
// ===========================================================================
// Nothing was dropping finished fixtures. The odds tables only get cleaned when
// a refresh succeeds, so a few days with no API key, no network, or no quota
// left every stale fixture sitting in the schedule. That was survivable while
// each card printed its own full date and a past game merely looked odd.
//
// Grouping the schedule by day makes it worse than odd: a finished game files
// under "Ayer" and sits ABOVE tomorrow's, so the first thing you see at the top
// of the list is the thing that matters least.
//
// One module rather than one copy per sport: five hand-rolled cutoffs are five
// chances to drift apart, and "how long is a fixture still interesting" is a
// product decision, not a per-sport one.
//
// ===========================================================================
// WHY IT IS NO LONGER JUST "SIX HOURS"
// ===========================================================================
// Six hours after kick-off answers the wrong question. A match at 11:00 vanished
// at 17:00 — the same afternoon, while it was still the day's news and while its
// result was the thing you most wanted to look up. What people actually mean by
// "today's matches" is the CALENDAR DAY, not a rolling window.
//
// So the cutoff is the EARLIER of two boundaries, which keeps whatever either one
// would keep:
//
//   * the start of today, in local time — so everything played today stays all
//     day and disappears at midnight, and
//   * six hours ago — so a match that kicked off at 23:30 last night is still
//     there at 01:00 while it is being played, instead of being cut off by the
//     midnight boundary mid-game.
//
// Worked through:
//   now 15:00 → min(today 00:00, 09:00) = today 00:00   → this morning's match stays
//   now 01:00 → min(today 00:00, yest 19:00) = yest 19:00 → last night's game stays
//   tomorrow 09:00 → min(tmw 00:00, tmw 03:00) = tmw 00:00 → today's are gone

/** Hours of slack for a match that is probably still being played. */
export const STALE_AFTER_HOURS = 6;

/**
 * Midnight this morning, LOCAL time, as an ISO instant.
 *
 * Local and not UTC, and that is the whole point: "today" is a thing the reader
 * experiences, not a thing UTC has an opinion about. In Madrid, UTC midnight is
 * 01:00 or 02:00, so a UTC boundary would have dropped the evening's matches an
 * hour or two into the following morning — or kept them an hour too long.
 *
 * The server and the browser are the same machine here, so the server's local
 * zone IS the reader's. If this ever runs on a remote host in another zone, this
 * is the function that needs a timezone passed in.
 */
function startOfLocalToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/**
 * The ISO instant a fixture must start at or after to still be shown.
 *
 * Computed per call, not once at import: the server is long-running, and a value
 * frozen at boot would keep yesterday on screen for as long as the process lived.
 */
export function freshSince(now = new Date()): string {
  const midnight = startOfLocalToday(now).getTime();
  const rolling = now.getTime() - STALE_AFTER_HOURS * 3600_000;
  return new Date(Math.min(midnight, rolling)).toISOString();
}

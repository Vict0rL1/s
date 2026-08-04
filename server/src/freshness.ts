// How long a fixture stays in the "upcoming" list after its start time.
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

/**
 * Hours after kick-off that a fixture is still worth showing.
 *
 * Six, so a game that started an hour ago is still on screen for anyone
 * following it, and yesterday's is not. The slack is deliberate: a hard cutoff
 * at kick-off would make a match vanish exactly when it gets interesting.
 */
export const STALE_AFTER_HOURS = 6;

/**
 * The ISO instant a fixture must start at or after to still count as upcoming.
 *
 * Computed per call, not once at import: the server is long-running and a value
 * frozen at boot would let the list rot as the process stayed up.
 */
export function freshSince(): string {
  return new Date(Date.now() - STALE_AFTER_HOURS * 3600_000).toISOString();
}

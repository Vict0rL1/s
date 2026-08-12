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

// A type-only import: freshness.ts stays independent of db.ts at runtime, which is
// what lets the pure date logic above be reasoned about on its own.
import type { DatabaseSync } from 'node:sqlite';

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

/**
 * The source name for an invented slate.
 *
 * It does NOT affect the display window — see the note on that below. It is still
 * meaningful elsewhere: comparing the model against odds the model itself produced
 * is circular, so the picks panel and the cards check for it before claiming value.
 */
export const DEMO_SOURCE = 'fixture';

/**
 * The WHERE fragment that decides whether a scheduled row is still worth showing,
 * with the parameters it needs, in order.
 *
 * One fragment rather than `commence_time >= ?` written out at each of the five
 * repos, because that is precisely how this drifted: the audit grew its own
 * stricter cutoff, the writer kept a looser one, and ten invented fixtures sat in
 * the schedule that one of the two definitions said should not be there. A rule
 * split across six copies is six rules.
 *
 * Splice `params` into the query's own parameter list wherever the fragment lands.
 */
export function freshFilter(now = new Date()): { sql: string; params: string[] } {
  return { sql: '(commence_time >= ?)', params: [freshSince(now)] };
}

// ===========================================================================
// PRUNING: the other half of the same rule
// ===========================================================================
// `freshSince` decides what to SHOW. This decides what to KEEP, and the two have
// to agree — because a filter is worthless if the row it would have kept has
// already been deleted from the table.
//
// That was the bug. Every odds refresh ran an unconditional
//
//     DELETE FROM fb_upcoming        (and the same for the other four sports)
//
// and then reinserted whatever the source returned. A source of UPCOMING events
// never returns a match that has already kicked off, so this morning's game was
// wiped from the database at the next refresh — and the refresh runs on every
// server start. The whole "today's matches stay until midnight" feature was
// filtering a row that no longer existed.
//
// So the delete is now in three parts:
//
//   * FUTURE rows      → delete. The refresh is about to reinsert them with fresh
//                        prices, so keeping the old copy would just risk a stale one.
//   * rows before the  → delete. Past the display window; nobody will look at them
//     window            and they are what made the table grow forever.
//   * everything else  → KEEP. Started, but still inside today. These are exactly
//                        the rows the reader wants the result for, and the only
//                        place they can come from is the copy we already have.
//
// NO EXCEPTION FOR DEMO ROWS, and this was got wrong once.
//
// A carve-out used to delete `source = 'fixture'` rows the moment they kicked off,
// reasoning that an invented match has no result to wait for. That is true and it
// was still the wrong call: WITHOUT AN ODDS_API_KEY EVERY ROW IS A DEMO ROW, so the
// effect was that every match vanished at kick-off — exactly the complaint the whole
// module exists to fix, reintroduced through the one path the reader actually sees.
// Measured at the time: a real match that started two hours ago stayed, an identical
// demo one disappeared.
//
// The window is now uniform. What the reader asked for is "today's matches stay
// today", and that rule does not have an interesting exception.


/** The five tables that hold scheduled matches. */
export type UpcomingTable =
  | 'fb_upcoming'
  | 'bb_upcoming'
  | 'bsb_upcoming'
  | 'naf_upcoming'
  | 'upcoming_matches';

/**
 * Remove the rows a refresh is about to replace, plus anything past the window.
 *
 * Returns how many rows survived, which is the number worth logging: it is the
 * count of already-played matches being carried over.
 */
export function pruneUpcoming(
  db: DatabaseSync,
  table: UpcomingTable,
  opts: {
    /**
     * Extra columns to scope the delete to, e.g. `{ league: 'nfl', source: 'live' }`.
     *
     * The NFL keeps two kinds of row in one table — the published schedule and rows
     * carrying live prices — and a refresh of one must not touch the other. Keys are
     * column names supplied by this codebase, never by a request.
     */
    scope?: Record<string, string>;
    now?: Date;
  } = {},
): number {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const since = freshSince(now);
  const scope = Object.entries(opts.scope ?? {});
  const extra = scope.map(([col]) => ` AND ${col} = ?`).join('');
  db.prepare(
    // `table` and the scope column names are not interpolated user input — the table
    // is one of the five literals in UpcomingTable and the columns are written at the
    // call sites, which is why the type is a union rather than `string`.
    `DELETE FROM ${table} WHERE (commence_time >= ? OR commence_time < ?)${extra}`,
  ).run(nowIso, since, ...scope.map(([, v]) => v));
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE 1 = 1${extra}`)
    .get(...scope.map(([, v]) => v)) as { c: number };
  return row.c;
}

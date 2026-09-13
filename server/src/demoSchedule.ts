// When a DEMO fixture kicks off.
//
// ===========================================================================
// THE BUG THIS REPLACES
// ===========================================================================
// Four sports each rolled their own version of the same line:
//
//     new Date(Date.now() + (i + 1) * 86_400_000).toISOString()
//
// which adds whole days to the current instant — so the kick-off time inherits
// the SEED'S WALL CLOCK. Every demo match in the database kicked off at
// 09:10:30.210, to the millisecond, because that is when `npm run seed` happened
// to run. Two things go wrong:
//
//   1. It is not a plausible time. Real fixtures land on the clock — 14:00,
//      16:15, 20:45 — and a card reading "09:10" for a Madrid-Barça is the sort of
//      detail that makes a reader stop trusting everything else on the page.
//
//   2. The times AGE. Generated as "tomorrow at 09:10", the first slot is already
//      in the past by 09:11 the next morning, so the top of the schedule is a
//      match that supposedly started hours ago with no result to show. The audit
//      caught exactly this: "4 de 24 partidos próximos ya jugados".
//
// ===========================================================================
// WHAT IT DOES INSTEAD
// ===========================================================================
// Kick-offs are anchored to the CALENDAR DAY at hours the sport actually plays,
// and any slot that has already passed is skipped. So the demo schedule is
// plausible on the clock, and it is always genuinely upcoming no matter what time
// of day you look at it.
//
// One module and not five: "when does a demo match kick off" is one question, and
// five hand-rolled answers are five chances to drift apart — the same reasoning as
// freshness.ts, which decides when a fixture stops being shown. These two modules
// are the pair that has to agree: this one must not emit a time the other would
// immediately filter out.

/**
 * The sports that generate demo fixtures.
 *
 * The NFL is deliberately absent: nflverse publishes the real schedule with real
 * kick-off times, so that tab never needs an invented one. Adding it here would be
 * dead configuration that looks like a promise.
 */
export type DemoSport = 'football' | 'basketball' | 'baseball' | 'tennis';

/**
 * Local times of day each sport plays, as [hour, minute].
 *
 * Local rather than UTC on purpose: the card renders in the reader's zone, so
 * "plausible" is a statement about their clock, not about UTC's. Real schedules
 * are the source — European league football in the afternoon and evening, NBA at
 * night, baseball with its day/night pair, the NFL in its three Sunday windows.
 *
 * More slots than a day usually needs, so consecutive days do not all look
 * identical.
 */
const SLOTS: Record<DemoSport, [number, number][]> = {
  football: [
    [14, 0],
    [16, 15],
    [18, 30],
    [21, 0],
  ],
  basketball: [
    [19, 0],
    [20, 30],
    [22, 0],
  ],
  // Baseball's day game and its two evening windows.
  baseball: [
    [13, 10],
    [19, 5],
    [20, 40],
  ],
  tennis: [
    [11, 0],
    [13, 30],
    [16, 0],
    [19, 30],
  ],
};

/**
 * How far ahead a generated fixture must be.
 *
 * Without it, refreshing at 13:55 would emit football's 14:00 slot, which is
 * "upcoming" for five minutes and then spends the rest of the day as a started
 * match with no result — the exact failure this module exists to remove.
 */
const MIN_LEAD_MINUTES = 45;

/** How many days ahead to look before giving up. Generous; a guard, not a limit. */
const MAX_DAYS = 30;

/**
 * `count` plausible upcoming kick-off instants for `sport`, ascending, as ISO
 * strings.
 *
 * Seconds and milliseconds are zero: a real schedule is announced to the minute,
 * and a stray ".210" is precisely the tell that a time was computed rather than
 * scheduled.
 */
export function demoKickoffs(sport: DemoSport, count: number, now = new Date()): string[] {
  const slots = SLOTS[sport];
  const earliest = now.getTime() + MIN_LEAD_MINUTES * 60_000;
  const out: string[] = [];
  for (let day = 0; day < MAX_DAYS && out.length < count; day++) {
    for (const [h, m] of slots) {
      if (out.length >= count) break;
      const t = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + day,
        h,
        m,
        0,
        0,
      );
      if (t.getTime() < earliest) continue;
      out.push(t.toISOString());
    }
  }
  return out;
}

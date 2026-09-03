// Turning a wall-clock time in some city into a real instant.
//
// ===========================================================================
// THE BUG THIS EXISTS TO FIX
// ===========================================================================
// The NFL schedule publishes kick-off as a local date and a local time in US
// Eastern: "2026-09-10", "20:20". Turning that into an instant was written as
//
//     new Date(`${day}T${time}:00-05:00`)
//
// which is US Eastern STANDARD time — and the NFL season runs from September to
// February, so most of it is in DAYLIGHT time at -04:00. Every game from the
// season opener to early November was stored an hour late, and the card said a
// Thursday night game kicked off at 21:20 when it kicks off at 20:20.
//
// A fixed offset is wrong for any city that observes DST, which is nearly all of
// them, and the direction of the error flips twice a year. So the offset has to
// be looked up for the specific date, which is exactly what the platform's own
// time zone database is for — no dependency required.

/**
 * The UTC offset of a zone at a given instant, in minutes.
 *
 * Works by asking Intl to describe the same instant in both UTC and the target
 * zone and measuring the gap. `timeZoneName: 'shortOffset'` would be shorter but
 * returns strings like "GMT-4" that need parsing and are not offered for every
 * zone; formatting to parts and subtracting is exact everywhere.
 */
function offsetMinutes(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) parts[p.type] = p.value;
  // Intl renders midnight as hour "24" in some locales/zones; normalise.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * A wall-clock time in `timeZone` → the ISO instant it happened at.
 *
 * `date` is YYYY-MM-DD and `time` is HH:MM, both as the city's own clock reads
 * them. Returns null rather than an Invalid Date for anything unparseable, so a
 * malformed row is skipped instead of poisoning a schedule with NaN.
 *
 * Two passes, and the second one matters: the offset depends on the instant, and
 * the instant depends on the offset. Guessing the offset from the naive UTC
 * reading, then re-checking it at the corrected instant, resolves everything
 * except times that fall inside the one hour a year that DST deletes — where any
 * answer is a judgement call and this returns the shifted one, which is what the
 * league does too.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if (hh > 23 || mm > 59) return null;

  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const firstGuess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  const corrected = new Date(naive - offsetMinutes(firstGuess, timeZone) * 60_000);
  return Number.isNaN(corrected.getTime()) ? null : corrected.toISOString();
}

// Presentation helpers (Spanish UI).

export function pct(p: number | null | undefined, digits = 0): string {
  if (p == null) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

export function surfaceLabelEs(surface: string | null): string {
  switch ((surface || '').toLowerCase()) {
    case 'hard':
      return 'Dura';
    case 'clay':
      return 'Arcilla';
    case 'grass':
      return 'Hierba';
    case 'carpet':
      return 'Carpeta';
    default:
      return surface || '—';
  }
}

/** Accent color per surface (used sparingly, always paired with a text label). */
export function surfaceColor(surface: string | null): string {
  switch ((surface || '').toLowerCase()) {
    case 'hard':
      return '#38bdf8'; // sky
    case 'clay':
      return '#fb923c'; // orange
    case 'grass':
      return '#4ade80'; // green
    default:
      return '#94a3b8';
  }
}

export function confidenceLabelEs(tier: string): string {
  switch (tier) {
    case 'toss_up':
      return 'muy parejo';
    case 'slight':
      return 'ligera ventaja';
    case 'clear':
      return 'favorito claro';
    case 'strong':
      return 'favorito fuerte';
    default:
      return tier;
  }
}

export function formatDate(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '';
  if (yyyymmdd.length === 8) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  return yyyymmdd;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// `flag(ioc)` vivía aquí y ya no existe. Convertía el código del COI en un emoji de
// bandera cortando sus dos primeras letras cuando no estaba en una lista de 28, y eso
// ponía la bandera de Serbia a los sudafricanos (RSA→RS) y la de España a los estonios
// (EST→ES): 318 jugadores de 1.272. Lo sustituye `<Flag>` de `components/ui`, que pinta
// un SVG real desde la tabla completa de `lib/countries.ts` y no adivina nunca.

// `countryFlag(country)` también vivía aquí y también se ha ido. Hacía lo mismo que
// `flag()` pero para la sede de una liga, y aunque esa NO daba países equivocados —las
// ligas guardan un ISO-2 correcto o un emoji ya montado— seguía siendo un emoji, y en
// Windows los emoji de bandera no se dibujan. Lo sustituye `<LeagueFlag>` de
// `components/ui`, que resuelve los dos formatos con `leagueFlagSrc` de `lib/countries`
// y pinta el mismo SVG que las de los jugadores.

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------
// A list of 32 games spread over three weeks, each card stamped "dom, 13 sept,
// 13:00", is a list you have to read to navigate. Grouping by day moves the date
// out of the cards and into one heading above each group, which leaves the card
// showing the only part that differs — the time — and makes the shape of the week
// visible at a glance.
//
// EVERYTHING HERE WORKS IN THE READER'S OWN TIME ZONE. The database stores UTC;
// these functions convert once, on the way to the screen. The subtlety that bites
// is grouping: a 22:00 kick-off in Madrid is 20:00 UTC the same day, but a 23:00
// one in Mexico City is 05:00 UTC the NEXT day. Bucketing on the UTC date would
// file it under tomorrow and the reader would go looking for it on the wrong
// heading, so the bucket key is built from LOCAL date parts.

/** Local YYYY-MM-DD — the bucket a match belongs to for the person reading. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'invalid';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Today's bucket, for comparing against `dayKey`. */
export function todayKey(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whole days from today to this bucket. 0 = today, 1 = tomorrow, −1 = yesterday. */
export function daysFromToday(key: string, now = new Date()): number {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return NaN;
  const then = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((then - today) / 86_400_000);
}

/**
 * The heading for a day group: "Hoy", "Mañana", or "sábado, 13 de septiembre".
 *
 * "Hoy" and "Mañana" earn the exception because they are the two the reader is
 * almost always looking for, and a weekday name does not tell you which of them
 * you are on.
 */
export function dayLabel(key: string, now = new Date()): string {
  const delta = daysFromToday(key, now);
  if (delta === 0) return 'Hoy';
  if (delta === 1) return 'Mañana';
  if (delta === -1) return 'Ayer';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const long = date.toLocaleDateString('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    // The year only when it is not this one — "13 de septiembre de 2026" is noise
    // in September 2026 and essential in December.
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
  return long.charAt(0).toUpperCase() + long.slice(1);
}

/** Compact label for a day chip: "Hoy", "Mañana", "sáb 13". */
export function dayChipLabel(key: string, now = new Date()): string {
  const delta = daysFromToday(key, now);
  if (delta === 0) return 'Hoy';
  if (delta === 1) return 'Mañana';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es', { weekday: 'short', day: 'numeric' });
}

/** Just the clock, in the reader's zone: "20:20". The day is in the heading. */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

/**
 * "en 2 h", "en 3 días", "empezó hace 20 min".
 *
 * Shown next to the time because "20:20" alone does not answer the question
 * people actually have, which is whether they have time to read the card.
 */
export function relativeTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(mins);
  const phrase =
    abs < 60
      ? `${abs} min`
      : abs < 60 * 36
        ? `${Math.round(abs / 60)} h`
        : `${Math.round(abs / (60 * 24))} días`;
  return mins >= 0 ? `en ${phrase}` : `hace ${phrase}`;
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Split a chronological list into day buckets, keeping the order.
 *
 * Assumes the input is already sorted by time, which every /upcoming endpoint
 * guarantees with an ORDER BY — re-sorting here would hide it if one ever stopped.
 */
export function groupByDay<T>(items: T[], time: (item: T) => string): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(time(item));
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: dayLabel(key), items: [item] });
  }
  return out;
}

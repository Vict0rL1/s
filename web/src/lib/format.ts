// Presentation helpers. El texto sale del catálogo (i18n) y las fechas, del locale del idioma;
// sin idioma, español (la fuente de verdad), así que lo que no lo pasa sigue como estaba.
import { localeDe, tr, type Clave, type Idioma } from '../i18n';
import { pct as pctFormato } from './formato';

export function pct(p: number | null | undefined, digits = 0): string {
  if (p == null) return '—';
  return pctFormato(p, digits);
}

export function surfaceLabelEs(surface: string | null, idioma: Idioma = 'es'): string {
  const s = (surface || '').toLowerCase();
  return ['hard', 'clay', 'grass', 'carpet'].includes(s) ? tr(idioma, `superficie.${s}` as Clave) : surface || '—';
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

export function confidenceLabelEs(tier: string, idioma: Idioma = 'es'): string {
  return ['toss_up', 'slight', 'clear', 'strong'].includes(tier) ? tr(idioma, `ventaja.${tier}` as Clave) : tier;
}

export function formatDate(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '';
  if (yyyymmdd.length === 8) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  return yyyymmdd;
}

export function formatDateTime(iso: string, idioma: Idioma = 'es'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(localeDe(idioma), {
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
export function dayLabel(key: string, now = new Date(), idioma: Idioma = 'es'): string {
  const delta = daysFromToday(key, now);
  if (delta === 0) return tr(idioma, 'dia.hoy');
  if (delta === 1) return tr(idioma, 'dia.manana');
  if (delta === -1) return tr(idioma, 'dia.ayer');
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const long = date.toLocaleDateString(localeDe(idioma), {
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
export function dayChipLabel(key: string, now = new Date(), idioma: Idioma = 'es'): string {
  const delta = daysFromToday(key, now);
  if (delta === 0) return tr(idioma, 'dia.hoy');
  if (delta === 1) return tr(idioma, 'dia.manana');
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(localeDe(idioma), { weekday: 'short', day: 'numeric' });
}

/** Just the clock, in the reader's zone: "20:20". The day is in the heading. */
export function shortTime(iso: string, idioma: Idioma = 'es'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(localeDe(idioma), { hour: '2-digit', minute: '2-digit' });
}

/**
 * "en 2 h", "en 3 días", "empezó hace 20 min".
 *
 * Shown next to the time because "20:20" alone does not answer the question
 * people actually have, which is whether they have time to read the card.
 */
export function relativeTime(iso: string, now = new Date(), idioma: Idioma = 'es'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(mins);
  const phrase =
    abs < 60
      ? tr(idioma, 'tiempo.min', { n: abs })
      : abs < 60 * 36
        ? tr(idioma, 'tiempo.h', { n: Math.round(abs / 60) })
        : tr(idioma, 'tiempo.dias', { n: Math.round(abs / (60 * 24)) });
  return mins >= 0 ? tr(idioma, 'tiempo.en', { x: phrase }) : tr(idioma, 'tiempo.hace', { x: phrase });
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
export function groupByDay<T>(items: T[], time: (item: T) => string, idioma: Idioma = 'es'): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(time(item));
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: dayLabel(key, new Date(), idioma), items: [item] });
  }
  return out;
}

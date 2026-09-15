/**
 * Utilidades de fecha portadas de `reference/cumbre.html`.
 *
 * Dos reglas gobiernan este archivo:
 *
 * 1. Las fechas sueltas son strings "YYYY-MM-DD" y toda la aritmética sobre
 *    ellas se hace en UTC. Nunca construimos un `Date` local a partir de un
 *    string, que es de donde salen los bugs de horario de verano.
 * 2. "Hoy" depende de la zona del usuario (`profiles.timezone`), no de la del
 *    servidor de Vercel, que corre en UTC.
 */

export const DEFAULT_TIMEZONE = "America/Vancouver";

export const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
export const DAYS_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
export const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
export const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export const pad = (n: number) => String(n).padStart(2, "0");

export const norm = (s: string) =>
  String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/* ------------------------------------------------------ fechas "YYYY-MM-DD" */

/** Medianoche UTC del día, en milisegundos. Sólo para aritmética. */
function ymdToUtc(s: string): number {
  const [y, m, d] = String(s).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function utcToYmd(ms: number): string {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

/** Construye "YYYY-MM-DD" y devuelve null si el día no existe (ej. 31 de febrero). */
export function makeYmd(year: number, month1: number, day: number): string | null {
  const ms = Date.UTC(year, month1 - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month1 - 1 || d.getUTCDate() !== day) return null;
  return utcToYmd(ms);
}

export const addDays = (s: string, n: number) => utcToYmd(ymdToUtc(s) + n * 86400000);

export const daysBetween = (a: string, b: string) => Math.round((ymdToUtc(b) - ymdToUtc(a)) / 86400000);

/** Día de la semana, 0 = domingo. */
export const weekdayOf = (s: string) => new Date(ymdToUtc(s)).getUTCDay();

export const dayOfMonth = (s: string) => Number(String(s).slice(8, 10));
export const monthOf = (s: string) => Number(String(s).slice(5, 7)) - 1;
export const yearOf = (s: string) => Number(String(s).slice(0, 4));

/* ------------------------------------------------------------------- zonas */

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsInTz(instant: Date | number, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(instant))) p[x.type] = x.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    // Algunos ICU devuelven "24" para la medianoche.
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
  };
}

/** Desfase de la zona respecto a UTC, en ms, para ese instante. */
export function tzOffset(ms: number, timeZone: string): number {
  try {
    const p = partsInTz(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  } catch {
    return 0;
  }
}

/** La hora de pared (Y-M-D H:M en `timeZone`) como instante absoluto. */
export function wallTimeToInstant(
  year: number, month1: number, day: number, hour: number, minute: number, timeZone: string,
): number {
  const guess = Date.UTC(year, month1 - 1, day, hour, minute);
  // Dos pasadas: la primera estima el desfase, la segunda lo corrige en los
  // saltos de horario de verano.
  const once = guess - tzOffset(guess, timeZone);
  return guess - tzOffset(once, timeZone);
}

export function todayInTz(timeZone: string, now: Date | number = Date.now()): string {
  const p = partsInTz(now, timeZone);
  return p.year + "-" + pad(p.month) + "-" + pad(p.day);
}

export function minutesInTz(timeZone: string, now: Date | number = Date.now()): number {
  const p = partsInTz(now, timeZone);
  return p.hour * 60 + p.minute;
}

/** Un `timestamptz` visto desde la zona del usuario: día local y minuto del día. */
export function zonedDayMinute(iso: string, timeZone: string): { date: string; min: number } {
  const p = partsInTz(new Date(iso), timeZone);
  return { date: p.year + "-" + pad(p.month) + "-" + pad(p.day), min: p.hour * 60 + p.minute };
}

/* -------------------------------------------------------------------- horas */

export const minsToHHMM = (m: number) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);

export const hhmmToMins = (t: string) => {
  const p = String(t).split(":").map(Number);
  return p[0] * 60 + (p[1] || 0);
};

/** Postgres `time` ("15:00:00") -> minutos desde medianoche. */
export const timeToMins = (t: string | null | undefined) => (t ? hhmmToMins(t) : null);

/** Minutos desde medianoche -> Postgres `time`. */
export const minsToTime = (m: number | null | undefined) =>
  m == null ? null : minsToHHMM(m) + ":00";

export function fmtDur(m: number | null | undefined): string {
  if (!m) return "";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60), r = m % 60;
  return r ? h + "h" + pad(r) : h + "h";
}

/** "hoy", "mañana", "vie", "22 oct"… relativo a `today`. */
export function fmtDate(s: string | null | undefined, today: string): string {
  if (!s) return "";
  const d = daysBetween(today, s);
  if (d === 0) return "hoy";
  if (d === 1) return "mañana";
  if (d === -1) return "ayer";
  if (d < 0) return Math.abs(d) + " d tarde";
  if (d < 7) return DAYS_SHORT[weekdayOf(s)];
  return dayOfMonth(s) + " " + MONTHS_SHORT[monthOf(s)];
}

/** Lunes de la semana que contiene `day`. */
export const startOfWeek = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));

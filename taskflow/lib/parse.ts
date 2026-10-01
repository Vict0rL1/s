/**
 * Captura rápida — portado de `parseInput` en `reference/cumbre.html`.
 *
 * Cambios respecto al original, ambos para que corra en el servidor:
 *  - "Hoy" se recibe como parámetro (`opts.today`) en vez de leerse de
 *    `new Date()`, que en Vercel sería UTC y no la zona del usuario.
 *  - Las áreas se reciben como parámetro en vez de leerse del estado global.
 *
 * La gramática es la misma: `#área  !prioridad  fecha  hora  duración`, en
 * cualquier orden, y lo que sobra es el título.
 */

import { DEFAULT_TIMEZONE, MONTHS_SHORT, addDays, makeYmd, norm, todayInTz, weekdayOf, yearOf } from "./date";

export type Parsed = {
  title: string;
  area: string;
  /** "YYYY-MM-DD" o null. */
  due: string | null;
  /** Minutos desde medianoche, o null. */
  start: number | null;
  /** Duración estimada en minutos. 0 = sin estimar. */
  dur: number;
  /** 1 alta · 2 media · 3 baja · 0 sin marcar. */
  prio: number;
};

export type ParseOptions = {
  /** Áreas del perfil, para resolver `#sfu` -> `SFU`. */
  areas?: string[];
  /** "YYYY-MM-DD" en la zona del usuario. */
  today?: string;
  timeZone?: string;
};

const WD: Record<string, number> = {
  dom: 0, domingo: 0, lun: 1, lunes: 1, mar: 2, martes: 2, mie: 3, miercoles: 3,
  jue: 4, jueves: 4, vie: 5, viernes: 5, sab: 6, sabado: 6,
};

/** El próximo `target` (0 = domingo). Si hoy es ese día, devuelve el de la semana que viene. */
export function nextWeekday(target: number, today: string): string {
  let delta = (target - weekdayOf(today) + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(today, delta);
}

/** La próxima vez que caiga ese día y mes: este año, o el siguiente si ya pasó. */
function nextDate(day: number, month1: number, today: string): string | null {
  const y = yearOf(today);
  const cand = makeYmd(y, month1, day);
  if (!cand) return null;
  return cand < today ? makeYmd(y + 1, month1, day) : cand;
}

export function parseInput(raw: string, opts: ParseOptions = {}): Parsed {
  const areas = opts.areas ?? [];
  const today = opts.today ?? todayInTz(opts.timeZone ?? DEFAULT_TIMEZONE);

  let t = " " + String(raw ?? "").trim() + " ";
  const out: Parsed = { title: "", area: "", due: null, start: null, dur: 0, prio: 0 };

  const cut = (re: RegExp): RegExpMatchArray | null => {
    const m = t.match(re);
    if (m) {
      t = t.replace(m[0], " ");
      return m;
    }
    return null;
  };

  // Como `cut`, pero sólo consume el texto si el resultado sirve. Así
  // "entregar 31 feb" conserva el "31 feb" en el título en vez de tragárselo
  // para producir una fecha que no existe.
  const cutIf = <T>(re: RegExp, pick: (m: RegExpMatchArray) => T | null): T | null => {
    const m = t.match(re);
    if (!m) return null;
    const v = pick(m);
    if (v === null) return null;
    t = t.replace(m[0], " ");
    return v;
  };

  // #área / @área — resuelve contra las áreas del perfil por prefijo.
  let m = cut(/\s[#@]([\p{L}\d_-]+)/u);
  if (m) {
    const q = norm(m[1]);
    out.area = areas.find((a) => norm(a).startsWith(q)) || m[1];
  }

  // !alta / !media / !baja / !1 / !2 / !3
  m = cut(/\s!(alta|media|baja|1|2|3)\b/i);
  if (m) {
    const v = norm(m[1]);
    out.prio = v === "alta" || v === "1" ? 1 : v === "media" || v === "2" ? 2 : 3;
  }

  // Duración: "1.5h" / "90m". Las horas se prueban primero.
  m = cut(/\s(\d+(?:[.,]\d+)?)\s?(h|hr|hrs|horas?)\b/i);
  if (m) out.dur = Math.round(parseFloat(m[1].replace(",", ".")) * 60);
  if (!out.dur) {
    m = cut(/\s(\d{1,3})\s?(m|min|mins|minutos?)\b/i);
    if (m) out.dur = parseInt(m[1], 10);
  }

  // Hora: "3pm" / "15:00".
  m = cut(/\s(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (norm(m[3]) === "pm") h += 12;
    out.start = h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
  }
  if (out.start === null) {
    m = cut(/\s([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (m) out.start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  // Fecha: relativa, "22 oct", "22/10", o día de la semana.
  m = cut(/\s(hoy|manana|mañana|pasado)\b/i);
  if (m) {
    const v = norm(m[1]);
    out.due = v === "hoy" ? today : v === "pasado" ? addDays(today, 2) : addDays(today, 1);
  }
  if (!out.due) {
    out.due = cutIf(
      new RegExp("\\s(\\d{1,2})\\s?(?:de\\s)?(" + MONTHS_SHORT.join("|") + ")[a-z]*\\b", "i"),
      (x) => nextDate(parseInt(x[1], 10), MONTHS_SHORT.indexOf(norm(x[2]).slice(0, 3)) + 1, today),
    );
  }
  if (!out.due) {
    out.due = cutIf(/\s(\d{1,2})[/-](\d{1,2})\b/, (x) =>
      nextDate(parseInt(x[1], 10), parseInt(x[2], 10), today),
    );
  }
  if (!out.due) {
    m = cut(/\s(domingo|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|dom|lun|mar|mie|mié|jue|vie|sab|sáb)\b/i);
    if (m) {
      const k = norm(m[1]);
      if (k in WD) out.due = nextWeekday(WD[k], today);
    }
  }

  out.title = t.replace(/\s+/g, " ").trim();
  return out;
}

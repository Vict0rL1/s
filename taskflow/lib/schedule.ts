/**
 * Tiempo libre y ocupado, en minutos locales de un día (0–1440).
 *
 * Todo aquí es determinista y puro. Es la parte que decide DÓNDE cabe algo:
 * Claude puede proponer qué hacer, pero quién calcula los huecos, los choques
 * y los límites es este archivo. Un modelo al que le pides que "respete los
 * compromisos" se los pisa de vez en cuando; uno al que sólo le das huecos ya
 * calculados — y cuya respuesta se vuelve a validar aquí — no puede.
 */

import { addDays, minsToHHMM, weekdayOf } from "./date";

export type Gap = { start: number; end: number };

/** Un hueco por debajo de esto no sirve para nada: ni empiezas. */
export const MIN_GAP = 20;

/** Une los intervalos que se tocan o se enciman. */
export function mergeBusy(busy: Gap[]): Gap[] {
  const sorted = busy.filter((b) => b.end > b.start).map((b) => ({ ...b })).sort((a, b) => a.start - b.start);
  const out: Gap[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push(b);
  }
  return out;
}

/**
 * Los ratos libres entre `from` y `to`.
 *
 * `busy` son los compromisos: clases, eventos con hora y los bloques que ya
 * tengas puestos. Se fusionan los solapados antes de restar, porque dos
 * eventos encimados dejarían un hueco negativo.
 */
export function freeGaps(busy: Gap[], from: number, to: number, minGap = MIN_GAP): Gap[] {
  const ocupado = mergeBusy(
    busy.map((b) => ({ start: Math.max(b.start, from), end: Math.min(b.end, to) })),
  );

  const libres: Gap[] = [];
  let cursor = from;
  for (const b of ocupado) {
    if (b.start - cursor >= minGap) libres.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (to - cursor >= minGap) libres.push({ start: cursor, end: to });
  return libres;
}

export const overlaps = (a: Gap, b: Gap) => a.start < b.end && b.start < a.end;

export type Proposed = Gap & { taskId?: string | null };

export type SkipReason = "ocupado" | "pasado" | "tarea";

/**
 * Qué parte de una propuesta se puede escribir AHORA.
 *
 * La propuesta se armó hace un rato; desde entonces pudo pasar de todo: que
 * agregaras un bloque a mano, que llegara un evento nuevo, que marcaras hecha
 * la tarea, o que el botón "Agendar" se pulsara dos veces. Se vuelve a medir
 * contra lo que hay en este momento:
 *
 *  - lo que choca con algo ocupado no entra (y así un doble "Agendar" no
 *    duplica nada: la segunda vez todo choca con lo que puso la primera);
 *  - lo que ya terminó no entra;
 *  - lo que adelanta una tarea que ya no está pendiente no entra.
 *
 * Nunca se toca lo que ya estaba: sólo se decide qué se agrega.
 */
export function acceptable<T extends Proposed>(
  proposed: T[],
  busy: Gap[],
  opts: { now?: number | null; liveTaskIds?: Set<string> } = {},
): { accepted: T[]; skipped: { block: T; reason: SkipReason }[] } {
  const taken = mergeBusy(busy);
  const accepted: T[] = [];
  const skipped: { block: T; reason: SkipReason }[] = [];

  for (const b of [...proposed].sort((x, y) => x.start - y.start)) {
    if (opts.now != null && b.end <= opts.now) skipped.push({ block: b, reason: "pasado" });
    else if (b.taskId && opts.liveTaskIds && !opts.liveTaskIds.has(b.taskId)) skipped.push({ block: b, reason: "tarea" });
    else if (taken.some((t) => overlaps(t, b)) || accepted.some((a) => overlaps(a, b))) {
      skipped.push({ block: b, reason: "ocupado" });
    } else accepted.push(b);
  }
  return { accepted, skipped };
}

/* ======================================================= varios días */

/** Algo ocupado, con nombre para poder explicar dónde cae un hueco. */
export type Busy = Gap & { label?: string };

/** Un día de trabajo: desde cuándo hasta cuándo, y qué está ocupado. */
export type DayWindow = { day: string; from: number; to: number; busy: Busy[] };

/** Redondea hacia arriba al cuarto de hora: nadie empieza a las 14:07. */
export const ceil15 = (m: number) => Math.ceil(m / 15) * 15;

/**
 * Las ventanas de trabajo de cada día: tu horario (Ajustes), menos lo que ya
 * está ocupado. Hoy empieza ahora, no a primera hora.
 */
export function dayWindows(input: {
  days: string[];
  today: string;
  nowMin: number;
  dayStart: number;
  dayEnd: number;
  events: { day: string; start: number | null; end: number | null; title: string }[];
  blocks: { day: string; start_min: number; end_min: number; title: string }[];
}): DayWindow[] {
  return input.days
    .filter((d) => d >= input.today)
    .map((day) => ({
      day,
      from: day === input.today ? Math.max(input.dayStart * 60, ceil15(input.nowMin)) : input.dayStart * 60,
      to: input.dayEnd * 60,
      busy: [
        ...input.events
          .filter((e) => e.day === day && e.start != null)
          .map((e) => ({ start: e.start!, end: e.end ?? e.start! + 60, label: e.title })),
        ...input.blocks
          .filter((b) => b.day === day)
          .map((b) => ({ start: b.start_min, end: b.end_min, label: b.title })),
      ],
    }))
    .filter((w) => w.to - w.from > 0);
}

/** Por qué este hueco: lo que hay justo antes, o que es el comienzo del día. */
function gapReason(w: DayWindow, start: number): string {
  const antes = w.busy.filter((b) => b.end <= start).sort((a, b) => b.end - a.end)[0];
  if (antes && start - antes.end <= 30 && antes.label) return `después de ${antes.label}`;
  if (start === w.from) return "al empezar tu horario";
  return "en un rato libre";
}

export type Slot = { day: string; start: number; end: number; why: string };

/** El primer hueco de `minutes` en esas ventanas, en orden. */
export function findSlot(windows: DayWindow[], minutes: number): Slot | null {
  for (const w of windows) {
    for (const g of freeGaps(w.busy, w.from, w.to, minutes)) {
      const start = ceil15(g.start);
      if (start + minutes <= g.end) {
        return { day: w.day, start, end: start + minutes, why: `${gapReason(w, start)}, hueco de ${fmtMin(g.end - g.start)}` };
      }
    }
  }
  return null;
}

/** Minutos libres de un día. */
export const freeMinutes = (w: DayWindow) =>
  freeGaps(w.busy, w.from, w.to, 1).reduce((a, g) => a + (g.end - g.start), 0);

const fmtMin = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

/* ------------------------------------------------ plan de preparación */

export type PrepSession = { day: string; start: number; end: number; minutes: number; why: string; review: boolean };

export type PrepResult = {
  sessions: PrepSession[];
  /** Minutos que no cupieron antes del deadline. */
  shortfall: number;
};

/** Lo máximo de este plan en un día normal: más que eso ya no se aprovecha. */
export const PREP_DAY_CAP = 120;
/** El día antes del deadline, sólo un repaso: nada de atracones. */
export const PREP_LAST_DAY_CAP = 60;
/** Margen entre dos sesiones del mismo plan el mismo día. */
const BREAK = 15;

/**
 * Reparte `totalMin` de preparación entre hoy y el día ANTES del deadline.
 *
 * Reglas, todas deterministas:
 *  - nunca el día del deadline ni después;
 *  - el día anterior, como mucho un repaso corto (60 min);
 *  - el día en que vence OTRA entrega importante, nada; el día antes de esa, poco;
 *  - como mucho 2 h de este plan por día;
 *  - sólo en huecos libres de verdad (clases, eventos y tus bloques cuentan);
 *  - repartido parejo en el tiempo, no amontonado al principio ni al final.
 *
 * Lo que no cabe se devuelve como `shortfall`, para decirlo en vez de
 * esconderlo.
 */
export function planPrep(input: {
  windows: DayWindow[];
  dueDate: string;
  totalMin: number;
  sessionMin: number;
  /** Otras entregas importantes: día → título. */
  otherDeadlines: { day: string; title: string }[];
}): PrepResult {
  const session = Math.min(120, Math.max(30, Math.round(input.sessionMin / 15) * 15));
  const total = Math.max(0, Math.round(input.totalMin));
  const ultimo = addDays(input.dueDate, -1);

  const otros = new Map<string, string>();
  for (const d of input.otherDeadlines) if (!otros.has(d.day)) otros.set(d.day, d.title);

  // Ventanas utilizables y cuánto de este plan cabe en cada una.
  const dias = input.windows
    .filter((w) => w.day <= ultimo)
    .map((w) => {
      let cap = PREP_DAY_CAP;
      let why = "";
      if (w.day === ultimo) {
        cap = PREP_LAST_DAY_CAP;
        why = "el día antes, sólo un repaso corto";
      }
      if (otros.has(w.day)) {
        cap = 0;
      } else if (otros.has(addDays(w.day, 1))) {
        cap = Math.min(cap, 60);
        why = `sesión corta: mañana vence ${otros.get(addDays(w.day, 1))}`;
      }
      return { w: { ...w, busy: [...w.busy] }, cap, used: 0, why };
    })
    .filter((d) => d.cap > 0 && freeMinutes(d.w) >= 30);

  const sessions: PrepSession[] = [];
  let pendiente = total;

  const colocar = (d: (typeof dias)[number]): boolean => {
    const quiere = Math.min(session, pendiente, d.cap - d.used);
    if (quiere < 30 && pendiente >= 30) return false;
    if (quiere <= 0) return false;
    const slot = findSlot([d.w], quiere);
    if (!slot) return false;
    d.used += quiere;
    pendiente -= quiere;
    d.w.busy.push({ start: slot.start, end: slot.end + BREAK, label: "la sesión anterior" });
    const review = d.w.day === ultimo;
    sessions.push({
      day: d.w.day, start: slot.start, end: slot.end, minutes: quiere, review,
      why: d.why || slot.why,
    });
    return true;
  };

  // Primera vuelta: días repartidos parejo entre hoy y el día anterior. Con
  // 4 sesiones y 12 días, cae más o menos cada 3 días, terminando cerca del
  // examen — no las cuatro seguidas al principio.
  const n = Math.ceil(total / session);
  if (dias.length && n) {
    const elegidos = new Set<number>();
    const k = Math.min(n, dias.length);
    for (let j = 0; j < k; j++) {
      elegidos.add(k === 1 ? dias.length - 1 : Math.round((j * (dias.length - 1)) / (k - 1)));
    }
    for (const i of [...elegidos].sort((a, b) => a - b)) {
      if (pendiente <= 0) break;
      colocar(dias[i]);
    }
  }

  // Lo que falte, en vueltas sobre todos los días con lugar, del más
  // temprano al más tardío.
  let avanzo = true;
  while (pendiente > 0 && avanzo) {
    avanzo = false;
    for (const d of dias) {
      if (pendiente <= 0) break;
      if (colocar(d)) avanzo = true;
    }
  }

  sessions.sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
  return { sessions, shortfall: Math.max(0, pendiente) };
}

/* ------------------------------------------------------ replanificar */

export type ReplanScope = "today" | "tomorrow" | "week" | "date" | "auto";

/**
 * Los días donde buscar según la opción elegida. Nunca después del deadline:
 * "Esta semana" con un deadline el miércoles es de hoy al miércoles (y ese día,
 * antes de la hora de entrega; eso lo recorta quien arma las ventanas).
 *
 * Una tarea ya atrasada no tiene límite: el deadline pasó, y lo que importa
 * es encontrarle un rato.
 */
export function replanDays(scope: ReplanScope, today: string, opts: { date?: string; due?: string | null } = {}): string[] {
  const limite = opts.due && opts.due >= today ? opts.due : null;
  const rango = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to && (!limite || d <= limite); d = addDays(d, 1)) out.push(d);
    return out;
  };
  switch (scope) {
    case "today": return rango(today, today);
    case "tomorrow": return rango(addDays(today, 1), addDays(today, 1));
    case "week": {
      // Hasta el domingo de esta semana; si hoy ya es domingo, la que viene.
      const dom = addDays(today, (7 - weekdayOf(today)) % 7 || 7);
      return rango(today, dom);
    }
    case "date": return opts.date && opts.date >= today ? rango(opts.date, opts.date) : [];
    case "auto": return rango(today, addDays(today, 13));
  }
}

/**
 * "Esta semana": el día más liviano, no el primero. Lo liviano se mide en
 * minutos libres; a igualdad, el más cercano.
 */
export function lightestFirst(windows: DayWindow[]): DayWindow[] {
  return [...windows].sort((a, b) => freeMinutes(b) - freeMinutes(a) || a.day.localeCompare(b.day));
}

export const describeSlot = (s: { start: number; end: number }) => `${minsToHHMM(s.start)}–${minsToHHMM(s.end)}`;

import { addDays, startOfWeek } from "./date";
import { mergeBusy } from "./schedule";
import type { Task, TaskKind } from "./types";

/**
 * La carga que viene: "Próximos 14 días: 2 midterms + 1 proyecto".
 *
 * Determinista y sin Claude: cuenta lo que está en tus tareas, con el tipo
 * que tienen (de Canvas o corregido a mano). Si una tarea no tiene tipo, no
 * se adivina; cuenta como una entrega más.
 */

/** Lo que pesa de verdad en el semestre, en el orden en que se nombra. */
export const MAJOR: TaskKind[] = ["final", "midterm", "project", "presentation", "quiz"];

const NOMBRE: Record<TaskKind, [string, string]> = {
  final: ["final", "finales"],
  midterm: ["midterm", "midterms"],
  project: ["proyecto", "proyectos"],
  presentation: ["presentación", "presentaciones"],
  quiz: ["quiz", "quizzes"],
  assignment: ["entrega", "entregas"],
  reading: ["lectura", "lecturas"],
  other: ["otra", "otras"],
};

export const kindLabel = (k: TaskKind, n = 1) => NOMBRE[k][n === 1 ? 0 : 1];

export type Workload = {
  days: number;
  /** Las importantes, pendientes, dentro de la ventana, por fecha. */
  majors: Task[];
  counts: Partial<Record<TaskKind, number>>;
  /** El resto de lo que vence en la ventana. */
  others: number;
  /** "Próximos 14 días: 2 midterms + 1 proyecto", o null si no hay nada que destacar. */
  line: string | null;
  /** Suma de los pesos conocidos de las importantes, y cuántas lo tenían. */
  weight: { pct: number; known: number } | null;
  /** Semanas con dos o más importantes: ahí es donde hace falta empezar antes. */
  heavyWeeks: { monday: string; count: number; kinds: string }[];
};

/** "2 midterms + 1 proyecto". */
export function countPhrase(counts: Partial<Record<TaskKind, number>>, order: TaskKind[] = MAJOR): string {
  return order
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${kindLabel(k, counts[k])}`)
    .join(" + ");
}

export function upcomingWorkload(tasks: Task[], today: string, days = 14): Workload {
  const last = addDays(today, days - 1);
  const enVentana = tasks.filter(
    (t) => !t.done && !t.deleted_at && t.due_date && t.due_date >= today && t.due_date <= last,
  );
  const majors = enVentana
    .filter((t) => t.kind && MAJOR.includes(t.kind))
    .sort((a, b) => a.due_date!.localeCompare(b.due_date!) || a.priority - b.priority);

  const counts: Partial<Record<TaskKind, number>> = {};
  for (const t of majors) counts[t.kind!] = (counts[t.kind!] ?? 0) + 1;
  const others = enVentana.length - majors.length;

  let line: string | null = null;
  if (majors.length) {
    line = `Próximos ${days} días: ${countPhrase(counts)}`;
  } else if (others >= 5) {
    // Sin exámenes ni proyectos, pero con muchas entregas juntas, también vale decirlo.
    line = `Próximos ${days} días: ${others} entregas`;
  }

  const conPeso = majors.filter((t) => t.weight_pct != null);
  const weight = conPeso.length
    ? { pct: Math.round(conPeso.reduce((a, t) => a + Number(t.weight_pct), 0) * 10) / 10, known: conPeso.length }
    : null;

  const semanas = new Map<string, Task[]>();
  for (const t of majors) {
    const lunes = startOfWeek(t.due_date!);
    semanas.set(lunes, [...(semanas.get(lunes) ?? []), t]);
  }
  const heavyWeeks = [...semanas]
    .filter(([, ts]) => ts.length >= 2)
    .map(([monday, ts]) => {
      const c: Partial<Record<TaskKind, number>> = {};
      for (const t of ts) c[t.kind!] = (c[t.kind!] ?? 0) + 1;
      return { monday, count: ts.length, kinds: countPhrase(c) };
    });

  return { days, majors, counts, others, line, weight, heavyWeeks };
}

/**
 * Cuánto del día ya está comprometido: clases, eventos y bloques agendados,
 * sin contar dos veces lo que se pisa y sólo dentro de tu horario. Lo que
 * vence ese día no suma: el trabajo de una entrega se hace antes, y su
 * duración no se sabe.
 *
 * Tres niveles y horas redondeadas a la media hora: es para ver de un
 * vistazo qué día está lleno, no para medir.
 */
export type DayLoad = { level: 0 | 1 | 2 | 3; minutes: number; word: string; label: string };

const NIVEL = ["libre", "ligero", "medio", "lleno"] as const;

export function dayLoad(input: {
  day: string;
  dayStart: number;
  dayEnd: number;
  events: { day: string; start: number | null; end: number | null }[];
  blocks: { day: string; start_min: number; end_min: number }[];
}): DayLoad {
  const from = input.dayStart * 60, to = input.dayEnd * 60;
  const busy = mergeBusy([
    ...input.events.filter((e) => e.day === input.day && e.start != null).map((e) => ({ start: e.start!, end: e.end ?? e.start! + 60 })),
    ...input.blocks.filter((b) => b.day === input.day).map((b) => ({ start: b.start_min, end: b.end_min })),
  ]);
  const minutes = busy.reduce((s, b) => s + Math.max(0, Math.min(b.end, to) - Math.max(b.start, from)), 0);
  const ratio = to > from ? minutes / (to - from) : 0;
  const level = minutes < 60 ? 0 : ratio < 0.25 ? 1 : ratio < 0.45 ? 2 : 3;
  const horas = Math.round(minutes / 30) / 2;
  const word = NIVEL[level];
  const label = minutes < 30 ? `Carga del día: ${word}` : `Carga del día: ${word}, unas ${String(horas).replace(".", ",")} h ocupadas`;
  return { level, minutes, word, label };
}

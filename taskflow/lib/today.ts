import { addDays, daysBetween, minsToHHMM } from "./date";
import type { Block, DayEvent, Task } from "./types";
import { kindLabel } from "./workload";

/**
 * Las líneas de contexto de Hoy: qué viene, cuánto tiempo libre hay y qué
 * entrega importante se acerca. Sólo datos tuyos, nada de frases motivadoras.
 * Puro: recibe la hora y la agenda, devuelve texto.
 */

const fmt = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

/** Lo que cuenta como entrega importante para avisar con días de anticipación. */
const IMPORTANTES = new Set(["final", "midterm", "project", "presentation", "quiz"]);

export type TodayContext = {
  /** Lo que está pasando ahora. */
  current: { title: string; end: number } | null;
  /** El siguiente compromiso con hora. */
  next: { title: string; start: number; inMin: number } | null;
  /** El rato libre que hay desde ahora hasta el próximo compromiso. */
  gap: { minutes: number; until: number | null } | null;
  /** La entrega importante más cercana de la semana. */
  deadline: { task: Task; days: number } | null;
  lines: string[];
};

export function todayContext(input: {
  nowMin: number;
  today: string;
  dayEnd: number;
  events: DayEvent[];
  blocks: Block[];
  tasks: Task[];
}): TodayContext {
  const { nowMin, today } = input;
  const ocupado = [
    ...input.events.filter((e) => e.day === today && e.start != null).map((e) => ({ title: e.title, start: e.start!, end: e.end ?? e.start! + 60 })),
    ...input.blocks.filter((b) => b.day === today).map((b) => ({ title: b.title, start: b.start_min, end: b.end_min })),
  ].sort((a, b) => a.start - b.start);

  const current = ocupado.find((o) => o.start <= nowMin && nowMin < o.end) ?? null;
  const prox = ocupado.find((o) => o.start > nowMin) ?? null;
  const next = prox ? { title: prox.title, start: prox.start, inMin: prox.start - nowMin } : null;

  // Hueco: desde ahora (o desde que termine lo de ahora) hasta lo siguiente.
  const desde = current ? current.end : nowMin;
  const finDia = input.dayEnd * 60;
  const siguiente = ocupado.find((o) => o.start >= desde) ?? null;
  const hasta = siguiente ? siguiente.start : finDia;
  const libre = hasta - desde;
  const gap = libre >= 30 && desde < finDia ? { minutes: libre, until: siguiente ? siguiente.start : null } : null;

  const deadline =
    input.tasks
      .filter((t) => !t.done && !t.deleted_at && t.kind && IMPORTANTES.has(t.kind) && t.due_date && t.due_date >= today && t.due_date <= addDays(today, 7))
      .sort((a, b) => a.due_date!.localeCompare(b.due_date!))
      .map((task) => ({ task, days: daysBetween(today, task.due_date!) }))[0] ?? null;

  const lines: string[] = [];
  if (current) lines.push(`Ahora: ${current.title}, hasta las ${minsToHHMM(current.end)}`);
  if (next) {
    lines.push(next.inMin <= 120 ? `Próximo: ${next.title} en ${fmt(next.inMin)}` : `Próximo: ${next.title} a las ${minsToHHMM(next.start)}`);
  } else if (!current && nowMin < finDia) {
    lines.push("Sin más compromisos hoy");
  }
  if (gap && (next || current)) {
    lines.push(`Tienes un hueco de ${fmt(gap.minutes)}${gap.until != null ? ` hasta las ${minsToHHMM(gap.until)}` : ""}`);
  }
  if (deadline) {
    const t = deadline.task;
    const quien = t.course ?? t.title;
    const que = t.course ? `: ${t.kind ? kindLabel(t.kind) : t.title}` : "";
    const cuando = deadline.days === 0 ? "vence hoy" : deadline.days === 1 ? "vence mañana" : `vence en ${deadline.days} días`;
    lines.push(`${quien} ${cuando}${que}`);
  }

  return { current, next, gap, deadline, lines };
}

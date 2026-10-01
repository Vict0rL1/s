import "server-only";

import { q } from "./activity";
import { type Ctx, loadBlocks, loadEvents, loadTasks } from "./data";
import { addDays, minutesInTz, timeToMins } from "./date";
import {
  type DayWindow,
  type ReplanScope,
  type Slot,
  dayWindows,
  findSlot,
  lightestFirst,
  planPrep,
  replanDays,
} from "./schedule";
import type { Task, TaskKind } from "./types";

/** Para qué tiene sentido un plan de preparación de varios días. */
export const PREP_KINDS: TaskKind[] = ["midterm", "final", "project", "presentation"];

export const canPrep = (t: Task, today: string) =>
  !t.done && !t.deleted_at && Boolean(t.kind && PREP_KINDS.includes(t.kind)) && Boolean(t.due_date && t.due_date > today);

/**
 * Un punto de partida para el tiempo total, si la tarea no tiene estimado.
 * Es sólo eso: el formulario lo muestra y se cambia antes de pedir nada.
 */
export function suggestedTotal(t: Task): number {
  if (t.est_minutes) return t.est_minutes;
  const base: Partial<Record<TaskKind, number>> = { midterm: 360, final: 600, project: 600, presentation: 180 };
  const b = (t.kind && base[t.kind]) || 240;
  return t.difficulty === 3 ? Math.round(b * 1.5) : t.difficulty === 1 ? Math.round(b * 0.75) : b;
}

/** Las ventanas libres de esos días: horario del perfil menos clases, eventos y bloques. */
export async function loadWindows(ctx: Ctx, days: string[]): Promise<DayWindow[]> {
  if (!days.length) return [];
  const from = days[0];
  const to = days[days.length - 1];
  const [events, blocks] = await Promise.all([loadEvents(ctx, from, to), loadBlocks(ctx, from, to)]);
  return dayWindows({
    days,
    today: ctx.today,
    nowMin: minutesInTz(ctx.tz),
    dayStart: ctx.profile.day_start,
    dayEnd: ctx.profile.day_end,
    events,
    blocks,
  });
}

/* ------------------------------------------------ plan de preparación */

export type PrepProposalSession = {
  day: string;
  start: number;
  end: number;
  minutes: number;
  why: string;
  review: boolean;
  title: string;
};

export type PrepProposal = { sessions: PrepProposalSession[]; shortfall: number; totalMin: number };

export function defaultSessionTitles(task: Task, sessions: { review: boolean }[]): string[] {
  const n = sessions.filter((s) => !s.review).length;
  let i = 0;
  return sessions.map((s) => (s.review ? `Repaso corto: ${task.title}` : `Preparar ${task.title} (${++i}/${n})`).slice(0, 120));
}

/**
 * La propuesta de sesiones para preparar `task`. Sólo lee: nada se escribe
 * hasta que se acepta.
 */
export async function prepProposal(
  ctx: Ctx,
  task: Task,
  opts: { totalMin: number; sessionMin: number },
): Promise<PrepProposal> {
  const days: string[] = [];
  for (let d = ctx.today; d < task.due_date!; d = addDays(d, 1)) days.push(d);

  const [windows, tasks] = await Promise.all([loadWindows(ctx, days), loadTasks(ctx)]);

  // Otras entregas importantes antes de esta: esos días no se tocan.
  const otherDeadlines = tasks
    .filter(
      (t) => t.id !== task.id && !t.done && t.kind && PREP_KINDS.includes(t.kind) &&
        t.due_date && t.due_date >= ctx.today && t.due_date < task.due_date!,
    )
    .map((t) => ({ day: t.due_date!, title: q(t.title) }));

  const r = planPrep({
    windows,
    dueDate: task.due_date!,
    totalMin: opts.totalMin,
    sessionMin: opts.sessionMin,
    otherDeadlines,
  });
  const titles = defaultSessionTitles(task, r.sessions);
  return {
    sessions: r.sessions.map((s, i) => ({ ...s, title: titles[i] })),
    shortfall: r.shortfall,
    totalMin: opts.totalMin,
  };
}

/* ------------------------------------------------------ replanificar */

export type ReplanProposal = { slot: Slot | null; message: string; overdue: boolean };

const SCOPE_TEXT: Record<ReplanScope, string> = {
  today: "hoy",
  tomorrow: "mañana",
  week: "esta semana",
  date: "ese día",
  auto: "las próximas dos semanas",
};

/**
 * Un hueco para trabajar en `task`, según la opción elegida. Sólo lee.
 *
 * Nunca después del deadline, y el día del deadline, antes de la hora de
 * entrega. Si la tarea ya está atrasada, se busca igual y se dice.
 */
export async function replanProposal(
  ctx: Ctx,
  task: Task,
  opts: { scope: ReplanScope; date?: string; minutes: number },
): Promise<ReplanProposal> {
  const overdue = Boolean(task.due_date && task.due_date < ctx.today);
  const days = replanDays(opts.scope, ctx.today, { date: opts.date, due: task.due_date });
  if (!days.length) {
    const tarde = task.due_date && opts.scope !== "date" ? " sin pasarse del deadline" : "";
    return { slot: null, overdue, message: `No hay días para buscar ${SCOPE_TEXT[opts.scope]}${tarde}.` };
  }

  let windows = await loadWindows(ctx, days);
  const dueMin = timeToMins(task.due_time);
  if (!overdue && task.due_date && dueMin != null) {
    windows = windows.map((w) => (w.day === task.due_date ? { ...w, to: Math.min(w.to, dueMin) } : w));
  }
  if (opts.scope === "week") windows = lightestFirst(windows);

  const slot = findSlot(windows, opts.minutes);
  return {
    slot,
    overdue,
    message: slot ? "" : `No hay un hueco de ${opts.minutes} min ${SCOPE_TEXT[opts.scope]}. Prueba con menos tiempo u otro día.`,
  };
}

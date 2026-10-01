import { addDays, weekdayOf, zonedDayMinute } from "./date";
import type { Habit } from "./types";

/** Cuántos días hacia atrás se carga el historial para rachas y puntitos. */
export const HABIT_WINDOW = 120;

export const habitsOn = (habits: Habit[], day: string) =>
  habits.filter((h) => !h.days?.length || h.days.includes(weekdayOf(day)));

export const didHabit = (log: Map<string, Set<string>>, day: string, id: string) =>
  log.get(day)?.has(id) ?? false;

/**
 * Racha de días cumplidos, contando sólo los días en que la rutina aplica.
 * Portado de `streak()` del reference: si hoy todavía no se marca, la racha se
 * mide desde ayer, porque el día sigue en curso y no cuenta como roto.
 */
export function streak(habit: Habit, log: Map<string, Set<string>>, today: string): number {
  let n = 0;
  let day = today;
  if (!didHabit(log, today, habit.id)) day = addDays(today, -1);

  for (let i = 0; i < HABIT_WINDOW; i++) {
    if (!habit.days?.length || habit.days.includes(weekdayOf(day))) {
      if (didHabit(log, day, habit.id)) n++;
      else break;
    }
    day = addDays(day, -1);
  }
  return n;
}

/** Los últimos `n` días terminando en `day`, del más viejo al más nuevo. */
export function lastDays(day: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(day, -i));
  return out;
}

const aplica = (habit: Habit, day: string) => !habit.days?.length || habit.days.includes(weekdayOf(day));

/**
 * El primer día que cuenta: el de creación (en tu zona, no en UTC) o el día
 * en que se reanudó después de una pausa. Lo de antes no es un día fallado.
 *
 * Si hay marcas anteriores a la creación (una rutina que vino de un
 * respaldo, por ejemplo), cuenta desde la primera: es claro que ya existía.
 */
export function habitSince(habit: Habit, tz: string, log?: Map<string, Set<string>>): string {
  let desde = habit.created_at ? zonedDayMinute(habit.created_at, tz).date : "0000-01-01";
  for (const [day, ids] of log ?? []) if (day < desde && ids.has(habit.id)) desde = day;
  return habit.active_from && habit.active_from > desde ? habit.active_from : desde;
}

export type Compliance = { done: number; scheduled: number; pct: number | null };

/**
 * Cumplimiento de los últimos `days` días: de los días en que tocaba, en
 * cuántos se hizo. Hoy cuenta sólo si ya está hecho (el día sigue en curso),
 * y nada de antes de `since`. Hacerla un día que no tocaba no suma ni resta:
 * así nunca pasa del 100 % ni castiga hacer de más.
 */
export function compliance(habit: Habit, log: Map<string, Set<string>>, today: string, days: number, since: string): Compliance {
  let done = 0, scheduled = 0;
  for (const d of lastDays(today, days)) {
    if (d < since || !aplica(habit, d)) continue;
    const hecho = didHabit(log, d, habit.id);
    if (d === today && !hecho) continue;
    scheduled++;
    if (hecho) done++;
  }
  return { done, scheduled, pct: scheduled ? Math.round((done / scheduled) * 100) : null };
}

/** "86 %" o "—" si todavía no tocó ningún día. */
export const pctText = (c: Compliance) => (c.pct == null ? "—" : `${c.pct} %`);

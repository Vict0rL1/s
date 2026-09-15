import { addDays, weekdayOf } from "./date";
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

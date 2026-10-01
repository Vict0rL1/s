/** Filas tal como están en `supabase/schema.sql`. */

export type ItemSource = "manual" | "canvas" | "gcal" | "ics";

export const TASK_KINDS = ["assignment", "quiz", "midterm", "final", "project", "presentation", "reading", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type BlockKind = "tarea" | "descanso" | "clase";

export type Profile = {
  id: string;
  areas: string[];
  day_start: number;
  day_end: number;
  timezone: string;
  created_at: string;
};

export type Task = {
  id: string;
  user_id: string;
  title: string;
  area: string | null;
  /** "YYYY-MM-DD" */
  due_date: string | null;
  /** "HH:MM:SS" — hora local, sin zona. */
  due_time: string | null;
  est_minutes: number | null;
  /** 1 alta · 2 media · 3 baja. */
  priority: number;
  done: boolean;
  done_at: string | null;
  body: string | null;
  source: ItemSource;
  external_id: string | null;
  external_url: string | null;
  focus_day: string | null;
  user_edited_at: string | null;
  /** En la papelera desde entonces; null si está viva. */
  deleted_at: string | null;
  kind: TaskKind | null;
  /** "ECON 342". */
  course: string | null;
  /** Peso en la nota, 0–100. Sólo si lo escribiste tú. */
  weight_pct: number | null;
  /** 1 baja · 2 media · 3 alta. */
  difficulty: number | null;
  /** Segundos medidos con el cronómetro (sin contar la sesión en marcha). */
  tracked_sec: number;
  track_sessions: number;
  /** Si el cronómetro está corriendo, desde cuándo. */
  track_started_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EventRow = {
  id: string;
  user_id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  all_day_date: string | null;
  location: string | null;
  course_ref: string | null;
  source: ItemSource;
  external_id: string;
  created_at: string;
  updated_at: string;
};

export type Note = {
  id: string;
  user_id: string;
  body: string;
  pinned: boolean;
  deleted_at: string | null;
  created_at: string;
};

export type Habit = {
  id: string;
  user_id: string;
  name: string;
  /** Días en que aplica, 0 = domingo. */
  days: number[];
  /** En pausa: no aparece en Hoy ni cuenta para el cumplimiento. */
  archived: boolean;
  sort_order: number;
  created_at: string;
  /** Si se muestra la racha de días seguidos. */
  show_streak: boolean;
  /** Desde cuándo cuenta el cumplimiento, si se reanudó después de una pausa. */
  active_from: string | null;
};

export type HabitLog = { habit_id: string; user_id: string; day: string };

export type Block = {
  id: string;
  user_id: string;
  day: string;
  /** Minutos desde medianoche, hora local. */
  start_min: number;
  end_min: number;
  title: string;
  kind: BlockKind;
  task_id: string | null;
  created_at: string;
};

/** Un evento ya traducido a la zona del usuario, listo para pintar. */
export type DayEvent = {
  id: string;
  title: string;
  /** "YYYY-MM-DD" local. */
  day: string;
  /** Minutos desde medianoche, o null si es de día completo. */
  start: number | null;
  end: number | null;
  source: ItemSource;
  courseRef: string | null;
};

/** Filas tal como están en `supabase/schema.sql`. */

export type ItemSource = "manual" | "canvas" | "gcal" | "ics";
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
  created_at: string;
};

export type Habit = {
  id: string;
  user_id: string;
  name: string;
  /** Días en que aplica, 0 = domingo. */
  days: number[];
  archived: boolean;
  sort_order: number;
  created_at: string;
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

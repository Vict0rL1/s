import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";
import { DEFAULT_TIMEZONE, addDays, todayInTz, weekdayOf, zonedDayMinute } from "./date";
import type { Block, DayEvent, EventRow, Habit, Note, Profile, Task } from "./types";

const DEFAULT_AREAS = ["SFU", "FINSA", "Badminton", "Proyectos", "Personal"];

export type Ctx = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  profile: Profile;
  /** Zona del perfil, no la del servidor. */
  tz: string;
  /** "YYYY-MM-DD" de hoy en `tz`. */
  today: string;
};

/**
 * Sesión + perfil. Todas las páginas empiezan por aquí.
 * Si no hay sesión, al login (el middleware ya lo hace; esto cubre el resto).
 */
export async function getCtx(): Promise<Ctx> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", auth.user.id)
    .maybeSingle<Profile>();

  // El trigger `on_auth_user_created` lo crea al registrarse. Esto es el
  // paracaídas para un usuario que ya existía antes de aplicar el esquema.
  let profile = data;
  if (!profile) {
    const { data: created } = await supabase
      .from("profiles")
      .upsert({ id: auth.user.id }, { onConflict: "id" })
      .select("*")
      .maybeSingle<Profile>();
    profile = created ?? {
      id: auth.user.id,
      areas: DEFAULT_AREAS,
      day_start: 7,
      day_end: 23,
      timezone: DEFAULT_TIMEZONE,
      created_at: new Date().toISOString(),
    };
  }

  const tz = profile.timezone || DEFAULT_TIMEZONE;
  return { supabase, userId: auth.user.id, profile, tz, today: todayInTz(tz) };
}

/* ------------------------------------------------------------------ tareas */

export async function loadTasks(ctx: Ctx): Promise<Task[]> {
  const { data } = await ctx.supabase
    .from("tasks")
    .select("*")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false })
    .returns<Task[]>();
  return data ?? [];
}

/* -------------------------------------------------------------- calendario */

/**
 * Eventos que caen entre dos días locales, ya convertidos a la zona del
 * usuario. El rango se abre un día por lado porque un evento a las 23:00 en
 * Vancouver es del día siguiente en UTC.
 */
export async function loadEvents(ctx: Ctx, from: string, to: string): Promise<DayEvent[]> {
  const lo = addDays(from, -1), hi = addDays(to, 1);

  // Dos consultas simples en vez de un `or(and(...),and(...))`. Da lo mismo en
  // resultado, pero cada una es evidente de leer y no depende de armar bien una
  // cadena de filtros: es una capa menos donde equivocarse en silencio.
  const [timed, allDay] = await Promise.all([
    ctx.supabase
      .from("events")
      .select("*")
      .gte("starts_at", `${lo}T00:00:00Z`)
      .lte("starts_at", `${hi}T23:59:59Z`)
      .returns<EventRow[]>(),
    ctx.supabase
      .from("events")
      .select("*")
      .gte("all_day_date", from)
      .lte("all_day_date", to)
      .returns<EventRow[]>(),
  ]);

  const out: DayEvent[] = [];
  for (const e of [...(timed.data ?? []), ...(allDay.data ?? [])]) {
    if (e.all_day_date) {
      if (e.all_day_date < from || e.all_day_date > to) continue;
      out.push({
        id: e.id, title: e.title, day: e.all_day_date, start: null, end: null,
        source: e.source, courseRef: e.course_ref,
      });
      continue;
    }
    if (!e.starts_at) continue;

    const s = zonedDayMinute(e.starts_at, ctx.tz);
    if (s.date < from || s.date > to) continue;

    let end: number | null = s.min + 60;
    if (e.ends_at) {
      const t = zonedDayMinute(e.ends_at, ctx.tz);
      // Un evento que cruza medianoche se corta al final del día.
      end = t.date === s.date ? t.min : 1440;
    }
    out.push({
      id: e.id, title: e.title, day: s.date, start: s.min, end,
      source: e.source, courseRef: e.course_ref,
    });
  }

  return out.sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1
      : a.start == null ? -1 : b.start == null ? 1 : a.start - b.start,
  );
}

/** Fuentes `.ics` importadas, con su conteo. Para la vista de Ajustes. */
export async function loadIcsSources(ctx: Ctx): Promise<{ name: string; count: number }[]> {
  const { data } = await ctx.supabase
    .from("events")
    .select("course_ref")
    .eq("source", "ics")
    .returns<{ course_ref: string | null }[]>();

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const name = row.course_ref || "Calendario";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------- notas y rutinas */

export async function loadNotes(ctx: Ctx): Promise<Note[]> {
  const { data } = await ctx.supabase
    .from("notes")
    .select("*")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .returns<Note[]>();
  return data ?? [];
}

export async function loadHabits(ctx: Ctx): Promise<Habit[]> {
  const { data } = await ctx.supabase
    .from("habits")
    .select("*")
    .eq("archived", false)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .returns<Habit[]>();
  return data ?? [];
}

/** Marcas de rutinas por día: { "2026-09-15": Set<habitId> }. */
export async function loadHabitLog(ctx: Ctx, from: string, to: string): Promise<Map<string, Set<string>>> {
  const { data } = await ctx.supabase
    .from("habit_log")
    .select("habit_id, day")
    .gte("day", from)
    .lte("day", to)
    .returns<{ habit_id: string; day: string }[]>();

  const map = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    const set = map.get(row.day) ?? new Set<string>();
    set.add(row.habit_id);
    map.set(row.day, set);
  }
  return map;
}

/* ----------------------------------------------------------------- bloques */

export async function loadBlocks(ctx: Ctx, from: string, to: string): Promise<Block[]> {
  const { data } = await ctx.supabase
    .from("blocks")
    .select("*")
    .gte("day", from)
    .lte("day", to)
    .order("start_min", { ascending: true })
    .returns<Block[]>();
  return data ?? [];
}

/* --------------------------------------------------------- estado del sync */

export type SyncState = {
  source: string;
  last_synced_at: string | null;
  last_error: string | null;
  items_synced: number;
};

export async function loadSyncState(ctx: Ctx, source: string): Promise<SyncState | null> {
  const { data } = await ctx.supabase
    .from("sync_state")
    .select("source, last_synced_at, last_error, items_synced")
    .eq("source", source)
    .maybeSingle<SyncState>();
  return data ?? null;
}

/* -------------------------------------------------------------- contadores */

export type Counts = {
  hoy: number;
  tareas: number;
  semana: number;
  notas: number;
  rutinas: number;
};

/** Los numeritos del riel. Una consulta de conteo por vista. */
export async function loadCounts(ctx: Ctx): Promise<Counts> {
  const from = addDays(ctx.today, -3);
  const to = addDays(ctx.today, 7);

  const [dueToday, openTasks, notes, timedEvents, allDayEvents, habits, log] = await Promise.all([
    ctx.supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("done", false).lte("due_date", ctx.today),
    ctx.supabase.from("tasks").select("id", { count: "exact", head: true }).eq("done", false),
    ctx.supabase.from("notes").select("id", { count: "exact", head: true }),
    ctx.supabase.from("events").select("id", { count: "exact", head: true })
      .gte("starts_at", `${from}T00:00:00Z`).lte("starts_at", `${to}T23:59:59Z`),
    ctx.supabase.from("events").select("id", { count: "exact", head: true })
      .gte("all_day_date", from).lte("all_day_date", to),
    loadHabits(ctx),
    loadHabitLog(ctx, ctx.today, ctx.today),
  ]);

  const doneToday = log.get(ctx.today) ?? new Set<string>();
  const wd = weekdayOf(ctx.today);
  const pending = habits.filter((h) => h.days.includes(wd) && !doneToday.has(h.id)).length;

  return {
    hoy: dueToday.count ?? 0,
    tareas: openTasks.count ?? 0,
    semana: (timedEvents.count ?? 0) + (allDayEvents.count ?? 0),
    notas: notes.count ?? 0,
    rutinas: pending,
  };
}

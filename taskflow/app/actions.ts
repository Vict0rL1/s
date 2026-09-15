"use server";

import { revalidatePath } from "next/cache";
import { getCtx } from "@/lib/data";
import { parseInput } from "@/lib/parse";
import { cleanSourceName, parseICS } from "@/lib/ics";
import { minsToTime, todayInTz } from "@/lib/date";

export type ActionResult = { ok: boolean; message: string };

const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string): ActionResult => ({ ok: false, message });

function refresh() {
  // Revalida el layout entero: los contadores del riel salen de ahí.
  revalidatePath("/", "layout");
}

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

/**
 * Marca la fila como tocada a mano. A partir de aquí el sync sólo puede
 * refrescar título y fecha — nunca `done`, `priority`, `area` ni `est_minutes`.
 * Es la regla que hace que la app se siga usando (CLAUDE.md).
 */
const EDITED = () => ({ user_edited_at: new Date().toISOString() });

/* ---------------------------------------------------------- captura rápida */

export async function capture(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const raw = str(fd, "text");
  const mode = str(fd, "mode") || "tarea";
  if (!raw) return fail("");

  const ctx = await getCtx();
  const p = parseInput(raw, { areas: ctx.profile.areas, today: ctx.today });

  if (mode === "nota") {
    const { error } = await ctx.supabase.from("notes").insert({ user_id: ctx.userId, body: raw });
    if (error) return fail("No se pudo guardar la nota");
    refresh();
    return ok("Nota guardada");
  }

  if (mode === "bloque") {
    if (p.start === null) return fail("Un bloque necesita hora — ej. «Estudiar 3pm 90m»");
    if (!p.title) return fail("Falta el texto del bloque");
    const day = p.due ?? ctx.today;
    const { error } = await ctx.supabase.from("blocks").insert({
      user_id: ctx.userId,
      day,
      start_min: p.start,
      end_min: Math.min(1440, p.start + (p.dur || 60)),
      title: p.title.slice(0, 120),
      kind: "tarea",
    });
    if (error) return fail("No se pudo crear el bloque");
    refresh();
    return ok("Bloque agendado");
  }

  if (!p.title) return fail("Falta el texto de la tarea");
  const { error } = await ctx.supabase.from("tasks").insert({
    user_id: ctx.userId,
    title: p.title.slice(0, 200),
    area: p.area || null,
    due_date: p.due,
    due_time: minsToTime(p.start),
    est_minutes: p.dur || null,
    priority: p.prio || 3,
    source: "manual",
    ...EDITED(),
  });
  if (error) return fail("No se pudo crear la tarea");
  refresh();
  return ok("Tarea agregada");
}

/* ------------------------------------------------------------------ tareas */

export async function toggleTask(fd: FormData) {
  const id = str(fd, "id");
  const ctx = await getCtx();
  const { data } = await ctx.supabase.from("tasks").select("done").eq("id", id).maybeSingle<{ done: boolean }>();
  if (!data) return;

  const done = !data.done;
  await ctx.supabase
    .from("tasks")
    .update({ done, done_at: done ? new Date().toISOString() : null, ...EDITED() })
    .eq("id", id);
  refresh();
}

export async function deleteTask(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase.from("tasks").delete().eq("id", str(fd, "id"));
  refresh();
}

/** Fija o quita una tarea del enfoque de hoy. Máximo 3. */
export async function toggleFocus(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const ctx = await getCtx();

  const { data: task } = await ctx.supabase
    .from("tasks").select("focus_day").eq("id", id).maybeSingle<{ focus_day: string | null }>();
  if (!task) return fail("Esa tarea ya no existe");

  if (task.focus_day === ctx.today) {
    await ctx.supabase.from("tasks").update({ focus_day: null, ...EDITED() }).eq("id", id);
    refresh();
    return ok("");
  }

  const { count } = await ctx.supabase
    .from("tasks").select("id", { count: "exact", head: true }).eq("focus_day", ctx.today);
  if ((count ?? 0) >= 3) return fail("Máximo 3 en el enfoque");

  await ctx.supabase.from("tasks").update({ focus_day: ctx.today, ...EDITED() }).eq("id", id);
  refresh();
  return ok("");
}

export async function clearDoneTasks() {
  const ctx = await getCtx();
  await ctx.supabase.from("tasks").delete().eq("done", true);
  refresh();
}

/* ------------------------------------------------------------------- notas */

export async function togglePin(fd: FormData) {
  const id = str(fd, "id");
  const ctx = await getCtx();
  const { data } = await ctx.supabase.from("notes").select("pinned").eq("id", id).maybeSingle<{ pinned: boolean }>();
  if (!data) return;
  await ctx.supabase.from("notes").update({ pinned: !data.pinned }).eq("id", id);
  refresh();
}

export async function deleteNote(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase.from("notes").delete().eq("id", str(fd, "id"));
  refresh();
}

/** Convierte una nota en tarea, pasándola por el mismo parser de la captura. */
export async function noteToTask(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const ctx = await getCtx();

  const { data: note } = await ctx.supabase.from("notes").select("body").eq("id", id).maybeSingle<{ body: string }>();
  if (!note) return fail("Esa nota ya no existe");

  const p = parseInput(note.body, { areas: ctx.profile.areas, today: ctx.today });
  const { error } = await ctx.supabase.from("tasks").insert({
    user_id: ctx.userId,
    title: (p.title || note.body).slice(0, 200),
    area: p.area || null,
    due_date: p.due,
    due_time: minsToTime(p.start),
    est_minutes: p.dur || null,
    priority: p.prio || 3,
    source: "manual",
    ...EDITED(),
  });
  if (error) return fail("No se pudo convertir la nota");

  await ctx.supabase.from("notes").delete().eq("id", id);
  refresh();
  return ok("Convertida en tarea");
}

/* ----------------------------------------------------------------- rutinas */

export async function toggleHabit(fd: FormData) {
  const habitId = str(fd, "id");
  const ctx = await getCtx();
  const day = str(fd, "day") || ctx.today;

  const { data } = await ctx.supabase
    .from("habit_log").select("habit_id").eq("habit_id", habitId).eq("day", day).maybeSingle();

  if (data) await ctx.supabase.from("habit_log").delete().eq("habit_id", habitId).eq("day", day);
  else await ctx.supabase.from("habit_log").insert({ habit_id: habitId, user_id: ctx.userId, day });

  refresh();
}

export async function addHabit(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const name = str(fd, "name");
  if (!name) return fail("Ponle nombre a la rutina");

  const ctx = await getCtx();
  const days = fd.getAll("days").map((d) => Number(d)).filter((d) => d >= 0 && d <= 6);

  const { error } = await ctx.supabase.from("habits").insert({
    user_id: ctx.userId,
    name: name.slice(0, 80),
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
  });
  if (error) return fail("No se pudo crear la rutina");

  refresh();
  return ok("Rutina agregada");
}

export async function deleteHabit(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase.from("habits").delete().eq("id", str(fd, "id"));
  refresh();
}

/* ----------------------------------------------------------------- bloques */

export async function deleteBlock(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase.from("blocks").delete().eq("id", str(fd, "id"));
  refresh();
}

/* ------------------------------------------------------------------ ajustes */

export async function saveAreas(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();
  const areas = str(fd, "areas").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 12);
  if (!areas.length) return fail("Deja al menos un área");

  const { error } = await ctx.supabase.from("profiles").update({ areas }).eq("id", ctx.userId);
  if (error) return fail("No se pudieron guardar las áreas");

  refresh();
  return ok("Áreas actualizadas");
}

export async function saveHours(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();
  const a = Number(fd.get("day_start"));
  const b = Number(fd.get("day_end"));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return fail("Horas inválidas");

  const day_start = Math.max(0, Math.min(23, Math.min(a, b - 1)));
  const day_end = Math.max(day_start + 1, Math.min(24, b));

  const { error } = await ctx.supabase.from("profiles").update({ day_start, day_end }).eq("id", ctx.userId);
  if (error) return fail("No se pudo guardar el horario");

  refresh();
  return ok("Horario actualizado");
}

export async function saveTimezone(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const tz = str(fd, "timezone");
  try {
    // Valida contra ICU antes de guardar: una zona inválida rompe todas las vistas.
    todayInTz(tz);
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return fail("Esa zona horaria no existe — usa algo como America/Vancouver");
  }

  const ctx = await getCtx();
  const { error } = await ctx.supabase.from("profiles").update({ timezone: tz }).eq("id", ctx.userId);
  if (error) return fail("No se pudo guardar la zona horaria");

  refresh();
  return ok("Zona horaria actualizada");
}

/* ------------------------------------------------------------ importar .ics */

export async function importIcs(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();

  let text = str(fd, "text");
  const file = fd.get("file");
  if (!text && file instanceof File && file.size > 0) text = await file.text();
  if (!text.trim()) return fail("Sube un archivo .ics o pega su contenido");

  const source = cleanSourceName(str(fd, "name") || (file instanceof File ? file.name.replace(/\.ics$/i, "") : ""));

  let events;
  try {
    events = parseICS(text, { source, today: ctx.today, timeZone: ctx.tz });
  } catch {
    return fail("No pude leer ese archivo .ics");
  }
  if (!events.length) return fail("No encontré eventos en ese archivo");

  // Reimportar con el mismo nombre reemplaza: así un cambio de horario no deja
  // clases fantasma de la importación anterior.
  await ctx.supabase.from("events").delete().eq("source", "ics").eq("course_ref", source);

  const { error } = await ctx.supabase.from("events").insert(
    events.map((e) => ({
      user_id: ctx.userId,
      title: e.title.slice(0, 200),
      starts_at: e.startsAt,
      ends_at: e.endsAt,
      all_day_date: e.allDayDate,
      course_ref: source,
      source: "ics" as const,
      external_id: e.externalId,
    })),
  );
  if (error) return fail("No se pudieron guardar los eventos");

  refresh();
  return ok(events.length + " eventos importados de " + source);
}

export async function deleteIcsSource(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase.from("events").delete().eq("source", "ics").eq("course_ref", str(fd, "name"));
  refresh();
}

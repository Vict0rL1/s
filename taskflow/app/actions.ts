"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getCtx, loadBlocks, loadEvents } from "@/lib/data";
import { acceptable } from "@/lib/schedule";
import { parseInput } from "@/lib/parse";
import { cleanSourceName, parseICS } from "@/lib/ics";
import { runCanvasSync } from "@/lib/canvas-sync";
import { runGcalSync } from "@/lib/gcal-sync";
import { openToken, revokeToken } from "@/lib/gcal";
import { deliverPush, deliverTelegram } from "@/lib/clock";
import { logActivity, q, shortDate } from "@/lib/activity";
import { canvasConfigured, gcalConfigured, requireGoogleEnv, telegramConfigured } from "@/lib/env.server";
import { TelegramError, botUsername, ensureWebhook } from "@/lib/telegram";
import { addDays, fmtDur, minsToHHMM, minsToTime, minutesInTz, timeToMins, todayInTz } from "@/lib/date";
import { HABIT_WINDOW } from "@/lib/habits";
import { TASK_KINDS } from "@/lib/types";
import { elapsedSec } from "@/lib/timing";
import { purgeNotes, purgeTasks } from "@/lib/trash";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un id repetido: la captura ya se había guardado (un reintento). */
const yaEstaba = (e: { code?: string } | null) => e?.code === "23505";

/**
 * La barra de captura.
 *
 * `cid` es un id que genera el navegador. Con él, guardar dos veces lo mismo
 * —un reintento tras perder la conexión, o la cola de lo anotado sin red—
 * choca contra la clave primaria en vez de duplicar.
 */
export async function capture(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const raw = str(fd, "text");
  const mode = str(fd, "mode") || "tarea";
  if (!raw) return fail("");
  const id = UUID.test(str(fd, "cid")) ? str(fd, "cid") : undefined;

  const ctx = await getCtx();
  const p = parseInput(raw, { areas: ctx.profile.areas, today: ctx.today });

  if (mode === "nota") {
    const { error } = await ctx.supabase.from("notes").insert({ id, user_id: ctx.userId, body: raw });
    if (yaEstaba(error)) return ok("Esa nota ya estaba guardada");
    if (error) return fail("No se pudo guardar la nota");
    refresh();
    return ok("Nota guardada");
  }

  if (mode === "bloque") {
    if (p.start === null) return fail("Un bloque necesita hora — ej. «Estudiar 3pm 90m»");
    if (!p.title) return fail("Falta el texto del bloque");
    const day = p.due ?? ctx.today;
    const { error } = await ctx.supabase.from("blocks").insert({
      id,
      user_id: ctx.userId,
      day,
      start_min: p.start,
      end_min: Math.min(1440, p.start + (p.dur || 60)),
      title: p.title.slice(0, 120),
      kind: "tarea",
    });
    if (yaEstaba(error)) return ok("Ese bloque ya estaba guardado");
    if (error) return fail("No se pudo crear el bloque");
    refresh();
    return ok("Bloque agendado");
  }

  if (!p.title) return fail("Falta el texto de la tarea");
  const { error } = await ctx.supabase.from("tasks").insert({
    id,
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
  if (yaEstaba(error)) return ok("Esa tarea ya estaba guardada");
  if (error) return fail("No se pudo crear la tarea");
  refresh();
  return ok("Tarea agregada");
}

/* ------------------------------------------------------------------ tareas */

export async function toggleTask(fd: FormData) {
  const id = str(fd, "id");
  const ctx = await getCtx();
  const { data } = await ctx.supabase
    .from("tasks").select(`done, ${TIMER_COLS}`).eq("id", id).maybeSingle<TimerRow & { done: boolean }>();
  if (!data) return;

  const done = !data.done;
  // Marcarla hecha con el cronómetro corriendo lo cierra: el tiempo cuenta.
  if (done && data.track_started_at) await closeSession(ctx, data, Date.now());
  await ctx.supabase
    .from("tasks")
    .update({ done, done_at: done ? new Date().toISOString() : null, ...EDITED() })
    .eq("id", id);
  refresh();
}

/**
 * Manda la tarea a la papelera. No la borra: así se puede recuperar, y el sync
 * de Canvas ve que la fila existe y no la vuelve a crear (antes, una tarea de
 * Canvas borrada reaparecía pendiente en la siguiente sincronización).
 */
export async function deleteTask(fd: FormData) {
  const ctx = await getCtx();
  const enMarcha = await timerRow(ctx, str(fd, "id"));
  if (enMarcha?.track_started_at) await closeSession(ctx, enMarcha, Date.now());
  const { data } = await ctx.supabase
    .from("tasks")
    .update({ deleted_at: new Date().toISOString(), focus_day: null })
    .eq("id", str(fd, "id"))
    .select("id, title")
    .maybeSingle<{ id: string; title: string }>();
  if (data) {
    await logActivity(ctx, { actor: "user", kind: "task.trashed", taskId: data.id, summary: `Mandaste ${q(data.title)} a la papelera` });
  }
  refresh();
}

/**
 * Reescribe una tarea desde su propio título.
 *
 * Acepta la misma gramática que la captura rápida, así que «Leer cap 4 mañana»
 * corrige el texto y mueve la fecha de una sola pasada. Los campos que el
 * parser no encuentra se dejan como están: escribir sólo el título nuevo no
 * borra el área ni el estimado que ya tenías.
 */
export async function renameTask(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const raw = str(fd, "text");
  if (!raw) return fail("El título no puede quedar vacío");

  const ctx = await getCtx();
  const p = parseInput(raw, { areas: ctx.profile.areas, today: ctx.today });
  if (!p.title) return fail("Falta el texto de la tarea");

  const patch: Record<string, unknown> = { title: p.title.slice(0, 200), ...EDITED() };
  if (p.area) patch.area = p.area;
  if (p.due) patch.due_date = p.due;
  if (p.start !== null) patch.due_time = minsToTime(p.start);
  if (p.dur) patch.est_minutes = p.dur;
  if (p.prio) patch.priority = p.prio;

  const { error } = await ctx.supabase.from("tasks").update(patch).eq("id", id);
  if (error) return fail("No se pudo guardar el cambio");

  refresh();
  return ok("");
}

/**
 * Los datos académicos de una tarea: tipo, curso, peso, dificultad y
 * estimado. Todo opcional; un campo vacío lo deja en blanco.
 *
 * Cuenta como edición a mano: desde aquí el sync de Canvas sólo puede tocar
 * título y fecha de esta fila, así que tu corrección del tipo no se pierde.
 */
export async function updateTaskDetails(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const kind = str(fd, "kind");
  if (kind && !(TASK_KINDS as readonly string[]).includes(kind)) return fail("Ese tipo no existe");

  const num = (k: string, min: number, max: number, entero: boolean) => {
    const raw = str(fd, k).replace(",", ".");
    if (!raw) return { ok: true as const, v: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (entero && !Number.isInteger(n))) return { ok: false as const, v: null };
    return { ok: true as const, v: n };
  };
  const weight = num("weight_pct", 0, 100, false);
  if (!weight.ok) return fail("El % de la nota va de 0 a 100");
  const difficulty = num("difficulty", 1, 3, true);
  if (!difficulty.ok) return fail("Dificultad inválida");
  const est = num("est_minutes", 1, 1440, true);
  if (!est.ok) return fail("El tiempo va de 1 a 1440 minutos");

  const ctx = await getCtx();
  const { error } = await ctx.supabase
    .from("tasks")
    .update({
      kind: kind || null,
      course: str(fd, "course").slice(0, 80) || null,
      weight_pct: weight.v == null ? null : Math.round(weight.v * 100) / 100,
      difficulty: difficulty.v,
      est_minutes: est.v,
      ...EDITED(),
    })
    .eq("id", id);
  if (error) return fail("No se pudieron guardar los detalles");

  refresh();
  return ok("Guardado");
}

/* ------------------------------------------------------------ cronómetro */

type TimerRow = { id: string; title: string; tracked_sec: number; track_sessions: number; track_started_at: string | null };

/**
 * Cierra la sesión en marcha de esa fila: suma lo transcurrido y cuenta una
 * sesión. Es una escritura condicional — sólo si el cronómetro sigue
 * empezado en el MISMO instante que se leyó —, así un doble "Pausar" no suma
 * el tiempo dos veces: el segundo ya no encuentra la fila.
 */
async function closeSession(ctx: Awaited<ReturnType<typeof getCtx>>, row: TimerRow, now: number) {
  if (!row.track_started_at) return null;
  const { sec, capped } = elapsedSec(row.track_started_at, now);
  const { data } = await ctx.supabase
    .from("tasks")
    .update({ tracked_sec: row.tracked_sec + sec, track_sessions: row.track_sessions + 1, track_started_at: null })
    .eq("id", row.id)
    .eq("track_started_at", row.track_started_at)
    .select("id");
  if (!data?.length) return null;
  if (capped) {
    await logActivity(ctx, {
      actor: "system", kind: "timer.capped", taskId: row.id,
      summary: `El cronómetro de ${q(row.title)} se quedó corriendo más de 6 h: se contaron 6 h`,
    });
  }
  return sec;
}

const TIMER_COLS = "id, title, tracked_sec, track_sessions, track_started_at";

async function timerRow(ctx: Awaited<ReturnType<typeof getCtx>>, id: string) {
  const { data } = await ctx.supabase.from("tasks").select(TIMER_COLS).eq("user_id", ctx.userId).eq("id", id).maybeSingle<TimerRow>();
  return data;
}

/** "Empezar": una sola tarea en marcha a la vez; si había otra, se pausa. */
export async function startTimer(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const ctx = await getCtx();
  const now = Date.now();

  const { data: otras } = await ctx.supabase
    .from("tasks")
    .select(TIMER_COLS)
    .eq("user_id", ctx.userId)
    .not("track_started_at", "is", null)
    .neq("id", id)
    .returns<TimerRow[]>();
  for (const o of otras ?? []) await closeSession(ctx, o, now);

  const { data } = await ctx.supabase
    .from("tasks")
    .update({ track_started_at: new Date(now).toISOString() })
    .eq("user_id", ctx.userId)
    .eq("id", id)
    .is("track_started_at", null)
    .eq("done", false)
    .is("deleted_at", null)
    .select("id");
  refresh();
  if (!data?.length) return fail("Esa tarea ya está en marcha o ya no está pendiente");
  return ok(otras?.length ? "En marcha · la otra quedó en pausa" : "En marcha");
}

export async function pauseTimer(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();
  const row = await timerRow(ctx, str(fd, "id"));
  if (!row?.track_started_at) return fail("No estaba en marcha");
  const sec = await closeSession(ctx, row, Date.now());
  refresh();
  return sec == null ? fail("Ya estaba en pausa") : ok(`Pausada · ${fmtDur(Math.max(1, Math.round(sec / 60)))} esta vez`);
}

/** "Terminar": cierra la sesión y marca la tarea hecha. */
export async function finishTimer(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();
  const row = await timerRow(ctx, str(fd, "id"));
  if (!row) return fail("Esa tarea ya no existe");
  await closeSession(ctx, row, Date.now());

  const { data } = await ctx.supabase
    .from("tasks")
    .update({ done: true, done_at: new Date().toISOString(), track_started_at: null, ...EDITED() })
    .eq("id", row.id)
    .select("title, tracked_sec, est_minutes")
    .maybeSingle<{ title: string; tracked_sec: number; est_minutes: number | null }>();
  if (data && data.tracked_sec >= 60) {
    const real = Math.round(data.tracked_sec / 60);
    await logActivity(ctx, {
      actor: "user", kind: "timer.finished", taskId: row.id,
      summary: `Terminaste ${q(data.title)}: ${fmtDur(real)}` + (data.est_minutes ? ` (estimado ${fmtDur(data.est_minutes)})` : ""),
      meta: { realMin: real, estMin: data.est_minutes },
    });
  }
  refresh();
  return ok("Terminada");
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
    .from("tasks").select("id", { count: "exact", head: true })
    .eq("focus_day", ctx.today).is("deleted_at", null);
  if ((count ?? 0) >= 3) return fail("Máximo 3 en el enfoque");

  await ctx.supabase.from("tasks").update({ focus_day: ctx.today, ...EDITED() }).eq("id", id);
  refresh();
  return ok("");
}

export async function clearDoneTasks() {
  const ctx = await getCtx();
  // A la papelera, igual que borrar una sola: las de Canvas no deben volver.
  const { data } = await ctx.supabase
    .from("tasks")
    .update({ deleted_at: new Date().toISOString(), focus_day: null })
    .eq("user_id", ctx.userId)
    .eq("done", true)
    .is("deleted_at", null)
    .select("id");
  const n = data?.length ?? 0;
  if (n) {
    await logActivity(ctx, {
      actor: "user", kind: "task.trashed",
      summary: `Limpiaste ${n} tarea${n > 1 ? "s" : ""} completada${n > 1 ? "s" : ""} (a la papelera)`, meta: { count: n },
    });
  }
  refresh();
}

/* ---------------------------------------------------------------- papelera */

/**
 * Saca una tarea de la papelera. Queda marcada como tuya (editada a mano):
 * si era de Canvas y ya no está allá, el sync no vuelve a mandarla a la
 * papelera — la restauraste a propósito.
 */
export async function restoreTask(fd: FormData) {
  const ctx = await getCtx();
  const { data } = await ctx.supabase
    .from("tasks")
    .update({ deleted_at: null, ...EDITED() })
    .eq("user_id", ctx.userId)
    .eq("id", str(fd, "id"))
    .is("purged_at", null)
    .select("id, title")
    .maybeSingle<{ id: string; title: string }>();
  if (data) await logActivity(ctx, { actor: "user", kind: "task.restored", taskId: data.id, summary: `Restauraste ${q(data.title)} de la papelera` });
  refresh();
}

export async function restoreNote(fd: FormData) {
  const ctx = await getCtx();
  const { data } = await ctx.supabase
    .from("notes").update({ deleted_at: null }).eq("user_id", ctx.userId).eq("id", str(fd, "id")).select("id");
  if (data?.length) await logActivity(ctx, { actor: "user", kind: "note.restored", summary: "Restauraste una nota de la papelera" });
  refresh();
}

/** "Eliminar para siempre" un elemento de la papelera. */
export async function purgeTrashItem(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, "id");
  const n = str(fd, "type") === "note" ? await purgeNotes(ctx, [id]) : await purgeTasks(ctx, [id]);
  if (n) await logActivity(ctx, { actor: "user", kind: "trash.purged", summary: "Eliminaste para siempre un elemento de la papelera" });
  refresh();
}

export async function emptyTrash(): Promise<ActionResult> {
  const ctx = await getCtx();
  const [t, n] = await Promise.all([purgeTasks(ctx, "all"), purgeNotes(ctx, "all")]);
  const total = t + n;
  if (total) {
    await logActivity(ctx, {
      actor: "user", kind: "trash.purged",
      summary: `Vaciaste la papelera: ${total} elemento${total > 1 ? "s" : ""}`, meta: { tasks: t, notes: n },
    });
  }
  refresh();
  return ok(total ? "Papelera vacía" : "La papelera ya estaba vacía");
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
  const { data } = await ctx.supabase
    .from("notes").update({ deleted_at: new Date().toISOString() }).eq("id", str(fd, "id")).select("id");
  // Sin el texto de la nota: el registro no guarda contenido privado.
  if (data?.length) await logActivity(ctx, { actor: "user", kind: "note.trashed", summary: "Mandaste una nota a la papelera" });
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
  // El día viene del formulario. Sólo se marcan días que ya pasaron y que la
  // vista muestra; una fecha rota o futura no entra.
  if (!YMD.test(day) || day > ctx.today || day < addDays(ctx.today, -HABIT_WINDOW)) return;

  const { data } = await ctx.supabase
    .from("habit_log").select("habit_id").eq("habit_id", habitId).eq("day", day).maybeSingle();

  if (data) await ctx.supabase.from("habit_log").delete().eq("habit_id", habitId).eq("day", day);
  else await ctx.supabase.from("habit_log").insert({ habit_id: habitId, user_id: ctx.userId, day });

  refresh();
}

const habitDays = (fd: FormData) => {
  const days = [...new Set(fd.getAll("days").map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return days.length ? days : [0, 1, 2, 3, 4, 5, 6];
};

export async function addHabit(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const name = str(fd, "name");
  if (!name) return fail("Ponle nombre a la rutina");

  const ctx = await getCtx();
  const { error } = await ctx.supabase.from("habits").insert({
    user_id: ctx.userId,
    name: name.slice(0, 80),
    days: habitDays(fd),
  });
  if (error) return fail("No se pudo crear la rutina");

  refresh();
  return ok("Rutina agregada");
}

/** Cambiar los días en que toca, el nombre o si se muestra la racha. */
export async function updateHabit(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const name = str(fd, "name");
  if (!name) return fail("Ponle nombre a la rutina");
  const ctx = await getCtx();
  const { data, error } = await ctx.supabase
    .from("habits")
    .update({ name: name.slice(0, 80), days: habitDays(fd), show_streak: fd.get("show_streak") === "on" })
    .eq("id", str(fd, "id"))
    .eq("user_id", ctx.userId)
    .select("id");
  if (error || !data?.length) return fail("No se pudo guardar la rutina");
  refresh();
  return ok("Rutina guardada");
}

/**
 * Pausar en vez de borrar: la rutina sale de Hoy y del cumplimiento, pero su
 * historial queda. Al reanudarla, el cumplimiento cuenta desde ese día.
 */
export async function pauseHabit(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase.from("habits").update({ archived: true }).eq("id", str(fd, "id")).eq("user_id", ctx.userId);
  refresh();
}

export async function resumeHabit(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase
    .from("habits")
    .update({ archived: false, active_from: ctx.today })
    .eq("id", str(fd, "id"))
    .eq("user_id", ctx.userId);
  refresh();
}

/** Borrar del todo, con su historial. Sólo se ofrece para una rutina en pausa. */
export async function deleteHabit(fd: FormData) {
  const ctx = await getCtx();
  const { data } = await ctx.supabase
    .from("habits")
    .delete()
    .eq("id", str(fd, "id"))
    .eq("user_id", ctx.userId)
    .select("name")
    .maybeSingle<{ name: string }>();
  if (data) await logActivity(ctx, { actor: "user", kind: "habit.deleted", summary: `Borraste la rutina ${q(data.name)} y su historial` });
  refresh();
}

/* ----------------------------------------------------------------- bloques */

export async function deleteBlock(fd: FormData) {
  const ctx = await getCtx();
  await ctx.supabase.from("blocks").delete().eq("id", str(fd, "id"));
  refresh();
}

/**
 * Guarda un plan que el usuario ya vio y aceptó.
 *
 * **Añade, no reemplaza.** El artifact de referencia hacía `byDate[d] = made`,
 * o sea que planear el día borraba los bloques puestos a mano. Eso es la misma
 * clase de error que `CLAUDE.md` prohíbe en el sync: pisar en silencio algo que
 * el usuario escribió. Aquí los bloques nuevos conviven con los que ya estaban.
 *
 * **Y se vuelve a validar al aceptar.** La propuesta se armó hace un rato: lo
 * que hoy choca con algo ocupado, ya terminó o adelanta una tarea que ya no
 * está pendiente, no entra. Eso también hace inofensivo un doble "Agendar":
 * antes, las acciones en cola insertaban el plan dos veces.
 */
export async function applyPlan(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();

  const day = str(fd, "day");
  if (day && day !== ctx.today) return fail("Ese plan era para otro día. Pide uno nuevo.");

  let propuesta: unknown;
  try {
    propuesta = JSON.parse(str(fd, "plan") || "[]");
  } catch {
    return fail("El plan llegó corrupto");
  }
  if (!Array.isArray(propuesta) || !propuesta.length) return fail("No hay plan que guardar");

  const limpios = propuesta
    .slice(0, 8)
    .map((b) => b as { start?: unknown; end?: unknown; title?: unknown; kind?: unknown; taskId?: unknown })
    .filter(
      (b): b is { start: number; end: number; title?: unknown; kind?: unknown; taskId?: unknown } =>
        Number.isInteger(b.start) && Number.isInteger(b.end) &&
        (b.start as number) >= 0 && (b.end as number) <= 1440 && (b.end as number) > (b.start as number),
    )
    .map((b) => ({
      start: b.start,
      end: b.end,
      title: String(b.title ?? "Bloque").slice(0, 120),
      kind: b.kind === "descanso" ? ("descanso" as const) : ("tarea" as const),
      taskId: typeof b.taskId === "string" && b.taskId ? b.taskId : null,
    }));

  if (!limpios.length) return fail("El plan no tenía bloques válidos");

  // Lo que hay AHORA: compromisos de hoy, bloques ya puestos y tareas vivas.
  const pedidos = [...new Set(limpios.map((b) => b.taskId).filter((x): x is string => Boolean(x)))];
  const [events, blocks, vivas] = await Promise.all([
    loadEvents(ctx, ctx.today, ctx.today),
    loadBlocks(ctx, ctx.today, ctx.today),
    pedidos.length
      ? ctx.supabase.from("tasks").select("id").in("id", pedidos)
          .eq("user_id", ctx.userId).eq("done", false).is("deleted_at", null)
          .returns<{ id: string }[]>().then((r) => r.data ?? [])
      : Promise.resolve([] as { id: string }[]),
  ]);

  const busy = [
    ...events.filter((e) => e.start != null).map((e) => ({ start: e.start!, end: e.end ?? e.start! + 60 })),
    ...blocks.map((b) => ({ start: b.start_min, end: b.end_min })),
  ];
  const { accepted, skipped } = acceptable(limpios, busy, {
    now: minutesInTz(ctx.tz),
    liveTaskIds: new Set(vivas.map((t) => t.id)),
  });

  if (!accepted.length) {
    return fail(
      skipped.every((x) => x.reason === "ocupado")
        ? "Eso ya está agendado o ya no cabe: no se agregó nada"
        : "Nada de ese plan sigue sirviendo: pide uno nuevo",
    );
  }

  const rows = accepted.map((b) => ({
    user_id: ctx.userId,
    day: ctx.today,
    start_min: b.start,
    end_min: b.end,
    title: b.title,
    kind: b.kind,
    task_id: b.taskId,
  }));

  const { error } = await ctx.supabase.from("blocks").insert(rows);
  if (error) return fail("No se pudieron guardar los bloques");

  const n = rows.length;
  await logActivity(ctx, {
    actor: "user", kind: "ai.accepted",
    summary: `Aceptaste el plan de Claude: ${n} bloque${n > 1 ? "s" : ""}` +
      (skipped.length ? ` (${skipped.length} ya no cabía${skipped.length > 1 ? "n" : ""} y se omitió)` : ""),
    meta: { what: "plan", accepted: n, skipped: skipped.length },
  });
  refresh();
  return ok(
    `${n} bloque${n > 1 ? "s" : ""} agendado${n > 1 ? "s" : ""}` +
      (skipped.length ? ` · ${skipped.length} ya no cabía${skipped.length > 1 ? "n" : ""}` : ""),
  );
}

/**
 * Guarda los pasos en que se partió una tarea grande.
 *
 * Los pasos entran como tareas normales, junto a la original — que no se toca
 * ni se borra. No hay jerarquía en el esquema y no se la inventa aquí: una
 * columna `parent_id` obligaría a anidar en todas las vistas, y para tres o
 * cuatro pasos con fecha propia eso es más estructura que provecho. Si algún
 * día estorba, se añade entonces.
 *
 * Un paso que ya existe (mismo título, misma fecha) no se vuelve a crear: así
 * aceptar dos veces la misma propuesta no deja la lista duplicada.
 */
export async function applyBreakdown(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();

  let pasos: unknown;
  try {
    pasos = JSON.parse(str(fd, "steps") || "[]");
  } catch {
    return fail("Los pasos llegaron corruptos");
  }
  if (!Array.isArray(pasos) || !pasos.length) return fail("No hay pasos que guardar");

  const area = str(fd, "area") || null;

  const candidatos = pasos
    .slice(0, 7)
    .map((p) => p as { title?: unknown; date?: unknown; minutes?: unknown })
    .filter((p) => typeof p.title === "string" && p.title.trim() && typeof p.date === "string" && YMD.test(p.date))
    .map((p) => ({
      user_id: ctx.userId,
      title: String(p.title).trim().slice(0, 120),
      area,
      due_date: p.date as string,
      est_minutes: typeof p.minutes === "number" ? Math.min(1440, Math.max(1, Math.round(p.minutes))) : null,
      priority: 2,
      // Son tareas escritas por el usuario al aceptarlas, no filas de una
      // fuente externa: se marcan como editadas a mano para que el sync de
      // Canvas nunca las considere suyas.
      user_edited_at: new Date().toISOString(),
    }));

  if (!candidatos.length) return fail("Ningún paso era válido");

  const { data: yaEstan } = await ctx.supabase
    .from("tasks")
    .select("title, due_date")
    .eq("user_id", ctx.userId)
    .is("deleted_at", null)
    .in("title", [...new Set(candidatos.map((c) => c.title))])
    .returns<{ title: string; due_date: string | null }[]>();
  const existe = new Set((yaEstan ?? []).map((t) => `${t.title}|${t.due_date}`));
  const rows = candidatos.filter((c) => !existe.has(`${c.title}|${c.due_date}`));

  if (!rows.length) return fail("Esos pasos ya estaban agregados");

  const { error } = await ctx.supabase.from("tasks").insert(rows);
  if (error) return fail("No se pudieron guardar los pasos");

  const padre = str(fd, "parent");
  await logActivity(ctx, {
    actor: "user", kind: "ai.accepted",
    summary: `Aceptaste ${rows.length} paso${rows.length > 1 ? "s" : ""} de Claude` + (padre ? ` para ${q(padre)}` : ""),
    meta: { what: "breakdown", accepted: rows.length },
  });
  refresh();
  return ok(`${rows.length} paso${rows.length > 1 ? "s" : ""} agregado${rows.length > 1 ? "s" : ""}`);
}

/**
 * "Descartar" en una propuesta de Claude. No cambia nada: sólo lo anota, para
 * que Actividad cuente también lo que se dijo que no.
 */
export async function discardProposal(what: "plan" | "breakdown" | "prep", title?: string): Promise<void> {
  const ctx = await getCtx();
  await logActivity(ctx, {
    actor: "user", kind: "ai.discarded",
    summary: what === "plan"
      ? "Descartaste el plan que propuso Claude"
      : what === "prep"
        ? "Descartaste un plan de preparación" + (title ? ` para ${q(String(title).slice(0, 120))}` : "")
        : `Descartaste los pasos que propuso Claude` + (title ? ` para ${q(String(title).slice(0, 120))}` : ""),
    meta: { what },
  });
}

/* ------------------------------------- preparación y replanificación */

type SessionIn = { day: string; start: number; end: number; title: string; taskId: string };

/** Lo mínimo para escribir bloques de una tarea: la tarea viva y sus límites. */
async function liveTask(ctx: Awaited<ReturnType<typeof getCtx>>, id: string) {
  const { data } = await ctx.supabase
    .from("tasks")
    .select("id, title, due_date, due_time, source, done, deleted_at")
    .eq("user_id", ctx.userId)
    .eq("id", id)
    .maybeSingle<{ id: string; title: string; due_date: string | null; due_time: string | null; source: string; done: boolean; deleted_at: string | null }>();
  return data && !data.done && !data.deleted_at ? data : null;
}

/**
 * Escribe bloques ya aceptados, revalidando cada uno contra lo que hay AHORA
 * (clases, eventos, tus bloques). Devuelve cuántos entraron y cuántos no.
 * Nunca borra ni mueve un bloque existente.
 */
async function insertSessions(ctx: Awaited<ReturnType<typeof getCtx>>, sessions: SessionIn[]) {
  if (!sessions.length) return { inserted: 0, skipped: 0, minutes: 0 };
  const dias = [...new Set(sessions.map((s) => s.day))].sort();
  const [events, blocks] = await Promise.all([
    loadEvents(ctx, dias[0], dias[dias.length - 1]),
    loadBlocks(ctx, dias[0], dias[dias.length - 1]),
  ]);
  const ahora = minutesInTz(ctx.tz);

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const day of dias) {
    const busy = [
      ...events.filter((e) => e.day === day && e.start != null).map((e) => ({ start: e.start!, end: e.end ?? e.start! + 60 })),
      ...blocks.filter((b) => b.day === day).map((b) => ({ start: b.start_min, end: b.end_min })),
    ];
    const r = acceptable(sessions.filter((s) => s.day === day), busy, { now: day === ctx.today ? ahora : null });
    skipped += r.skipped.length;
    for (const s of r.accepted) {
      rows.push({ user_id: ctx.userId, day, start_min: s.start, end_min: s.end, title: s.title, kind: "tarea", task_id: s.taskId });
    }
  }
  if (rows.length) {
    const { error } = await ctx.supabase.from("blocks").insert(rows);
    if (error) throw new Error("No se pudieron guardar los bloques");
  }
  const minutes = rows.reduce((a, r) => a + (Number(r.end_min) - Number(r.start_min)), 0);
  return { inserted: rows.length, skipped, minutes };
}

function readSessions(raw: string, taskId: string): SessionIn[] | null {
  let list: unknown;
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  return list.slice(0, 40).flatMap((x) => {
    const s = x as { day?: unknown; start?: unknown; end?: unknown; title?: unknown };
    if (typeof s.day !== "string" || !YMD.test(s.day)) return [];
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) return [];
    const start = s.start as number, end = s.end as number;
    if (start < 0 || end > 1440 || end <= start) return [];
    return [{ day: s.day, start, end, title: String(s.title ?? "").trim().slice(0, 120) || "Sesión", taskId }];
  });
}

/**
 * "Agendar" un plan de preparación. Cada sesión se revalida: nunca antes de
 * hoy, nunca el día del deadline ni después, y nunca encima de algo ocupado.
 */
export async function applyPrepPlan(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();
  const task = await liveTask(ctx, str(fd, "taskId"));
  if (!task || !task.due_date) return fail("Esa tarea ya no está pendiente");

  const sessions = readSessions(str(fd, "sessions"), task.id);
  if (!sessions) return fail("El plan llegó corrupto");
  const validas = sessions.filter((s) => s.day >= ctx.today && s.day < task.due_date!);
  if (!validas.length) return fail("Ninguna sesión cae entre hoy y el día antes del deadline");

  let r;
  try {
    r = await insertSessions(ctx, validas);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "No se pudo guardar");
  }
  const fuera = sessions.length - validas.length + r.skipped;
  if (!r.inserted) return fail("Esas sesiones ya no caben: algo ocupó esos huecos. Pide una propuesta nueva.");

  await logActivity(ctx, {
    actor: "user", kind: "prep.accepted", taskId: task.id,
    summary: `Agendaste un plan de preparación para ${q(task.title)}: ${r.inserted} ${r.inserted > 1 ? "sesiones" : "sesión"}, ${fmtDur(r.minutes)}` +
      (fuera ? ` (${fuera} ya no cabía${fuera > 1 ? "n" : ""})` : ""),
    meta: { sessions: r.inserted, minutes: r.minutes, skipped: fuera },
  });
  refresh();
  return ok(`${r.inserted} ${r.inserted > 1 ? "sesiones" : "sesión"} agendada${r.inserted > 1 ? "s" : ""}` + (fuera ? ` · ${fuera} ya no cabía${fuera > 1 ? "n" : ""}` : ""));
}

/**
 * "Agendar" el hueco que encontró Replanificar. Opcionalmente, para una tarea
 * manual, también mueve su fecha a ese día (una de Canvas no: la fecha la
 * pone el profesor, y el sync la volvería a poner).
 */
export async function applyReplan(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ctx = await getCtx();
  const task = await liveTask(ctx, str(fd, "taskId"));
  if (!task) return fail("Esa tarea ya no está pendiente");

  const day = str(fd, "day");
  const start = Number(str(fd, "start"));
  const end = Number(str(fd, "end"));
  if (!YMD.test(day) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start) {
    return fail("Ese horario no es válido");
  }
  if (day < ctx.today) return fail("Ese día ya pasó");
  // Nunca después del deadline (si todavía no venció).
  if (task.due_date && task.due_date >= ctx.today) {
    const dueMin = timeToMins(task.due_time);
    if (day > task.due_date || (day === task.due_date && dueMin != null && end > dueMin)) {
      return fail("Eso queda después del deadline");
    }
  }

  let r;
  try {
    r = await insertSessions(ctx, [{ day, start, end, title: task.title.slice(0, 120), taskId: task.id }]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "No se pudo guardar");
  }
  if (!r.inserted) return fail("Ese hueco ya no está libre. Busca otro.");

  const mover = str(fd, "moveDate") === "1" && task.source === "manual";
  if (mover) {
    await ctx.supabase.from("tasks").update({ due_date: day, ...EDITED() }).eq("id", task.id);
  }

  await logActivity(ctx, {
    actor: "user", kind: "task.replanned", taskId: task.id,
    summary: `Replanificaste ${q(task.title)}: ${shortDate(day)} · ${minsToHHMM(start)}–${minsToHHMM(end)}` +
      (mover ? " y moviste su fecha a ese día" : ""),
  });
  refresh();
  return ok(`Agendada: ${shortDate(day)}, ${minsToHHMM(start)}–${minsToHHMM(end)}` + (mover ? " · fecha movida" : ""));
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

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

/* ------------------------------------------------------------------ Canvas */

/**
 * El botón "Sincronizar ahora" de Ajustes. Llama a la misma función que
 * `POST /api/sync/canvas`; la ruta queda para el cron de la fase 4.
 */
export async function syncCanvasNow(): Promise<ActionResult> {
  if (!canvasConfigured()) {
    return fail("Falta CANVAS_TOKEN en .env.local — mira las instrucciones de abajo");
  }

  const ctx = await getCtx();
  const r = await runCanvasSync(ctx, "manual");
  refresh();
  return r.ok ? ok(r.result.message) : fail(r.message);
}

/* --------------------------------------------------------- Google Calendar */

export async function syncGcalNow(): Promise<ActionResult> {
  if (!gcalConfigured()) return fail("Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor");
  const ctx = await getCtx();
  const r = await runGcalSync(ctx, "manual");
  refresh();
  return r.ok ? ok(r.result.message) : fail(r.message);
}

/**
 * Desconectar: se le avisa a Google, se borra el permiso guardado y se quitan
 * de TaskFlow los eventos que vinieron de ahí (sin sync, quedarían viejos).
 * En Google no se toca nada.
 */
export async function disconnectGcal(): Promise<ActionResult> {
  const ctx = await getCtx();
  const { data: link } = await ctx.supabase
    .from("gcal_links")
    .select("refresh_token")
    .eq("user_id", ctx.userId)
    .maybeSingle<{ refresh_token: string }>();
  if (link && gcalConfigured()) {
    const token = openToken(link.refresh_token, requireGoogleEnv().clientSecret);
    if (token) await revokeToken(token);
  }
  await ctx.supabase.from("gcal_links").delete().eq("user_id", ctx.userId);
  await ctx.supabase.from("events").delete().eq("user_id", ctx.userId).eq("source", "gcal");
  await ctx.supabase.from("sync_state").delete().eq("user_id", ctx.userId).eq("source", "gcal");
  if (link) {
    await logActivity(ctx, { actor: "user", kind: "gcal.unlinked", summary: "Desconectaste Google Calendar; sus eventos salieron de TaskFlow" });
  }
  refresh();
  return ok("Desconectado. Los eventos de Google salieron de TaskFlow; en Google no cambió nada.");
}

/* -------------------------------------------------------------- Web Push */

/** Guarda (o refresca) la suscripción de este navegador. */
export async function savePushSubscription(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const endpoint = str(fd, "endpoint");
  const p256dh = str(fd, "p256dh");
  const auth = str(fd, "auth");
  if (!endpoint || !p256dh || !auth) return fail("La suscripción llegó incompleta");

  const ctx = await getCtx();
  const { error } = await ctx.supabase.from("push_subscriptions").upsert(
    {
      endpoint,
      user_id: ctx.userId,
      p256dh,
      auth,
      user_agent: str(fd, "user_agent").slice(0, 200) || null,
    },
    { onConflict: "endpoint" },
  );
  if (error) return fail("No se pudo guardar la suscripción");

  await logActivity(ctx, { actor: "user", kind: "push.enabled", summary: "Activaste los avisos push en un navegador" });
  refresh();
  return ok("Listo: te avisamos por la mañana y la noche antes");
}

/**
 * Vuelve a registrar en silencio la suscripción de este navegador.
 *
 * La llama la app al abrirse. Cubre el caso en que el navegador sigue
 * suscrito pero el servidor ya no lo tiene (se borró tras un fallo, cambió la
 * base, el navegador rotó la suscripción sin avisar): sin esto, Ajustes decía
 * "avisos activos" y no llegaba nada. Es un upsert: repetirlo no cambia nada.
 */
export async function syncPushSubscription(sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
  if (!sub?.endpoint || !sub.p256dh || !sub.auth) return;
  if (!/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) return;
  const ctx = await getCtx();
  await ctx.supabase.from("push_subscriptions").upsert(
    { endpoint: sub.endpoint, user_id: ctx.userId, p256dh: sub.p256dh.slice(0, 200), auth: sub.auth.slice(0, 100) },
    { onConflict: "endpoint" },
  );
}

/** "Enviar notificación de prueba" en Ajustes → Estado del sistema. */
export async function sendTestPush(): Promise<ActionResult> {
  const ctx = await getCtx();
  const r = await deliverPush(ctx, ctx.supabase, {
    title: "Prueba de TaskFlow",
    body: "Si ves esto, los avisos llegan a este dispositivo.",
    url: "/ajustes/estado",
  });
  if (r && (r.sent || r.gone || r.failed)) {
    await logActivity(ctx, {
      actor: "user", kind: "push.test",
      summary: r.sent ? `Notificación de prueba: aceptada para ${r.sent} dispositivo${r.sent > 1 ? "s" : ""}` : "Notificación de prueba: no llegó a ningún dispositivo",
      meta: { sent: r.sent, gone: r.gone, failed: r.failed },
    });
  }
  refresh();
  if (!r) return fail("El servidor no tiene las llaves VAPID: no puede mandar avisos");
  if (!r.sent && !r.gone && !r.failed) return fail("No hay ningún dispositivo suscrito. Actívalos en Ajustes → Avisos.");
  if (!r.sent) {
    return fail(r.gone
      ? "Los dispositivos ya no estaban suscritos y se quitaron. Vuelve a activar los avisos."
      : "Ningún dispositivo aceptó el aviso (" + (r.code ?? "PUSH_FAILED") + ")");
  }
  return ok(`Enviado a ${r.sent} dispositivo${r.sent > 1 ? "s" : ""}` + (r.failed ? ` · ${r.failed} falló` : "") +
    (r.gone ? ` · ${r.gone} ya no estaba suscrito` : ""));
}

/** "Enviar mensaje de prueba" en Ajustes → Estado del sistema. */
export async function sendTestTelegram(): Promise<ActionResult> {
  const ctx = await getCtx();
  const r = await deliverTelegram(
    ctx,
    ctx.supabase,
    { title: "Prueba de TaskFlow", body: "Si ves esto, los avisos llegan a este chat.", url: "/ajustes/estado" },
    await requestOrigin(),
  );
  if (r?.linked || r?.code) {
    await logActivity(ctx, {
      actor: "user", kind: "telegram.test",
      summary: r.ok ? "Mensaje de prueba enviado a Telegram" : `Mensaje de prueba a Telegram: ${r.message ?? "falló"}`,
    });
  }
  refresh();
  if (!r) return fail("El servidor no tiene TELEGRAM_BOT_TOKEN");
  if (!r.linked && !r.code) return fail("No hay ningún chat conectado");
  return r.ok ? ok("Mensaje enviado") : fail(r.message ?? "No se pudo enviar");
}

export async function removePushSubscription(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const endpoint = str(fd, "endpoint");
  const ctx = await getCtx();
  // Sin endpoint, se dan de baja todos los navegadores de este usuario.
  const q = ctx.supabase.from("push_subscriptions").delete().eq("user_id", ctx.userId);
  const { error } = endpoint ? await q.eq("endpoint", endpoint) : await q;
  if (error) return fail("No se pudo dar de baja");

  await logActivity(ctx, { actor: "user", kind: "push.disabled", summary: "Desactivaste los avisos push en un navegador" });
  refresh();
  return ok("Avisos desactivados");
}

/* ---------------------------------------------------------------- Telegram */

export type TelegramLinkResult = ActionResult & { url?: string };

/** Cuánto vale un enlace de conexión. Lo justo para abrir Telegram y volver. */
const MINUTOS_ENLACE = 15;

/**
 * Genera el enlace t.me/<bot>?start=<código> que conecta el chat.
 *
 * El código es de un solo uso y caduca: quien lo vea en una captura de
 * pantalla media hora después ya no puede conectar su chat a tu cuenta.
 */
export async function startTelegramLink(): Promise<TelegramLinkResult> {
  if (!telegramConfigured()) return fail("Falta TELEGRAM_BOT_TOKEN en el servidor");

  const ctx = await getCtx();
  const codigo = randomBytes(16).toString("base64url");
  const caduca = new Date(Date.now() + MINUTOS_ENLACE * 60_000).toISOString();

  // Si ya había un chat conectado se conserva hasta que el nuevo /start llegue:
  // generar un enlace no debería desconectarte.
  const { error } = await ctx.supabase
    .from("telegram_chats")
    .upsert(
      { user_id: ctx.userId, link_code: codigo, link_expires_at: caduca },
      { onConflict: "user_id" },
    );
  if (error) return fail("No se pudo generar el enlace");

  const origin = await requestOrigin();
  if (!origin) return fail("No se pudo saber la dirección de la app");

  try {
    await ensureWebhook(origin);
    const bot = await botUsername();
    return { ok: true, message: `El enlace vale ${MINUTOS_ENLACE} minutos`, url: `https://t.me/${bot}?start=${codigo}` };
  } catch (e) {
    if (e instanceof TelegramError && /https/i.test(e.message)) {
      return fail("Telegram sólo acepta HTTPS: esto funciona con la app desplegada, no en localhost.");
    }
    if (e instanceof TelegramError && e.code === 401) {
      return fail("Telegram no reconoce el token. Revisa TELEGRAM_BOT_TOKEN.");
    }
    return fail(e instanceof Error ? e.message : "No se pudo hablar con Telegram");
  }
}

export async function unlinkTelegram(): Promise<ActionResult> {
  const ctx = await getCtx();
  const { error } = await ctx.supabase.from("telegram_chats").delete().eq("user_id", ctx.userId);
  if (error) return fail("No se pudo desconectar");
  await logActivity(ctx, { actor: "user", kind: "telegram.unlinked", summary: "Desconectaste Telegram desde Ajustes" });
  refresh();
  return ok("Telegram desconectado");
}

/** La dirección pública de la app, según quien hizo la petición. */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
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

  const rows = events.map((e) => {
    // Un evento que "termina antes de empezar" (un .ics mal hecho) no puede
    // tumbar la importación entera: se queda sin hora de fin.
    const endsAt = e.endsAt && e.startsAt && e.endsAt < e.startsAt ? null : e.endsAt;
    return {
      user_id: ctx.userId,
      title: e.title.slice(0, 200),
      starts_at: e.startsAt,
      ends_at: endsAt,
      all_day_date: e.allDayDate,
      course_ref: source,
      source: "ics" as const,
      external_id: e.externalId,
    };
  });

  // Reimportar con el mismo nombre reemplaza, para que un cambio de horario no
  // deje clases fantasma. Pero en este orden: PRIMERO se guarda lo nuevo y
  // SÓLO si salió bien se borra lo que sobra. Antes era al revés, y si el
  // insert fallaba (la red, o un solo evento raro) el horario anterior ya
  // estaba borrado y no quedaba ninguno.
  const { error } = await ctx.supabase
    .from("events")
    .upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) return fail("No se pudieron guardar los eventos; lo que tenías sigue igual");

  const nuevos = new Set(rows.map((r) => r.external_id));
  const { data: previos } = await ctx.supabase
    .from("events")
    .select("id, external_id")
    .eq("user_id", ctx.userId)
    .eq("source", "ics")
    .eq("course_ref", source)
    .returns<{ id: string; external_id: string }[]>();
  const sobran = (previos ?? []).filter((e) => !nuevos.has(e.external_id)).map((e) => e.id);
  // De a 100: una lista de ids muy larga no cabe en la URL de PostgREST.
  for (let i = 0; i < sobran.length; i += 100) {
    await ctx.supabase.from("events").delete().eq("user_id", ctx.userId).in("id", sobran.slice(i, i + 100));
  }

  await logActivity(ctx, {
    actor: "user", kind: "ics.imported",
    summary: `Importaste el calendario ${q(source)}: ${events.length} eventos` + (sobran.length ? ` (${sobran.length} viejos quitados)` : ""),
    meta: { events: events.length, removed: sobran.length },
  });
  refresh();
  return ok(events.length + " eventos importados de " + source);
}

export async function deleteIcsSource(fd: FormData) {
  const ctx = await getCtx();
  const name = str(fd, "name");
  await ctx.supabase.from("events").delete().eq("user_id", ctx.userId).eq("source", "ics").eq("course_ref", name);
  await logActivity(ctx, { actor: "user", kind: "ics.removed", summary: `Quitaste el calendario ${q(name)}` });
  refresh();
}

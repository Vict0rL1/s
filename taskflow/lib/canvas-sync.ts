import "server-only";

import {
  type CanvasCourse,
  type CanvasPlannerItem,
  type ExistingRow,
  canvasGetAll,
  insertRow,
  mapPlannerItems,
  planSync,
  safeUpsertRow,
  submittedIds,
} from "./canvas";
import { addDays } from "./date";
import { canvasConfigured, requireCanvasEnv } from "./env.server";
import type { Ctx } from "./data";
import { type ErrorCode, IntegrationError, errorCodeOf, logEvent, safeMessage } from "./log";
import { recordRun } from "./sync-state";
import { type ActivityEntry, logActivity, q, shortDate } from "./activity";

/** Ventana que se pide a Canvas, en días alrededor de hoy. */
const DAYS_BACK = 14;
const DAYS_AHEAD = 180;

export type SyncResult = {
  ok: boolean;
  /** Cuántos deadlines quedaron en la base tras esta corrida. */
  items: number;
  inserted: number;
  updated: number;
  /** Filas con edición manual: sólo se les refrescó título y fecha. */
  protected: number;
  /** Entregadas en Canvas que se marcaron hechas. */
  completed: number;
  /** Ya no están en Canvas: a la papelera. */
  vanished: number;
  message: string;
  /** Lo que pasó, tarea por tarea, para el registro de Actividad. */
  activity: ActivityEntry[];
};

/**
 * Trae los deadlines de Canvas y los deja en `tasks`.
 *
 * Los dos `upsert` son la regla dura hecha SQL: el primero manda las columnas
 * del sync, el segundo sólo título y fecha. Lo que no viaja en el objeto es
 * exactamente lo que Postgres no toca — `done`, `priority`, `area` y
 * `est_minutes` de una fila editada a mano sobreviven intactos.
 */
export async function syncCanvas(ctx: Ctx): Promise<SyncResult> {
  const { baseUrl, token } = requireCanvasEnv();

  const start = addDays(ctx.today, -DAYS_BACK);
  const end = addDays(ctx.today, DAYS_AHEAD);

  const plannerUrl =
    `${baseUrl}/planner/items?start_date=${start}&end_date=${end}&per_page=100`;
  const coursesUrl = `${baseUrl}/users/self/favorites/courses?per_page=100`;

  const [planner, courses] = await Promise.all([
    canvasGetAll(plannerUrl, token),
    // Los cursos son para clasificar; si fallan, el sync sigue sin ellos.
    canvasGetAll(coursesUrl, token).catch(() => null),
  ]);
  const rawItems = planner.items;
  const rawCourses = courses?.items ?? [];

  const incoming = mapPlannerItems(
    rawItems as CanvasPlannerItem[],
    rawCourses as CanvasCourse[],
    { areas: ctx.profile.areas, timeZone: ctx.tz, baseUrl },
  );

  // El filtro por `user_id` es explícito a propósito. Con la sesión bastaría la
  // RLS, pero el reloj corre con la service role, que la salta: sin esto leería
  // y pisaría las filas de cualquier otro usuario.
  const { data: existing, error: readError } = await ctx.supabase
    .from("tasks")
    .select("id, external_id, title, user_edited_at, done, deleted_at, due_date, due_time")
    .eq("user_id", ctx.userId)
    .eq("source", "canvas")
    .returns<(ExistingRow & { id: string })[]>();

  // Si no se pudo leer lo que hay, NO se sigue. Antes, una lectura fallida
  // dejaba la lista en blanco, todo parecía nuevo, y el upsert completo pisaba
  // el área de las filas que Victor había editado — justo lo que la regla
  // dura prohíbe.
  if (readError || !existing) {
    throw new IntegrationError(
      "CANVAS_DB_FAILED",
      "No se pudieron leer los deadlines guardados: " + (readError?.message ?? "sin respuesta"),
      true,
    );
  }

  const plan = planSync(incoming, existing, {
    submitted: submittedIds(rawItems as CanvasPlannerItem[]),
    coursesOk: courses != null,
    window: { start, end, complete: planner.complete },
  });

  // Para enlazar cada línea de Actividad con su tarea.
  const idOf = new Map(existing.map((r) => [r.external_id, r.id]));

  // Filas que son del sync: se insertan o se refrescan enteras.
  const owned = [...plan.insert, ...plan.updateAll].map((t) => insertRow(t, ctx.userId));
  if (owned.length) {
    const { data: saved, error } = await ctx.supabase
      .from("tasks")
      .upsert(owned, { onConflict: "user_id,source,external_id" })
      .select("id, external_id")
      .returns<{ id: string; external_id: string }[]>();
    if (error) throw new IntegrationError("CANVAS_DB_FAILED", "No se pudieron guardar los deadlines: " + error.message, true);
    for (const r of saved ?? []) idOf.set(r.external_id, r.id);
  }

  // Filas que Victor tocó: sólo título y fecha.
  const manual = plan.updateSafe.map((t) => safeUpsertRow(t, ctx.userId));
  if (manual.length) {
    const { error } = await ctx.supabase
      .from("tasks")
      .upsert(manual, { onConflict: "user_id,source,external_id" });
    if (error) {
      throw new IntegrationError("CANVAS_DB_FAILED", "No se pudieron actualizar los deadlines editados: " + error.message, true);
    }
  }

  // Las dos escrituras que no son upsert repiten la condición en el UPDATE
  // (`user_edited_at is null`, etc.). Si Victor tocó la fila entre la lectura de
  // arriba y este momento, la condición ya no se cumple y la fila no se toca.
  const now = new Date().toISOString();
  if (plan.complete.length) {
    const { error } = await ctx.supabase
      .from("tasks")
      .update({ done: true, done_at: now })
      .eq("user_id", ctx.userId)
      .eq("source", "canvas")
      .in("external_id", plan.complete)
      .is("user_edited_at", null)
      .eq("done", false);
    if (error) throw new IntegrationError("CANVAS_DB_FAILED", "No se pudieron marcar las entregadas: " + error.message, true);
  }

  if (plan.vanished.length) {
    const { error } = await ctx.supabase
      .from("tasks")
      .update({ deleted_at: now, focus_day: null })
      .eq("user_id", ctx.userId)
      .eq("source", "canvas")
      .in("external_id", plan.vanished)
      .is("user_edited_at", null)
      .is("deleted_at", null)
      .eq("done", false);
    if (error) throw new IntegrationError("CANVAS_DB_FAILED", "No se pudo limpiar lo que ya no está en Canvas: " + error.message, true);
  }

  if (plan.vanishedHeld) {
    logEvent({
      event: "canvas.vanish_held", result: "skipped", userId: ctx.userId, integration: "canvas",
      count: plan.vanishedHeld,
    });
  }

  const partes = [`${incoming.length} deadlines`, `${plan.insert.length} nuevos`];
  if (plan.updateSafe.length) partes.push(`${plan.updateSafe.length} respetando tus cambios`);
  if (plan.complete.length) partes.push(`${plan.complete.length} entregada${plan.complete.length > 1 ? "s" : ""}`);
  if (plan.vanished.length) partes.push(`${plan.vanished.length} ya no está${plan.vanished.length > 1 ? "n" : ""} en Canvas (a la papelera)`);

  const nada = !plan.insert.length && !plan.updateAll.length && !plan.updateSafe.length &&
    !plan.complete.length && !plan.vanished.length;
  const message = nada ? "Canvas no trajo deadlines pendientes" : partes.join(" · ");

  return {
    activity: activityFor(plan, existing, idOf),
    ok: true,
    items: incoming.length,
    inserted: plan.insert.length,
    updated: plan.updateAll.length,
    protected: plan.updateSafe.length,
    completed: plan.complete.length,
    vanished: plan.vanished.length,
    message,
  };
}

export type CanvasRun =
  | { ok: true; result: SyncResult }
  | { ok: false; message: string; code?: ErrorCode };

/**
 * Corre el sync y deja constancia en `sync_state` y en el log, salga bien o
 * mal. Es lo que llaman el botón de Ajustes, la ruta y el reloj: los tres
 * repetían el mismo try/catch y cada uno lo registraba un poco distinto.
 */
export async function runCanvasSync(ctx: Ctx, trigger: "cron" | "manual"): Promise<CanvasRun> {
  if (!canvasConfigured()) {
    return { ok: false, code: "CANVAS_NOT_CONFIGURED", message: "Falta CANVAS_TOKEN en las variables del servidor." };
  }

  const started = Date.now();
  // Cómo estaba antes, para anotar un fallo sólo cuando empieza (o cambia), no
  // cada hora mientras dure.
  const { data: antes } = await ctx.supabase
    .from("sync_state")
    .select("last_error_code, last_error_at, last_success_at")
    .eq("user_id", ctx.userId)
    .eq("source", "canvas")
    .maybeSingle<{ last_error_code: string | null; last_error_at: string | null; last_success_at: string | null }>();
  const yaFallaba = Boolean(antes?.last_error_at && (!antes.last_success_at || antes.last_error_at > antes.last_success_at));

  try {
    const result = await syncCanvas(ctx);
    await recordRun(ctx.supabase, ctx.userId, "canvas", { ok: true, items: result.items });

    const hubo = result.activity.length > 0;
    const resumen: ActivityEntry[] = [];
    if (trigger === "manual") {
      resumen.push({ actor: "user", kind: "canvas.sync", summary: `Sincronizaste Canvas: ${result.message}` });
    } else if (hubo || yaFallaba) {
      resumen.push({
        actor: "system", kind: "canvas.sync",
        summary: yaFallaba ? `Canvas volvió a sincronizar: ${result.message}` : `El reloj sincronizó Canvas: ${result.message}`,
      });
    }
    await logActivity(ctx, [...resumen, ...result.activity]);
    logEvent({
      event: "canvas.sync", result: "ok", userId: ctx.userId, integration: "canvas", trigger,
      items: result.items, inserted: result.inserted, updated: result.updated, protected: result.protected,
      ms: Date.now() - started,
    });
    return { ok: true, result };
  } catch (e) {
    const code = errorCodeOf(e);
    const message = safeMessage(e, "Falló el sync de Canvas");
    await recordRun(ctx.supabase, ctx.userId, "canvas", { ok: false, error: message, code });
    if (trigger === "manual" || !yaFallaba || antes?.last_error_code !== (code ?? null)) {
      await logActivity(ctx, {
        actor: trigger === "manual" ? "user" : "system", kind: "canvas.failed",
        summary: `Canvas no sincronizó: ${message}`, meta: { code: code ?? null },
      });
    }
    logEvent({
      event: "canvas.sync", result: "error", userId: ctx.userId, integration: "canvas", trigger,
      errorCode: code, message, ms: Date.now() - started,
    });
    return { ok: false, message, code };
  }
}

/* --------------------------------------------------------------- actividad */

/** Más que esto en una sola corrida (el primer sync) se cuenta en una línea. */
const MAX_LINES = 12;

/**
 * Las líneas de Actividad de una corrida: qué agregó, qué cambió (y si respetó
 * tu edición), qué marcó entregado y qué mandó a la papelera. Sólo lo que de
 * verdad cambió: refrescar una fila idéntica no es noticia.
 */
function activityFor(
  plan: ReturnType<typeof planSync>,
  existing: (ExistingRow & { id: string })[],
  idOf: Map<string, string>,
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const titleOf = new Map(existing.map((r) => [r.external_id, r.title ?? ""]));

  if (plan.insert.length > MAX_LINES) {
    out.push({ actor: "canvas", kind: "canvas.added", summary: `Canvas agregó ${plan.insert.length} tareas`, meta: { count: plan.insert.length } });
  } else {
    for (const t of plan.insert) {
      out.push({
        actor: "canvas", kind: "canvas.added", taskId: idOf.get(t.externalId),
        summary: `Canvas agregó ${q(t.title)}` + (t.dueDate ? ` · vence ${shortDate(t.dueDate)}` : ""),
      });
    }
  }

  for (const c of plan.changes.slice(0, MAX_LINES)) {
    const partes: string[] = [];
    if (c.before.title !== c.after.title) partes.push(`renombró ${q(c.before.title)} a ${q(c.after.title)}`);
    if (c.before.due_date !== c.after.due_date) {
      partes.push(`movió ${partes.length ? "la fecha" : q(c.after.title)} del ${shortDate(c.before.due_date)} al ${shortDate(c.after.due_date)}`);
    } else if (c.before.due_time !== c.after.due_time) {
      partes.push(`cambió la hora de ${partes.length ? "entrega" : q(c.after.title)}`);
    }
    out.push({
      actor: "canvas", kind: c.protected ? "canvas.updated_protected" : "canvas.updated", taskId: idOf.get(c.externalId),
      summary: `Canvas ${partes.join(" y ")}` + (c.protected ? " (respetó tus cambios: sólo tocó título y fecha)" : ""),
    });
  }
  if (plan.changes.length > MAX_LINES) {
    out.push({ actor: "canvas", kind: "canvas.updated", summary: `Canvas cambió ${plan.changes.length - MAX_LINES} tareas más` });
  }

  for (const id of plan.complete.slice(0, MAX_LINES)) {
    out.push({
      actor: "canvas", kind: "canvas.completed", taskId: idOf.get(id),
      summary: `${q(titleOf.get(id) ?? "")} ya está entregada en Canvas: marcada como hecha`,
    });
  }
  for (const id of plan.vanished) {
    out.push({
      actor: "canvas", kind: "canvas.vanished", taskId: idOf.get(id),
      summary: `${q(titleOf.get(id) ?? "")} ya no está en Canvas: se fue a la papelera`,
    });
  }
  if (plan.vanishedHeld) {
    out.push({
      actor: "system", kind: "canvas.vanish_held",
      summary: `${plan.vanishedHeld} tareas parecían desaparecer de Canvas de golpe; por si era un fallo de Canvas, no se tocó ninguna`,
      meta: { count: plan.vanishedHeld },
    });
  }
  return out;
}

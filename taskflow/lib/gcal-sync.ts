import "server-only";

import type { Ctx } from "./data";
import { gcalConfigured, requireGoogleEnv } from "./env.server";
import {
  type GcalCalendar,
  type GcalEventRow,
  GcalError,
  type GetOptions,
  gcalWindow,
  listCalendars,
  listEvents,
  mapEvent,
  openToken,
  refreshAccess,
} from "./gcal";
import { type ActivityEntry, logActivity } from "./activity";
import { type ErrorCode, errorCodeOf, logEvent, safeMessage } from "./log";
import { recordRun } from "./sync-state";

export type GcalSyncResult = {
  items: number;
  calendars: GcalCalendar[];
  added: number;
  removed: number;
  /** Si se leyó todo. Si no, no se borró nada. */
  complete: boolean;
  message: string;
};

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Lo que hay de Google en la ventana, para saber qué entró y qué sobra. De a mil, que es el tope de PostgREST. */
async function existentes(ctx: Ctx, w: ReturnType<typeof gcalWindow>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const tipo of ["con hora", "día completo"] as const) {
    for (let desde = 0; ; desde += 1000) {
      const q = ctx.supabase.from("events").select("id, external_id").eq("user_id", ctx.userId).eq("source", "gcal");
      const { data, error } = await (tipo === "con hora"
        ? q.gte("starts_at", w.timeMin).lt("starts_at", w.timeMax)
        : q.gte("all_day_date", w.fromDay).lte("all_day_date", w.toDay)
      )
        .order("id")
        .range(desde, desde + 999)
        .returns<{ id: string; external_id: string }[]>();
      if (error) throw new GcalError("GCAL_DB_FAILED", "No se pudieron leer los eventos guardados: " + error.message, true);
      for (const r of data ?? []) out.set(r.external_id, r.id);
      if ((data ?? []).length < 1000) break;
    }
  }
  return out;
}

/**
 * Google devuelve lo que se SOLAPA con la ventana: un evento que empezó antes
 * también viene. Se guarda sólo lo que empieza dentro, que es exactamente lo
 * que `existentes` compara; si no, eso contaría como "nuevo" en cada corrida.
 */
const enVentana = (r: GcalEventRow, w: ReturnType<typeof gcalWindow>) =>
  r.starts_at ? r.starts_at >= w.timeMin && r.starts_at < w.timeMax : r.all_day_date! >= w.fromDay && r.all_day_date! <= w.toDay;

/**
 * Trae los eventos de Google y los deja en `events`.
 *
 * Idempotente: la clave es calendario + evento, así que correrlo dos veces
 * deja las mismas filas. Primero se guarda lo nuevo y DESPUÉS se quita lo que
 * ya no está, y sólo si se leyó todo: un calendario que falló a medias no
 * puede vaciar tu semana. Nunca escribe en Google.
 */
export async function syncGcal(ctx: Ctx, opts: GetOptions = {}): Promise<GcalSyncResult> {
  if (!gcalConfigured()) throw new GcalError("GCAL_NOT_CONFIGURED", "Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor");
  const env = requireGoogleEnv();

  const { data: link, error: linkErr } = await ctx.supabase
    .from("gcal_links")
    .select("refresh_token")
    .eq("user_id", ctx.userId)
    .maybeSingle<{ refresh_token: string }>();
  if (linkErr) throw new GcalError("GCAL_DB_FAILED", "No se pudo leer la conexión con Google: " + linkErr.message, true);
  if (!link) throw new GcalError("GCAL_NOT_LINKED", "Google Calendar no está conectado");

  const refresh = openToken(link.refresh_token, env.clientSecret);
  if (!refresh) throw new GcalError("GCAL_REVOKED", "El permiso guardado ya no se puede leer: vuelve a conectar Google Calendar");

  const token = await refreshAccess(refresh, env);
  const calendars = await listCalendars(token, opts);
  const w = gcalWindow(ctx.today, ctx.tz);

  let complete = true;
  const rows = new Map<string, GcalEventRow>();
  for (const cal of calendars) {
    try {
      const r = await listEvents(token, cal.id, w, opts);
      complete &&= r.complete;
      for (const ev of r.items) for (const row of mapEvent(ev, cal)) if (enVentana(row, w)) rows.set(row.external_id, row);
    } catch (e) {
      // Un calendario que desapareció entre la lista y la lectura no tumba
      // los demás; pero entonces no se sabe qué sobra, y no se borra nada.
      if (e instanceof GcalError && (e.status === 404 || e.status === 403) && e.code === "GCAL_FORBIDDEN") {
        complete = false;
        continue;
      }
      throw e;
    }
  }

  const antes = await existentes(ctx, w);
  const lista = [...rows.values()].map((r) => ({ ...r, user_id: ctx.userId }));
  for (let i = 0; i < lista.length; i += 500) {
    const { error } = await ctx.supabase.from("events").upsert(lista.slice(i, i + 500), { onConflict: "user_id,source,external_id" });
    if (error) throw new GcalError("GCAL_DB_FAILED", "No se pudieron guardar los eventos: " + error.message, true);
  }

  const added = lista.filter((r) => !antes.has(r.external_id)).length;
  let removed = 0;
  if (complete) {
    const sobran = [...antes].filter(([ext]) => !rows.has(ext)).map(([, id]) => id);
    for (let i = 0; i < sobran.length; i += 100) {
      const { error } = await ctx.supabase.from("events").delete().eq("user_id", ctx.userId).eq("source", "gcal").in("id", sobran.slice(i, i + 100));
      if (error) throw new GcalError("GCAL_DB_FAILED", "No se pudieron quitar los eventos viejos: " + error.message, true);
      removed += Math.min(100, sobran.length - i);
    }
  }

  await ctx.supabase.from("gcal_links").update({ calendars }).eq("user_id", ctx.userId);

  const message =
    `${plural(lista.length, "evento", "eventos")} de ${plural(calendars.length, "calendario", "calendarios")}` +
    (added ? `, ${added} nuevo${added === 1 ? "" : "s"}` : "") +
    (removed ? `, ${removed} quitado${removed === 1 ? "" : "s"}` : "") +
    (complete ? "" : " (lectura incompleta: no se quitó nada)");
  return { items: lista.length, calendars, added, removed, complete, message };
}

export type GcalRun = { ok: true; result: GcalSyncResult } | { ok: false; message: string; code?: ErrorCode };

/**
 * Corre el sync y deja constancia: `sync_state`, la actividad (sólo cuando
 * algo cambió o empezó a fallar, no cada tres horas) y el log.
 */
export async function runGcalSync(ctx: Ctx, trigger: "cron" | "manual", opts: GetOptions = {}): Promise<GcalRun> {
  const started = Date.now();
  const { data: prev } = await ctx.supabase
    .from("sync_state")
    .select("last_error_code, last_error_at, last_success_at")
    .eq("user_id", ctx.userId)
    .eq("source", "gcal")
    .maybeSingle<{ last_error_code: string | null; last_error_at: string | null; last_success_at: string | null }>();
  const yaFallaba = Boolean(prev?.last_error_at && (!prev.last_success_at || prev.last_error_at > prev.last_success_at));

  try {
    const result = await syncGcal(ctx, opts);
    await recordRun(ctx.supabase, ctx.userId, "gcal", { ok: true, items: result.items });
    const entradas: ActivityEntry[] = [];
    if (trigger === "manual") {
      entradas.push({ actor: "user", kind: "gcal.sync", summary: `Sincronizaste Google Calendar: ${result.message}` });
    } else if (result.added || result.removed || yaFallaba) {
      entradas.push({
        actor: "system", kind: "gcal.sync",
        summary: yaFallaba ? `Google Calendar volvió a sincronizar: ${result.message}` : `El reloj sincronizó Google Calendar: ${result.message}`,
        meta: { added: result.added, removed: result.removed },
      });
    }
    if (entradas.length) await logActivity(ctx, entradas);
    logEvent({
      event: "gcal.sync", result: "ok", userId: ctx.userId, integration: "gcal", trigger,
      items: result.items, calendars: result.calendars.length, added: result.added, removed: result.removed,
      complete: result.complete, ms: Date.now() - started,
    });
    return { ok: true, result };
  } catch (e) {
    const code = errorCodeOf(e);
    const message = safeMessage(e, "Falló el sync de Google Calendar");
    await recordRun(ctx.supabase, ctx.userId, "gcal", { ok: false, error: message, code });
    if (trigger === "manual" || !yaFallaba || prev?.last_error_code !== (code ?? null)) {
      await logActivity(ctx, {
        actor: trigger === "manual" ? "user" : "system", kind: "gcal.failed",
        summary: `Google Calendar no sincronizó: ${message}`, meta: { code: code ?? null },
      });
    }
    logEvent({ event: "gcal.sync", result: "error", userId: ctx.userId, integration: "gcal", trigger, errorCode: code, message, ms: Date.now() - started });
    return { ok: false, message, code };
  }
}

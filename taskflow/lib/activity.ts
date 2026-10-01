import "server-only";

import type { Ctx } from "./data";
import { MONTHS_SHORT, dayOfMonth, monthOf } from "./date";
import { logEvent } from "./log";

/**
 * El registro de Actividad: una frase por cosa que pasó, con quién la hizo.
 *
 *  - `user`: tú (aceptar una propuesta, importar un calendario, borrar).
 *  - `canvas`: el sync (agregó, cambió, respetó tu edición, marcó entregada).
 *  - `system`: el reloj y los canales (resumen enviado, Telegram desconectado).
 *  - `ai`: Claude (propuso un plan, falló).
 *
 * Escribir aquí NUNCA puede tumbar lo que se estaba haciendo: si falla, queda
 * en el log del servidor y ya.
 */

export type Actor = "user" | "canvas" | "system" | "ai";

export type ActivityEntry = {
  actor: Actor;
  /** Corto y estable: "canvas.added", "digest.sent", "ai.proposal"… */
  kind: string;
  summary: string;
  taskId?: string | null;
  /** Conteos, costo, códigos. Nada de contenido privado. */
  meta?: Record<string, string | number | boolean | null>;
};

/** Días que se guarda la actividad. */
export const ACTIVITY_RETENTION_DAYS = 90;

/** Un título dentro de una frase: entre comillas y sin pasarse de largo. */
export const q = (title: string) => {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  return `«${t.length > 60 ? t.slice(0, 59) + "…" : t}»`;
};

/** "15 oct". */
export const shortDate = (ymd: string | null | undefined) =>
  ymd ? `${dayOfMonth(ymd)} ${MONTHS_SHORT[monthOf(ymd)]}` : "sin fecha";

export async function logActivity(
  ctx: Pick<Ctx, "supabase" | "userId">,
  entries: ActivityEntry | ActivityEntry[],
): Promise<void> {
  const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e.summary);
  if (!list.length) return;
  const rows = list.map((e) => ({
    user_id: ctx.userId,
    actor: e.actor,
    kind: e.kind.slice(0, 40),
    summary: e.summary.slice(0, 240),
    task_id: e.taskId ?? null,
    meta: e.meta ?? {},
  }));
  try {
    const { error } = await ctx.supabase.from("activity_log").insert(rows);
    if (error) throw new Error(error.message);
  } catch (e) {
    logEvent({
      event: "activity.write", result: "error", userId: ctx.userId, integration: "app",
      message: e instanceof Error ? e.message : String(e), count: rows.length,
    });
  }
}

/** Borra lo que pasó de los 90 días. Lo corre el reloj. */
export async function purgeActivity(ctx: Pick<Ctx, "supabase" | "userId">, now: Date): Promise<void> {
  const limite = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86400_000).toISOString();
  await ctx.supabase.from("activity_log").delete().eq("user_id", ctx.userId).lt("at", limite);
}

/**
 * Lo que costó Claude en los últimos `days` días, sumando lo que cada
 * propuesta dejó anotado. Aproximado: es el precio de lista por token.
 */
export async function recentAiCost(
  ctx: Pick<Ctx, "supabase" | "userId">,
  now: number = Date.now(),
  days = 30,
): Promise<{ usd: number; calls: number }> {
  const desde = new Date(now - days * 86400_000).toISOString();
  const { data } = await ctx.supabase
    .from("activity_log")
    .select("meta")
    .eq("user_id", ctx.userId)
    .eq("actor", "ai")
    .eq("kind", "ai.proposal")
    .gte("at", desde)
    .returns<{ meta: { costUsd?: number } | null }[]>();
  let usd = 0;
  for (const r of data ?? []) usd += Number(r.meta?.costUsd) || 0;
  return { usd, calls: data?.length ?? 0 };
}

export type ActivityRow = {
  id: number;
  at: string;
  actor: Actor;
  kind: string;
  summary: string;
  task_id: string | null;
};

export const ACTORS: Actor[] = ["user", "canvas", "system", "ai"];

/** Lo último que pasó, del más nuevo al más viejo. */
export async function loadActivity(
  ctx: Pick<Ctx, "supabase" | "userId">,
  actor: Actor | null,
  limit = 200,
): Promise<ActivityRow[]> {
  let qy = ctx.supabase
    .from("activity_log")
    .select("id, at, actor, kind, summary, task_id")
    .eq("user_id", ctx.userId);
  if (actor) qy = qy.eq("actor", actor);
  const { data } = await qy.order("at", { ascending: false }).limit(limit).returns<ActivityRow[]>();
  return data ?? [];
}

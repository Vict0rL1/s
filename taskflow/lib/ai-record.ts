import "server-only";

import { aiErrorInfo, aiModel } from "./ai";
import type { Ctx } from "./data";
import { type ErrorCode, logEvent } from "./log";
import { recordRun } from "./sync-state";
import { logActivity } from "./activity";

type Outcome =
  | { ok: true; costUsd: number; ms: number; summary: string; taskId?: string | null }
  | { ok: false; error: unknown; ms: number; taskId?: string | null };

/**
 * Deja constancia de una llamada a Claude: en el log (con el costo) y en
 * `sync_state`, que es lo que lee Ajustes → Estado del sistema.
 *
 * Las condiciones del día ("no te queda ningún hueco") no cuentan como fallo
 * de la integración: Claude no tuvo nada que ver.
 */
export async function recordAiCall(
  ctx: Ctx,
  what: "plan" | "breakdown" | "prep",
  outcome: Outcome,
): Promise<{ code?: ErrorCode; message: string }> {
  if (outcome.ok) {
    await recordRun(ctx.supabase, ctx.userId, "ai", { ok: true });
    // El costo queda en la línea de Actividad: es de donde sale el "costo
    // reciente" de Ajustes → Estado del sistema.
    await logActivity(ctx, {
      actor: "ai", kind: "ai.proposal", summary: outcome.summary, taskId: outcome.taskId,
      meta: { what, model: aiModel(), costUsd: Number(outcome.costUsd.toFixed(5)) },
    });
    logEvent({
      event: `ai.${what}`, result: "ok", userId: ctx.userId, integration: "ai",
      model: aiModel(), costUsd: Number(outcome.costUsd.toFixed(5)), ms: outcome.ms,
    });
    return { message: "" };
  }

  const info = aiErrorInfo(outcome.error);
  if (info.code) {
    await recordRun(ctx.supabase, ctx.userId, "ai", { ok: false, error: info.message, code: info.code });
    await logActivity(ctx, {
      actor: "ai", kind: "ai.failed",
      summary: `Claude no pudo ${what === "plan" ? "armar el plan" : what === "prep" ? "nombrar las sesiones" : "partir la tarea"}: ${info.message}`,
      taskId: outcome.taskId, meta: { what, code: info.code },
    });
  }
  logEvent({
    event: `ai.${what}`, result: info.code ? "error" : "skipped", userId: ctx.userId, integration: "ai",
    model: aiModel(), errorCode: info.code, message: info.message, ms: outcome.ms,
  });
  return info;
}

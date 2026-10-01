import "server-only";

import type { Ctx } from "./data";
import { type ErrorCode, logEvent } from "./log";

/** Las integraciones que dejan constancia en `sync_state`. */
export type IntegrationSource = "canvas" | "gcal" | "ics" | "cron" | "push" | "telegram" | "ai";

export type RunOutcome =
  | { ok: true; items?: number }
  | { ok: false; error: string; code?: ErrorCode };

/**
 * Deja constancia de una corrida, salga bien o mal.
 *
 * Un fallo NO borra `last_success_at`: es justo el dato que dice desde cuándo
 * no funciona. Y un éxito no borra el último error: queda como historia, y
 * quien lo lee sabe que ya pasó porque es más viejo que el último éxito.
 *
 * Si escribir falla, se registra y ya. Esto es la bitácora; que falle la
 * bitácora no puede tumbar lo que se estaba haciendo.
 */
export async function recordRun(
  supabase: Ctx["supabase"],
  userId: string,
  source: IntegrationSource,
  outcome: RunOutcome,
): Promise<void> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { user_id: userId, source, last_synced_at: now };
  if (outcome.ok) {
    row.last_success_at = now;
    if (outcome.items != null) row.items_synced = outcome.items;
  } else {
    row.last_error = outcome.error.slice(0, 300);
    row.last_error_code = outcome.code ?? null;
    row.last_error_at = now;
  }

  const { error } = await supabase.from("sync_state").upsert(row, { onConflict: "user_id,source" });
  if (error) {
    logEvent({ event: "sync_state.write", result: "error", userId, integration: "app", message: error.message });
  }
}

/** ¿El último intento falló? (o sea: hay un error más nuevo que el último éxito) */
export function isFailing(s: { last_error_at: string | null; last_success_at: string | null } | null): boolean {
  if (!s?.last_error_at) return false;
  return !s.last_success_at || s.last_error_at > s.last_success_at;
}

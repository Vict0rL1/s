import "server-only";

import type { Ctx } from "./data";
import { canvasConfigured, gcalConfigured, plannerConfigured, pushSendConfigured, telegramConfigured } from "./env.server";
import { type Health, type Source, type StateRow, computeHealth } from "./health";

const COLS = "source, last_synced_at, last_success_at, last_error, last_error_at, last_error_code, items_synced";

export type Status = {
  /** La hora con la que se calculó todo, para que la página diga "hace X" con la misma. */
  now: number;
  health: Health;
  states: Partial<Record<Source, StateRow>>;
  pushEndpoints: string[];
  telegramLinkedAt: string | null;
  /** La conexión con Google Calendar, sin el token: cuándo y qué calendarios. */
  gcal: { linkedAt: string; calendars: string[] } | null;
};

/**
 * Lo que hace falta para saber si todo anda. Cuatro consultas pequeñas, en
 * paralelo: el layout las corre en cada vista para el aviso de arriba.
 */
export async function loadStatus(ctx: Ctx, now = Date.now()): Promise<Status> {
  const [states, subs, chat, gcal] = await Promise.all([
    ctx.supabase.from("sync_state").select(COLS).eq("user_id", ctx.userId).returns<StateRow[]>(),
    ctx.supabase.from("push_subscriptions").select("endpoint").eq("user_id", ctx.userId).returns<{ endpoint: string }[]>(),
    ctx.supabase
      .from("telegram_chats")
      .select("chat_id, linked_at")
      .eq("user_id", ctx.userId)
      .maybeSingle<{ chat_id: number | null; linked_at: string | null }>(),
    // Nunca `refresh_token`: aunque vaya cifrado, esta consulta corre en cada vista.
    ctx.supabase
      .from("gcal_links")
      .select("linked_at, calendars")
      .eq("user_id", ctx.userId)
      .maybeSingle<{ linked_at: string; calendars: { name?: string }[] | null }>(),
  ]);

  const bySource: Partial<Record<Source, StateRow>> = {};
  for (const s of states.data ?? []) bySource[s.source as Source] = s;
  const pushEndpoints = (subs.data ?? []).map((s) => s.endpoint);
  const linked = Boolean(chat.data?.chat_id);

  return {
    now,
    states: bySource,
    pushEndpoints,
    telegramLinkedAt: linked ? chat.data?.linked_at ?? null : null,
    gcal: gcal.data
      ? { linkedAt: gcal.data.linked_at, calendars: (gcal.data.calendars ?? []).map((c) => String(c?.name ?? "")).filter(Boolean) }
      : null,
    health: computeHealth({
      now,
      states: bySource,
      canvasConfigured: canvasConfigured(),
      gcalConfigured: gcalConfigured(),
      gcalLinked: Boolean(gcal.data),
      pushConfigured: pushSendConfigured(),
      pushDevices: pushEndpoints.length,
      telegramConfigured: telegramConfigured(),
      telegramLinked: linked,
      aiConfigured: plannerConfigured(),
    }),
  };
}

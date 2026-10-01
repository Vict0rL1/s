import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { canvasSyncDue } from "./canvas";
import { runCanvasSync } from "./canvas-sync";
import { canvasConfigured, gcalConfigured, pushSendConfigured, telegramConfigured } from "./env.server";
import { runGcalSync } from "./gcal-sync";
import { DEFAULT_TIMEZONE, addDays, minutesInTz, todayInTz } from "./date";
import { buildDigest, digestDue, sendDigest, type Digest, type DigestKind, type PushSubscriptionRow } from "./push";
import { classifyTelegramError, sendDigestTelegram } from "./telegram";
import { loadEvents, loadTasks, type Ctx } from "./data";
import { type ErrorCode, IntegrationError, errorCodeOf, logEvent, safeMessage } from "./log";
import { recordRun } from "./sync-state";
import { withHealthNote } from "./health";
import { logActivity, purgeActivity, q } from "./activity";
import { autoEmptyTrash } from "./trash";
import { loadStatus } from "./status";
import type { Profile } from "./types";

/**
 * El reloj de la app: lo que hace `/api/sync` en cada tic.
 *
 * Vive aquí y no en el route handler para poder probarlo entero contra una
 * base de verdad. La ruta sólo autentica y llama a `runClock`.
 *
 * Corre con la service role, que **salta la RLS**: todo lo de adentro filtra
 * por `user_id` a mano.
 */

export type Admin = SupabaseClient;

export type ClockOptions = {
  /** Para el botón "Abrir TaskFlow" de Telegram. */
  origin: string;
  /** Forzar este aviso ya, saltándose la ventana y el registro. */
  digest?: DigestKind | null;
  /** Forzar el sync de Canvas aunque acabe de correr. */
  forceCanvas?: boolean;
  /** Sólo para pruebas. */
  now?: Date;
};

export type ClockLine = { user: string; ok: boolean; message: string; aviso: string };

export async function runClock(admin: Admin, opts: ClockOptions): Promise<ClockLine[]> {
  const now = opts.now ?? new Date();
  const { data: profiles, error } = await admin.from("profiles").select("*").returns<Profile[]>();
  if (error) throw new IntegrationError("CRON_DB_FAILED", "No se pudieron leer los perfiles: " + error.message, true);

  const lines: ClockLine[] = [];
  for (const profile of profiles ?? []) {
    // Cada perfil por separado: que uno reviente no deja sin aviso a los demás.
    lines.push(await tick(admin, profile, now, opts));
  }
  return lines;
}

async function tick(admin: Admin, profile: Profile, now: Date, opts: ClockOptions): Promise<ClockLine> {
  const tz = profile.timezone || DEFAULT_TIMEZONE;
  const ctx: Ctx = {
    supabase: admin as unknown as Ctx["supabase"],
    userId: profile.id,
    profile,
    tz,
    today: todayInTz(tz, now),
  };
  const hora = Math.floor(minutesInTz(tz, now) / 60);

  // El latido. Primero el intento, al final el éxito: si la función muere a
  // medias (timeout de Vercel), Ajustes ve una corrida que empezó y no terminó.
  await admin
    .from("sync_state")
    .upsert({ user_id: ctx.userId, source: "cron", last_synced_at: now.toISOString() }, { onConflict: "user_id,source" });

  try {
    let message = "Canvas no está configurado";
    let ok = true;

    if (canvasConfigured()) {
      if (!opts.forceCanvas && !(await canvasToca(ctx, admin, now))) {
        message = "Canvas: sincronizado hace poco, se salta";
      } else {
        const r = await runCanvasSync(ctx, "cron");
        message = r.ok ? r.result.message : r.message;
        ok = r.ok;
      }
    }

    // Google Calendar, cada 3 h como Canvas, sólo si está conectado. Su fallo
    // queda en su propia fila de Estado; no tumba el aviso.
    if (gcalConfigured() && (await gcalToca(ctx, admin, now))) {
      const g = await runGcalSync(ctx, "cron");
      message += ` · Google Calendar: ${g.ok ? g.result.message : g.message}`;
      ok = ok && g.ok;
    }

    // El aviso va después del sync, para que cuente los deadlines que acaban
    // de entrar. Que falle no debe tumbar la corrida.
    const kind = opts.digest ?? digestDue(profile, hora);
    const hayCanal = pushSendConfigured() || telegramConfigured();
    let aviso = !kind ? `no toca (son las ${hora})` : "ningún canal configurado (ni push ni Telegram)";
    if (kind && hayCanal) {
      try {
        aviso = await avisar(ctx, admin, kind, opts.digest != null, opts.origin, now);
      } catch (e) {
        aviso = "falló el aviso: " + safeMessage(e, "error");
      }
    }

    // La actividad vieja y la papelera vencida se limpian aquí, de a poco.
    await purgeActivity(ctx, now);
    const limpio = await autoEmptyTrash(ctx, now, ctx.today);
    if (limpio.tasks || limpio.notes) {
      await logActivity(ctx, {
        actor: "system", kind: "trash.auto",
        summary: `Se vació lo que llevaba más de 30 días en la papelera: ${limpio.tasks} tarea${limpio.tasks === 1 ? "" : "s"} y ${limpio.notes} nota${limpio.notes === 1 ? "" : "s"}`,
        meta: limpio,
      });
    }

    await recordRun(ctx.supabase, ctx.userId, "cron", { ok: true });
    logEvent({ event: "cron.tick", result: "ok", userId: ctx.userId, integration: "cron", hour: hora, digest: kind ?? null });
    return { user: profile.id, ok, message, aviso };
  } catch (e) {
    const message = safeMessage(e, "Falló la corrida");
    const code = errorCodeOf(e) ?? "CRON_DB_FAILED";
    await recordRun(ctx.supabase, ctx.userId, "cron", { ok: false, error: message, code });
    logEvent({ event: "cron.tick", result: "error", userId: ctx.userId, integration: "cron", errorCode: code, message });
    return { user: profile.id, ok: false, message, aviso: "no se llegó al aviso" };
  }
}

/* ------------------------------------------------------------------ Canvas */

/** ¿Toca preguntarle a Canvas? Desde el último sync que salió bien, no desde el último intento. */
async function canvasToca(ctx: Ctx, admin: Admin, now: Date): Promise<boolean> {
  const { data } = await admin
    .from("sync_state")
    .select("last_success_at")
    .eq("user_id", ctx.userId)
    .eq("source", "canvas")
    .maybeSingle<{ last_success_at: string | null }>();
  return canvasSyncDue(data?.last_success_at, now.getTime());
}

/* --------------------------------------------------------- Google Calendar */

/** Conectado y sin un sync bueno en las últimas 3 h. */
async function gcalToca(ctx: Ctx, admin: Admin, now: Date): Promise<boolean> {
  const [{ data: link }, { data: st }] = await Promise.all([
    admin.from("gcal_links").select("user_id").eq("user_id", ctx.userId).maybeSingle(),
    admin
      .from("sync_state")
      .select("last_success_at")
      .eq("user_id", ctx.userId)
      .eq("source", "gcal")
      .maybeSingle<{ last_success_at: string | null }>(),
  ]);
  return Boolean(link) && canvasSyncDue(st?.last_success_at, now.getTime());
}

/* ------------------------------------------------------------------ avisos */

/**
 * Manda el aviso que toca, si hay algo que decir.
 *
 * Devuelve una línea legible para el cuerpo de la respuesta.
 *
 * El orden importa: **primero se reserva el turno en `digest_log`, después se
 * arma el aviso**. Al revés, un día sin nada que decir dejaría el turno libre
 * y el reloj volvería a preguntar a las 8, a las 9 y a las 10, hasta que algo
 * apareciera y el aviso de la mañana saliera a mediodía. Con la reserva
 * primero, la decisión se toma una sola vez al día, en la primera corrida de
 * la ventana. Si el envío se cae de verdad, la reserva se devuelve.
 */
export async function avisar(
  ctx: Ctx,
  admin: Admin,
  kind: DigestKind,
  forzado: boolean,
  origin: string,
  now: Date = new Date(),
): Promise<string> {
  if (!forzado && !(await reservar(ctx, admin, kind))) return `${kind}: ya se avisó hoy`;

  const dia = kind === "night" ? addDays(ctx.today, 1) : ctx.today;

  try {
    const [tasks, events] = await Promise.all([loadTasks(ctx), loadEvents(ctx, dia, dia)]);

    let digest = buildDigest(kind, tasks, events, ctx.today);
    // Por la mañana, además, lo que esté fallando (lib/health.ts). Se mide
    // ANTES de mandar: es el estado que dejaron las corridas anteriores.
    if (kind === "morning") {
      const { health } = await loadStatus(ctx, now.getTime());
      digest = withHealthNote(digest, health.alerts);
    }
    if (!digest) return `${kind}: nada que avisar`;

    // El título viaja en la respuesta a propósito: es lo único que permite
    // mirar el registro de Vercel y saber QUÉ se mandó, no sólo cuántos. El
    // workflow de GitHub no imprime este cuerpo, justo por eso.
    const que = ` «${digest.title}»`;

    // Los dos canales van por separado y ninguno puede tumbar al otro: un
    // Telegram caído no debe dejarte sin el push, ni al revés. Por lo mismo,
    // sus fallos se informan en la línea en vez de lanzarse — si se lanzaran,
    // la reserva se devolvería y el canal que SÍ llegó repetiría el aviso
    // dentro de una hora.
    const [pushR, tgR] = await Promise.all([deliverPush(ctx, admin, digest), deliverTelegram(ctx, admin, digest, origin)]);

    const canales = [
      pushR?.sent ? `push a ${pushR.sent} dispositivo${pushR.sent > 1 ? "s" : ""}` : null,
      tgR?.ok ? "Telegram" : null,
    ].filter(Boolean);
    const nombre = kind === "night" ? "Resumen de la noche" : "Resumen de la mañana";
    await logActivity(ctx, {
      actor: "system", kind: "digest.sent",
      summary: canales.length
        ? `${nombre} enviado: ${q(digest.title)} (${canales.join(" y ")})`
        : `${nombre}: ${q(digest.title)} no llegó por ningún canal`,
      meta: { kind, push: pushR?.sent ?? 0, telegram: Boolean(tgR?.ok) },
    });

    return `${kind}: ${[pushR, tgR].map((p) => p?.line).filter(Boolean).join(" · ") || "sin canales conectados"}${que}`;
  } catch (e) {
    // Se cayó la base: devolver el turno para que el reloj lo reintente dentro
    // de una hora, mientras la ventana siga abierta.
    if (!forzado) await liberar(ctx, admin, kind);
    throw e;
  }
}

export type PushDelivery = { line: string; sent: number; gone: number; failed: number; code?: ErrorCode };

/**
 * Push a cada navegador suscrito, con la limpieza de los muertos y la
 * constancia en `sync_state`. Lo usan el reloj y el botón de prueba de Ajustes.
 * `null` si push no está configurado en el servidor.
 *
 * `db` puede ser la service role (el reloj) o la sesión del usuario (el botón):
 * todo va filtrado por `user_id` igual.
 */
export async function deliverPush(ctx: Ctx, db: Admin, digest: Digest): Promise<PushDelivery | null> {
  if (!pushSendConfigured()) return null;

  const { data: subs, error } = await db
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", ctx.userId)
    .returns<PushSubscriptionRow[]>();
  if (error) throw new IntegrationError("CRON_DB_FAILED", "No se pudieron leer las suscripciones: " + error.message, true);

  if (!subs?.length) return { line: "push: sin navegadores suscritos", sent: 0, gone: 0, failed: 0 };

  const r = await sendDigest(subs, digest);

  // Las suscripciones muertas se borran: si no, fallan todos los días.
  if (r.caducadas.length) {
    await db.from("push_subscriptions").delete().eq("user_id", ctx.userId).in("endpoint", r.caducadas);
    await logActivity(ctx, {
      actor: "system", kind: "push.gone",
      summary: r.caducadas.length > 1
        ? `Se quitaron ${r.caducadas.length} suscripciones push que ya no existían (navegador desinstalado o permiso revocado)`
        : "Se quitó una suscripción push que ya no existía (navegador desinstalado o permiso revocado)",
      meta: { count: r.caducadas.length },
    });
  }

  let code: ErrorCode | undefined;
  if (r.enviadas) {
    await recordRun(ctx.supabase, ctx.userId, "push", { ok: true, items: r.enviadas });
  } else {
    // Ninguno llegó. Si es porque todos estaban muertos, eso es lo que hay
    // que contar: el usuario cree que tiene avisos y ya no los tiene.
    code = r.errorCode ?? "PUSH_SUBSCRIPTION_GONE";
    const error = r.errorCode
      ? "Ningún navegador aceptó el aviso."
      : "Tus navegadores se dieron de baja de los avisos. Vuelve a activarlos en Ajustes.";
    await recordRun(ctx.supabase, ctx.userId, "push", { ok: false, error, code });
  }
  logEvent({
    event: "push.send", result: r.enviadas ? "ok" : "error", userId: ctx.userId, integration: "push",
    sent: r.enviadas, gone: r.caducadas.length, failed: r.fallidas, errorCode: code ?? r.errorCode,
  });

  return {
    line: `push: ${r.enviadas} enviado(s)` +
      (r.caducadas.length ? `, ${r.caducadas.length} caducada(s) borrada(s)` : "") +
      (r.fallidas ? `, ${r.fallidas} fallida(s)` : ""),
    sent: r.enviadas,
    gone: r.caducadas.length,
    failed: r.fallidas,
    code: code ?? r.errorCode,
  };
}

export type TelegramDelivery = { line: string; ok: boolean; linked: boolean; code?: ErrorCode; message?: string };

/**
 * Un mensaje al chat de Telegram conectado. `null` si Telegram no está
 * configurado en el servidor. Igual que `deliverPush`, lo usan el reloj y el
 * botón de prueba.
 */
export async function deliverTelegram(ctx: Ctx, db: Admin, digest: Digest, origin: string): Promise<TelegramDelivery | null> {
  if (!telegramConfigured()) return null;

  const { data: chat, error } = await db
    .from("telegram_chats")
    .select("chat_id")
    .eq("user_id", ctx.userId)
    .not("chat_id", "is", null)
    .maybeSingle<{ chat_id: number }>();
  if (error) throw new IntegrationError("CRON_DB_FAILED", "No se pudo leer el chat de Telegram: " + error.message, true);

  if (!chat) return { line: "telegram: sin chat conectado", ok: false, linked: false };

  try {
    await sendDigestTelegram(chat.chat_id, digest, origin);
    await recordRun(ctx.supabase, ctx.userId, "telegram", { ok: true });
    logEvent({ event: "telegram.send", result: "ok", userId: ctx.userId, integration: "telegram" });
    return { line: "telegram: enviado", ok: true, linked: true };
  } catch (e) {
    const t = classifyTelegramError(e);
    // Bloqueado o chat borrado: el chat está muerto y se suelta, igual que una
    // suscripción push caducada; si no, fallaría dos veces al día para siempre.
    // Pero ANTES se deja escrito por qué, para que Ajustes lo explique: antes
    // simplemente desaparecía y Victor no sabía que había dejado de recibir.
    if (t.dead) {
      await db.from("telegram_chats").delete().eq("user_id", ctx.userId).eq("chat_id", chat.chat_id);
      await logActivity(ctx, { actor: "system", kind: "telegram.unlinked", summary: `Telegram se desconectó: ${t.message}`, meta: { code: t.code } });
    }
    await recordRun(ctx.supabase, ctx.userId, "telegram", { ok: false, error: t.message, code: t.code });
    logEvent({ event: "telegram.send", result: "error", userId: ctx.userId, integration: "telegram", errorCode: t.code });
    return {
      line: t.dead ? `telegram: ${t.code}, desconectado` : `telegram: falló (${t.code})`,
      ok: false,
      linked: !t.dead,
      code: t.code,
      message: t.message,
    };
  }
}

/**
 * Reserva el aviso del día. `true` si es nuestro, `false` si ya estaba.
 *
 * Quien decide no es esta función: es la clave primaria de `digest_log`. El
 * insert va con `ON CONFLICT DO NOTHING` y `.select()` devuelve sólo lo que se
 * insertó de verdad, así que una lista vacía significa "otra corrida llegó
 * antes". Es la única forma de que dos disparos simultáneos (el cron de Vercel
 * y el de GitHub caen a la misma hora) no manden el aviso dos veces.
 */
async function reservar(ctx: Ctx, admin: Admin, kind: DigestKind): Promise<boolean> {
  const { data, error } = await admin
    .from("digest_log")
    .upsert(
      { user_id: ctx.userId, day: ctx.today, kind },
      { onConflict: "user_id,day,kind", ignoreDuplicates: true },
    )
    .select("kind");
  // Si la base no contesta, no hay reserva: mejor no avisar esta hora que
  // avisar dos veces. El reloj vuelve a preguntar dentro de una hora.
  if (error) throw new IntegrationError("CRON_DB_FAILED", "No se pudo reservar el aviso: " + error.message, true);
  return Boolean(data?.length);
}

async function liberar(ctx: Ctx, admin: Admin, kind: DigestKind): Promise<void> {
  await admin
    .from("digest_log")
    .delete()
    .eq("user_id", ctx.userId)
    .eq("day", ctx.today)
    .eq("kind", kind);
}

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSync, syncCanvas } from "@/lib/canvas-sync";
import { CRON_SECRET, canvasConfigured, pushSendConfigured } from "@/lib/env.server";
import { DEFAULT_TIMEZONE, addDays, minutesInTz, todayInTz } from "@/lib/date";
import {
  buildDigest,
  digestDue,
  sendDigest,
  type DigestKind,
  type PushSubscriptionRow,
} from "@/lib/push";
import { loadEvents, loadTasks, type Ctx } from "@/lib/data";
import type { Profile } from "@/lib/types";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * `GET /api/sync` — el reloj de la app.
 *
 * Se llama **cada hora**, no una vez al día, porque Victor pidió dos avisos
 * (el resumen de la mañana y el de la noche anterior) y el cron gratis de
 * Vercel sólo permite uno. Quien dispara cada hora es
 * `.github/workflows/clock.yml`; el cron de Vercel se queda como red de
 * seguridad para la mañana.
 *
 * Que se llame cada hora NO significa que haga todo cada hora. La petición
 * pregunta "¿qué toca ahora?" y casi siempre la respuesta es "nada":
 *
 *  - Canvas se sincroniza si la última vez fue hace más de `HORAS_ENTRE_SYNCS`.
 *  - El aviso se manda si la hora local cae en su ventana Y no se mandó ya hoy.
 *
 * Corre sin sesión, así que usa la service role y **salta la RLS**. Por eso
 * arma un contexto por perfil y todo lo de adentro filtra por `user_id` a mano.
 *
 * Sin la comparación contra `CRON_SECRET`, cualquiera en internet podría
 * disparar tus syncs; de ahí el 401.
 */
export async function GET(request: Request) {
  if (!CRON_SECRET) {
    return NextResponse.json(
      { ok: false, message: "Falta CRON_SECRET: la ruta está deshabilitada" },
      { status: 503 },
    );
  }

  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`; el workflow de
  // GitHub manda lo mismo.
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ ok: false, message: "No autorizado" }, { status: 401 });
  }

  // Dos escapes para probar a mano, que sólo funcionan con el secreto en la
  // mano: `?digest=night` manda ese aviso ya, saltándose la ventana Y el
  // registro (si no, sólo se podría probar una vez al día), y `?canvas=1`
  // fuerza el sync aunque acabe de correr.
  const params = new URL(request.url).searchParams;
  const forzado = leerKind(params.get("digest"));
  const forzarCanvas = params.get("canvas") === "1";

  const admin = createAdminClient();
  const { data: profiles, error } = await admin.from("profiles").select("*").returns<Profile[]>();
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }

  const resultados: { user: string; ok: boolean; message: string; aviso: string }[] = [];

  for (const profile of profiles ?? []) {
    const tz = profile.timezone || DEFAULT_TIMEZONE;
    const ctx: Ctx = {
      supabase: admin as unknown as Ctx["supabase"],
      userId: profile.id,
      profile,
      tz,
      today: todayInTz(tz),
    };
    const hora = Math.floor(minutesInTz(tz) / 60);

    let message = "Canvas no está configurado";
    let ok = true;

    if (canvasConfigured()) {
      if (!forzarCanvas && (await syncReciente(ctx, admin))) {
        message = "Canvas: sincronizado hace poco, se salta";
      } else {
        try {
          const r = await syncCanvas(ctx);
          await recordSync(ctx, { items: r.items });
          message = r.message;
        } catch (e) {
          message = e instanceof Error ? e.message : "Falló el sync";
          ok = false;
          await recordSync(ctx, { items: 0, error: message });
        }
      }
    }

    // El aviso va después del sync, para que cuente los deadlines que acaban
    // de entrar. Que falle no debe tumbar la corrida.
    const kind = forzado ?? digestDue(profile, hora);
    let aviso = kind ? "push no configurado" : `no toca (son las ${hora})`;
    if (kind && pushSendConfigured()) {
      try {
        aviso = await avisar(ctx, admin, kind, forzado != null);
      } catch (e) {
        aviso = "falló el aviso: " + (e instanceof Error ? e.message : String(e));
      }
    }

    resultados.push({ user: profile.id, ok, message, aviso });
  }

  // Siempre 200: un fallo de Canvas no es un fallo del reloj, y un 500 haría
  // que Vercel lo reintente sin motivo. El detalle va en el cuerpo y en
  // `sync_state`.
  return NextResponse.json({ ok: true, perfiles: resultados.length, resultados });
}

function leerKind(v: string | null): DigestKind | null {
  return v === "morning" || v === "night" ? v : null;
}

/* ------------------------------------------------------------------ Canvas */

/** Cada cuánto tiene sentido volver a preguntarle a Canvas. */
const HORAS_ENTRE_SYNCS = 3;

async function syncReciente(ctx: Ctx, admin: Admin): Promise<boolean> {
  const { data } = await admin
    .from("sync_state")
    .select("last_synced_at")
    .eq("user_id", ctx.userId)
    .eq("source", "canvas")
    .maybeSingle<{ last_synced_at: string | null }>();

  if (!data?.last_synced_at) return false;
  const edad = Date.now() - new Date(data.last_synced_at).getTime();
  return edad < HORAS_ENTRE_SYNCS * 3600_000;
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
async function avisar(
  ctx: Ctx,
  admin: Admin,
  kind: DigestKind,
  forzado: boolean,
): Promise<string> {
  if (!forzado && !(await reservar(ctx, admin, kind))) return `${kind}: ya se avisó hoy`;

  const dia = kind === "night" ? addDays(ctx.today, 1) : ctx.today;

  try {
    const [tasks, events] = await Promise.all([loadTasks(ctx), loadEvents(ctx, dia, dia)]);

    const digest = buildDigest(kind, tasks, events, ctx.today);
    if (!digest) return `${kind}: nada que avisar`;

    // El título viaja en la respuesta a propósito: es lo único que permite
    // mirar el registro de Vercel y saber QUÉ se mandó, no sólo cuántos. El
    // workflow de GitHub no imprime este cuerpo, justo por eso.
    const que = ` «${digest.title}»`;

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", ctx.userId)
      .returns<PushSubscriptionRow[]>();

    if (!subs?.length) return `${kind}: sin navegadores suscritos${que}`;

    const r = await sendDigest(subs, digest);

    // Las suscripciones muertas se borran: si no, fallan todos los días.
    if (r.caducadas.length) {
      await admin.from("push_subscriptions").delete().in("endpoint", r.caducadas);
    }

    return `${kind}: ${r.enviadas} enviado(s)` +
      (r.caducadas.length ? `, ${r.caducadas.length} caducada(s) borrada(s)` : "") +
      (r.fallidas ? `, ${r.fallidas} fallida(s)` : "") +
      que;
  } catch (e) {
    // Se cayó la base o el servicio de push: devolver el turno para que el
    // reloj lo reintente dentro de una hora, mientras la ventana siga abierta.
    if (!forzado) await liberar(ctx, admin, kind);
    throw e;
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
  const { data } = await admin
    .from("digest_log")
    .upsert(
      { user_id: ctx.userId, day: ctx.today, kind },
      { onConflict: "user_id,day,kind", ignoreDuplicates: true },
    )
    .select("kind");
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

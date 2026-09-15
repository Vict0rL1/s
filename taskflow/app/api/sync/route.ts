import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSync, syncCanvas } from "@/lib/canvas-sync";
import { CRON_SECRET, canvasConfigured, pushSendConfigured } from "@/lib/env.server";
import { DEFAULT_TIMEZONE, todayInTz } from "@/lib/date";
import { buildDigest, sendDigest, type PushSubscriptionRow } from "@/lib/push";
import { loadEvents, loadTasks, type Ctx } from "@/lib/data";
import type { Profile } from "@/lib/types";

/**
 * `GET /api/sync` — el sync diario, disparado por Vercel Cron.
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

  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`.
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ ok: false, message: "No autorizado" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: profiles, error } = await admin.from("profiles").select("*").returns<Profile[]>();
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }

  const resultados: { user: string; ok: boolean; message: string; aviso?: string }[] = [];

  for (const profile of profiles ?? []) {
    const tz = profile.timezone || DEFAULT_TIMEZONE;
    const ctx: Ctx = {
      supabase: admin as unknown as Ctx["supabase"],
      userId: profile.id,
      profile,
      tz,
      today: todayInTz(tz),
    };

    let message = "Canvas no está configurado";
    let ok = true;

    if (canvasConfigured()) {
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

    // El aviso se manda después del sync, para que cuente los deadlines que
    // acaban de entrar. Que falle no debe tumbar la corrida.
    let aviso = "push no configurado";
    if (pushSendConfigured()) {
      try {
        aviso = await avisar(ctx, admin);
      } catch (e) {
        aviso = "falló el aviso: " + (e instanceof Error ? e.message : String(e));
      }
    }

    resultados.push({ user: profile.id, ok, message, aviso });
  }

  // Siempre 200: un fallo de Canvas no es un fallo del cron, y un 500 haría que
  // Vercel lo reintente sin motivo. El detalle va en el cuerpo y en `sync_state`.
  return NextResponse.json({ ok: true, perfiles: resultados.length, resultados });
}

/**
 * Manda el aviso del día, si hay algo que decir.
 *
 * Devuelve una línea legible para el cuerpo de la respuesta, que es lo que se
 * ve en el registro del cron de Vercel cuando algo no sale.
 */
async function avisar(ctx: Ctx, admin: ReturnType<typeof createAdminClient>): Promise<string> {
  const [tasks, events] = await Promise.all([
    loadTasks(ctx),
    loadEvents(ctx, ctx.today, ctx.today),
  ]);

  const digest = buildDigest(tasks, events, ctx.today);
  if (!digest) return "nada que avisar";

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", ctx.userId)
    .returns<PushSubscriptionRow[]>();

  if (!subs?.length) return "sin navegadores suscritos";

  const r = await sendDigest(subs, digest);

  // Las suscripciones muertas se borran: si no, fallan todos los días.
  if (r.caducadas.length) {
    await admin.from("push_subscriptions").delete().in("endpoint", r.caducadas);
  }

  return `${r.enviadas} enviado(s)` +
    (r.caducadas.length ? `, ${r.caducadas.length} caducada(s) borrada(s)` : "") +
    (r.fallidas ? `, ${r.fallidas} fallida(s)` : "");
}

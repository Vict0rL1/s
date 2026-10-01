import { NextResponse } from "next/server";
import { getApiCtx } from "@/lib/data";
import { logEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * `POST /api/push/subscription` — el service worker avisa que el navegador
 * cambió la suscripción (`pushsubscriptionchange`).
 *
 * Pasa sin que nadie toque nada: el navegador rota la suscripción y la vieja
 * empieza a responder 410. Sin esta ruta, los avisos dejaban de llegar hasta
 * que alguien volviera a activarlos a mano.
 *
 * Va con la sesión de las cookies (el service worker las manda porque es del
 * mismo origen). Si la sesión venció, la app lo arregla al abrirse
 * (`PushHeal`).
 */
export async function POST(request: Request) {
  // Sólo desde la propia app: otro sitio no puede registrar una suscripción
  // en tu cuenta aunque el navegador mandara las cookies.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.json({ ok: false, message: "Sin sesión" }, { status: 401 });

  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; oldEndpoint?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const { error } = await ctx.supabase.from("push_subscriptions").upsert(
    { endpoint, user_id: ctx.userId, p256dh: p256dh.slice(0, 200), auth: auth.slice(0, 100) },
    { onConflict: "endpoint" },
  );
  if (error) return NextResponse.json({ ok: false }, { status: 500 });

  if (typeof body.oldEndpoint === "string" && body.oldEndpoint !== endpoint) {
    await ctx.supabase.from("push_subscriptions").delete().eq("user_id", ctx.userId).eq("endpoint", body.oldEndpoint);
  }

  logEvent({ event: "push.resubscribe", result: "ok", userId: ctx.userId, integration: "push" });
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSync, syncCanvas } from "@/lib/canvas-sync";
import { CRON_SECRET, canvasConfigured } from "@/lib/env.server";
import { DEFAULT_TIMEZONE, todayInTz } from "@/lib/date";
import type { Ctx } from "@/lib/data";
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

  if (!canvasConfigured()) {
    return NextResponse.json({ ok: true, message: "Canvas no está configurado; nada que sincronizar" });
  }

  const admin = createAdminClient();
  const { data: profiles, error } = await admin.from("profiles").select("*").returns<Profile[]>();
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }

  const resultados: { user: string; ok: boolean; message: string }[] = [];

  for (const profile of profiles ?? []) {
    const tz = profile.timezone || DEFAULT_TIMEZONE;
    const ctx: Ctx = {
      supabase: admin as unknown as Ctx["supabase"],
      userId: profile.id,
      profile,
      tz,
      today: todayInTz(tz),
    };

    try {
      const r = await syncCanvas(ctx);
      await recordSync(ctx, { items: r.items });
      resultados.push({ user: profile.id, ok: true, message: r.message });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Falló el sync";
      await recordSync(ctx, { items: 0, error: message });
      resultados.push({ user: profile.id, ok: false, message });
    }
  }

  // Siempre 200: un fallo de Canvas no es un fallo del cron, y un 500 haría que
  // Vercel lo reintente sin motivo. El detalle va en el cuerpo y en `sync_state`.
  return NextResponse.json({ ok: true, perfiles: resultados.length, resultados });
}

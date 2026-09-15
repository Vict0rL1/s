import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCtx } from "@/lib/data";
import { recordSync, syncCanvas } from "@/lib/canvas-sync";
import { canvasConfigured } from "@/lib/env.server";

/**
 * `POST /api/sync/canvas` — trae los deadlines de Canvas.
 *
 * Tiene que vivir en el servidor por dos razones: el token nunca puede llegar
 * al navegador, y Canvas bloquea CORS de todos modos.
 *
 * Sólo lo puede disparar el dueño de la sesión. En la fase 4, el cron llamará
 * a `/api/sync` con `CRON_SECRET`, no a esta ruta.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ ok: false, message: "No hay sesión" }, { status: 401 });
  }

  if (!canvasConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Falta CANVAS_TOKEN. Sácalo de Canvas → Account → Settings → + New Access Token " +
          "y ponlo en .env.local y en las variables de Vercel.",
      },
      { status: 400 },
    );
  }

  const ctx = await getCtx();

  try {
    const result = await syncCanvas(ctx);
    await recordSync(ctx, { items: result.items });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Falló el sync de Canvas";
    await recordSync(ctx, { items: 0, error: message });
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}

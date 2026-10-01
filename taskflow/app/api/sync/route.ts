import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY } from "@/lib/env.server";
import { runClock } from "@/lib/clock";
import { errorCodeOf, logEvent, safeMessage } from "@/lib/log";
import type { DigestKind } from "@/lib/push";

export const dynamic = "force-dynamic";

/**
 * El tope de Vercel para esta función. Canvas tiene 15 s por petición y un
 * reintento, push y Telegram 10 s cada uno: 60 s da aire sin que una corrida
 * colgada se coma la siguiente.
 */
export const maxDuration = 60;

/**
 * `GET /api/sync` — el reloj de la app.
 *
 * Se llama **cada hora**, no una vez al día, porque Victor pidió dos avisos
 * (el resumen de la mañana y el de la noche anterior) y el cron gratis de
 * Vercel sólo permite uno. Quien dispara cada hora es
 * `.github/workflows/taskflow-clock.yml`; el cron de Vercel se queda como red
 * de seguridad para la mañana.
 *
 * Que se llame cada hora NO significa que haga todo cada hora. La petición
 * pregunta "¿qué toca ahora?" y casi siempre la respuesta es "nada". El qué
 * vive en `lib/clock.ts`; esta ruta sólo decide si quien llama es el reloj.
 *
 * Sin la comparación contra `CRON_SECRET`, cualquiera en internet podría
 * disparar tus syncs; de ahí el 401.
 */
export async function GET(request: Request) {
  if (!CRON_SECRET) {
    logEvent({ event: "cron.request", result: "error", integration: "cron", errorCode: "CRON_CONFIG_MISSING", message: "falta CRON_SECRET" });
    return NextResponse.json(
      { ok: false, code: "CRON_CONFIG_MISSING", message: "Falta CRON_SECRET: la ruta está deshabilitada" },
      { status: 503 },
    );
  }

  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`; el workflow de
  // GitHub manda lo mismo.
  if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${CRON_SECRET}`)) {
    logEvent({ event: "cron.request", result: "error", integration: "cron", errorCode: "CRON_AUTH_FAILED" });
    return NextResponse.json({ ok: false, code: "CRON_AUTH_FAILED", message: "No autorizado" }, { status: 401 });
  }

  // Sin la service role el reloj no puede leer a nadie. Antes esto reventaba
  // como un 500 sin explicación y el workflow decía "respuesta inesperada".
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    logEvent({ event: "cron.request", result: "error", integration: "cron", errorCode: "CRON_CONFIG_MISSING", message: "falta SUPABASE_SERVICE_ROLE_KEY" });
    return NextResponse.json(
      { ok: false, code: "CRON_CONFIG_MISSING", message: "Falta SUPABASE_SERVICE_ROLE_KEY en el servidor" },
      { status: 503 },
    );
  }

  // Dos escapes para probar a mano, que sólo funcionan con el secreto en la
  // mano: `?digest=night` manda ese aviso ya, saltándose la ventana Y el
  // registro (si no, sólo se podría probar una vez al día), y `?canvas=1`
  // fuerza el sync aunque acabe de correr.
  const { searchParams: params, origin } = new URL(request.url);

  try {
    const resultados = await runClock(createAdminClient(), {
      origin,
      digest: leerKind(params.get("digest")),
      forceCanvas: params.get("canvas") === "1",
    });
    // 200 aunque Canvas haya fallado: un fallo de Canvas no es un fallo del
    // reloj. El detalle va en el cuerpo, en `sync_state` y en Ajustes.
    return NextResponse.json({ ok: true, perfiles: resultados.length, resultados });
  } catch (e) {
    // Esto sí es un fallo del reloj (la base no contesta): un 500 hace que el
    // workflow de GitHub falle y GitHub avise por correo.
    const code = errorCodeOf(e) ?? "CRON_DB_FAILED";
    const message = safeMessage(e, "Falló el reloj");
    logEvent({ event: "cron.request", result: "error", integration: "cron", errorCode: code, message });
    return NextResponse.json({ ok: false, code, message }, { status: 500 });
  }
}

function leerKind(v: string | null): DigestKind | null {
  return v === "morning" || v === "night" ? v : null;
}

/** Comparación en tiempo constante, para no regalar el secreto carácter a carácter. */
function sameSecret(a: string, b: string): boolean {
  // Se comparan los hashes: así las dos entradas miden lo mismo y la longitud
  // del secreto tampoco se filtra.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

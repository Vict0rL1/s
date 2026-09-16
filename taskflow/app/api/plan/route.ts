import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getCtx, loadBlocks, loadEvents, loadTasks } from "@/lib/data";
import { plannerConfigured } from "@/lib/env.server";
import { minutesInTz } from "@/lib/date";
import { planDay } from "@/lib/planner";

export const dynamic = "force-dynamic";

/**
 * `POST /api/plan` — arma una propuesta de plan para hoy.
 *
 * **No escribe nada.** Devuelve los bloques propuestos para que el usuario los
 * mire y decida; quien escribe es la acción `applyPlan`, y sólo si acepta.
 *
 * Va como route handler y no como Server Action porque la key de la API tiene
 * que quedarse del lado del servidor y porque el cliente necesita el resultado
 * en la mano para pintarlo antes de guardar nada.
 */
export async function POST() {
  if (!plannerConfigured()) {
    return NextResponse.json(
      { ok: false, message: "El planificador no está configurado (falta ANTHROPIC_API_KEY)." },
      { status: 503 },
    );
  }

  // `getCtx` redirige al login si no hay sesión; el proxy ya deja pasar /api/*.
  const ctx = await getCtx();
  const [tasks, events, blocks] = await Promise.all([
    loadTasks(ctx),
    loadEvents(ctx, ctx.today, ctx.today),
    loadBlocks(ctx, ctx.today, ctx.today),
  ]);

  try {
    const plan = await planDay({
      profile: ctx.profile,
      today: ctx.today,
      now: minutesInTz(ctx.tz),
      tasks,
      events,
      blocks,
    });
    return NextResponse.json({ ok: true, ...plan });
  } catch (e) {
    return NextResponse.json({ ok: false, message: readableError(e) }, { status: 200 });
  }
}

/**
 * Los errores de la API traen jerga y a veces el nombre del modelo. Al usuario
 * le sirve saber qué hacer, no qué clase de excepción fue.
 */
function readableError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return "La ANTHROPIC_API_KEY no es válida. Revísala en console.anthropic.com.";
  }
  if (e instanceof Anthropic.RateLimitError) {
    return "Demasiadas peticiones seguidas. Espera un momento y vuelve a intentar.";
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return "No se pudo hablar con la API. Revisa tu conexión.";
  }
  if (e instanceof Anthropic.APIError) {
    return e.status === 400
      ? "La API rechazó la petición. Si acabas de cambiar PLANNER_MODEL, revisa el nombre."
      : `La API respondió con un error (${e.status}).`;
  }
  return e instanceof Error ? e.message : "No se pudo armar el plan.";
}

import { NextResponse } from "next/server";
import { getApiCtx, loadBlocks, loadEvents, loadTasks } from "@/lib/data";
import { plannerConfigured } from "@/lib/env.server";
import { minutesInTz } from "@/lib/date";
import { planDay } from "@/lib/planner";
import { recordAiCall } from "@/lib/ai-record";

export const dynamic = "force-dynamic";
/** Una llamada a Claude de hasta 50 s, más el resto. */
export const maxDuration = 60;

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
      { ok: false, code: "ANTHROPIC_NOT_CONFIGURED", message: "El planificador no está configurado (falta ANTHROPIC_API_KEY)." },
      { status: 503 },
    );
  }

  const ctx = await getApiCtx();
  if (!ctx) {
    return NextResponse.json({ ok: false, message: "Tu sesión venció. Recarga la página." }, { status: 401 });
  }

  const [tasks, events, blocks] = await Promise.all([
    loadTasks(ctx),
    loadEvents(ctx, ctx.today, ctx.today),
    loadBlocks(ctx, ctx.today, ctx.today),
  ]);

  const started = Date.now();
  try {
    const plan = await planDay({
      profile: ctx.profile,
      today: ctx.today,
      now: minutesInTz(ctx.tz),
      tasks,
      events,
      blocks,
    });
    const n = plan.blocks.length;
    await recordAiCall(ctx, "plan", {
      ok: true, costUsd: plan.costUsd, ms: Date.now() - started,
      summary: `Claude propuso un plan de ${n} bloque${n > 1 ? "s" : ""} para hoy`,
    });
    return NextResponse.json({ ok: true, day: ctx.today, ...plan });
  } catch (e) {
    const info = await recordAiCall(ctx, "plan", { ok: false, error: e, ms: Date.now() - started });
    return NextResponse.json({ ok: false, code: info.code, message: info.message }, { status: 200 });
  }
}

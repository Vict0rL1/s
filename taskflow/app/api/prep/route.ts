import { NextResponse } from "next/server";
import { q } from "@/lib/activity";
import { recordAiCall } from "@/lib/ai-record";
import { aiErrorInfo } from "@/lib/ai";
import { getApiCtx, loadTasks } from "@/lib/data";
import { plannerConfigured } from "@/lib/env.server";
import { canPrep, prepProposal } from "@/lib/plan-tools";
import { nameSessions } from "@/lib/prep-ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * `POST /api/prep` — propone un plan de preparación para un examen o entrega.
 *
 * **No escribe nada.** Las sesiones las coloca `lib/schedule.ts` en tus
 * huecos reales; si pides ayuda a Claude, Claude sólo les pone nombre. Quien
 * escribe es `applyPrepPlan`, y sólo si aceptas.
 */
export async function POST(request: Request) {
  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.json({ ok: false, message: "Tu sesión venció. Recarga la página." }, { status: 401 });

  let body: { taskId?: unknown; totalMin?: unknown; sessionMin?: unknown; ai?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Petición mal formada" }, { status: 400 });
  }

  const task = (await loadTasks(ctx)).find((t) => t.id === String(body.taskId ?? ""));
  if (!task) return NextResponse.json({ ok: false, message: "Esa tarea ya no existe" }, { status: 404 });
  if (!canPrep(task, ctx.today)) {
    return NextResponse.json({
      ok: false,
      message: "El plan de preparación es para midterms, finales, proyectos y presentaciones con fecha futura.",
    }, { status: 400 });
  }

  const totalMin = Math.min(3000, Math.max(30, Math.round(Number(body.totalMin) || 0)));
  const sessionMin = Math.min(120, Math.max(30, Math.round(Number(body.sessionMin) || 60)));

  const plan = await prepProposal(ctx, task, { totalMin, sessionMin });

  let costUsd = 0;
  let aiNote = "";
  if (body.ai === true && plannerConfigured() && plan.sessions.length) {
    const started = Date.now();
    try {
      const r = await nameSessions(task, plan.sessions, plan.sessions.map((s) => s.title));
      plan.sessions = plan.sessions.map((s, i) => ({ ...s, title: r.titles[i] }));
      costUsd = r.costUsd;
      await recordAiCall(ctx, "prep", {
        ok: true, costUsd, ms: Date.now() - started, taskId: task.id,
        summary: `Claude nombró ${plan.sessions.length} sesiones de preparación para ${q(task.title)}`,
      });
    } catch (e) {
      // Sin Claude el plan sigue sirviendo: con los nombres de siempre.
      await recordAiCall(ctx, "prep", { ok: false, error: e, ms: Date.now() - started, taskId: task.id });
      aiNote = aiErrorInfo(e).message + " Las sesiones quedan con nombres genéricos.";
    }
  }

  return NextResponse.json({ ok: true, day: ctx.today, ...plan, costUsd, aiNote });
}

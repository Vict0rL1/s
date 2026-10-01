import { NextResponse } from "next/server";
import { getApiCtx, loadTasks } from "@/lib/data";
import { plannerConfigured } from "@/lib/env.server";
import { breakDown } from "@/lib/breakdown";
import { recordAiCall } from "@/lib/ai-record";
import { q } from "@/lib/activity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * `POST /api/breakdown` — propone los pasos de una tarea grande.
 *
 * **No escribe nada**, igual que `/api/plan`. Quien escribe es `applyBreakdown`,
 * y sólo si el usuario acepta.
 */
export async function POST(request: Request) {
  if (!plannerConfigured()) {
    return NextResponse.json(
      { ok: false, code: "ANTHROPIC_NOT_CONFIGURED", message: "Falta ANTHROPIC_API_KEY." },
      { status: 503 },
    );
  }

  const ctx = await getApiCtx();
  if (!ctx) {
    return NextResponse.json({ ok: false, message: "Tu sesión venció. Recarga la página." }, { status: 401 });
  }

  let taskId = "";
  try {
    taskId = String(((await request.json()) as { taskId?: unknown }).taskId ?? "");
  } catch {
    return NextResponse.json({ ok: false, message: "Petición mal formada" }, { status: 400 });
  }

  // La tarea se busca entre las del usuario, no por id suelto: así la RLS y
  // esta comprobación dicen lo mismo, y un id ajeno no llega al modelo.
  const task = (await loadTasks(ctx)).find((t) => t.id === taskId);
  if (!task) {
    return NextResponse.json({ ok: false, message: "Esa tarea ya no existe" }, { status: 404 });
  }

  const started = Date.now();
  try {
    const r = await breakDown(task, ctx.today);
    await recordAiCall(ctx, "breakdown", {
      ok: true, costUsd: r.costUsd, ms: Date.now() - started, taskId: task.id,
      summary: `Claude propuso ${r.steps.length} paso${r.steps.length > 1 ? "s" : ""} para ${q(task.title)}`,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const info = await recordAiCall(ctx, "breakdown", { ok: false, error: e, ms: Date.now() - started, taskId: task.id });
    return NextResponse.json({ ok: false, code: info.code, message: info.message }, { status: 200 });
  }
}

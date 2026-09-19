import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getCtx, loadTasks } from "@/lib/data";
import { plannerConfigured } from "@/lib/env.server";
import { breakDown } from "@/lib/breakdown";

export const dynamic = "force-dynamic";

/**
 * `POST /api/breakdown` — propone los pasos de una tarea grande.
 *
 * **No escribe nada**, igual que `/api/plan`. Quien escribe es `applyBreakdown`,
 * y sólo si el usuario acepta.
 */
export async function POST(request: Request) {
  if (!plannerConfigured()) {
    return NextResponse.json(
      { ok: false, message: "Falta ANTHROPIC_API_KEY." },
      { status: 503 },
    );
  }

  const ctx = await getCtx();

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

  try {
    const r = await breakDown(task, ctx.today);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, message: readableError(e) }, { status: 200 });
  }
}

function readableError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "La ANTHROPIC_API_KEY no es válida.";
  if (e instanceof Anthropic.RateLimitError) return "Demasiadas peticiones. Espera un momento.";
  if (e instanceof Anthropic.APIConnectionError) return "No se pudo hablar con la API.";
  if (e instanceof Anthropic.APIError) return `La API respondió con un error (${e.status}).`;
  return e instanceof Error ? e.message : "No se pudieron armar los pasos.";
}

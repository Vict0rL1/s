import { NextResponse } from "next/server";
import { getApiCtx, loadTasks } from "@/lib/data";
import { replanProposal } from "@/lib/plan-tools";
import type { ReplanScope } from "@/lib/schedule";

export const dynamic = "force-dynamic";

const SCOPES: ReplanScope[] = ["today", "tomorrow", "week", "date", "auto"];

/**
 * `POST /api/replan` — busca un hueco para trabajar en una tarea. Sin Claude:
 * es una búsqueda en tu agenda. **No escribe nada**; quien escribe es
 * `applyReplan`, y sólo si aceptas.
 */
export async function POST(request: Request) {
  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.json({ ok: false, message: "Tu sesión venció. Recarga la página." }, { status: 401 });

  let body: { taskId?: unknown; scope?: unknown; date?: unknown; minutes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Petición mal formada" }, { status: 400 });
  }

  const scope = SCOPES.includes(body.scope as ReplanScope) ? (body.scope as ReplanScope) : null;
  if (!scope) return NextResponse.json({ ok: false, message: "Opción desconocida" }, { status: 400 });

  const task = (await loadTasks(ctx)).find((t) => t.id === String(body.taskId ?? ""));
  if (!task) return NextResponse.json({ ok: false, message: "Esa tarea ya no existe" }, { status: 404 });

  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
  const minutes = Math.min(240, Math.max(15, Math.round((Number(body.minutes) || 60) / 15) * 15));

  const r = await replanProposal(ctx, task, { scope, date, minutes });
  return NextResponse.json({ ok: true, day: ctx.today, minutes, ...r, canMoveDate: task.source === "manual" });
}

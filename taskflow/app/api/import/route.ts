import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { BackupError, applyImport, parseBackup, planImport } from "@/lib/backup";
import { getApiCtx } from "@/lib/data";
import { logEvent } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Un respaldo de un año entero pesa unos cientos de KB; esto deja aire. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * `POST /api/import` — importar un respaldo, en dos pasos.
 *
 *  - `mode: "preview"`: valida y cuenta qué es nuevo, qué está repetido y qué
 *    no se puede leer. **No escribe nada.**
 *  - `mode: "apply"`: lo mismo, y agrega lo nuevo. Nunca cambia ni borra lo
 *    que ya tienes. Importar dos veces el mismo archivo no duplica nada.
 *
 * Va como ruta y no como Server Action porque éstas tienen un tope de 1 MB.
 */
export async function POST(request: Request) {
  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.json({ ok: false, message: "Tu sesión venció. Recarga la página." }, { status: 401 });

  const largo = Number(request.headers.get("content-length") ?? 0);
  if (largo > MAX_BYTES) return NextResponse.json({ ok: false, message: "El archivo es demasiado grande (máximo 4 MB)." }, { status: 413 });

  let body: { mode?: unknown; backup?: unknown };
  try {
    const texto = await request.text();
    if (texto.length > MAX_BYTES) throw new BackupError("El archivo es demasiado grande (máximo 4 MB).");
    body = JSON.parse(texto);
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof BackupError ? e.message : "Eso no es un JSON válido." }, { status: 400 });
  }

  try {
    const plan = await planImport(ctx, parseBackup(body.backup));
    if (body.mode !== "apply") return NextResponse.json({ ok: true, applied: false, summary: plan.summary });

    const summary = await applyImport(ctx, plan);
    const s = summary;
    const nuevas = s.tasks.new + s.notes.new + s.habits.new + s.events.new + s.blocks.new + s.habit_log.new;
    await logActivity(ctx, {
      actor: "user", kind: "backup.imported",
      summary: nuevas
        ? `Importaste un respaldo: ${s.tasks.new} tareas, ${s.notes.new} notas, ${s.habits.new} rutinas y ${s.events.new} eventos nuevos`
        : "Importaste un respaldo: todo lo que traía ya lo tenías",
      meta: { tasks: s.tasks.new, notes: s.notes.new, habits: s.habits.new, events: s.events.new, blocks: s.blocks.new },
    });
    logEvent({ event: "backup.import", result: "ok", userId: ctx.userId, integration: "app", rows: nuevas });
    revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, applied: true, summary });
  } catch (e) {
    const message = e instanceof BackupError ? e.message : "No se pudo importar el respaldo.";
    logEvent({ event: "backup.import", result: "error", userId: ctx.userId, integration: "app", message });
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }
}

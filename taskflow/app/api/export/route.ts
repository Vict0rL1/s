import { NextResponse } from "next/server";
import { BackupError, buildExport } from "@/lib/backup";
import { NOTE_COLS, TASK_COLS, getApiCtx } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * `GET /api/export` — baja todos tus datos como un JSON (`schemaVersion: 2`).
 *
 * Los datos ya viven en tu propio proyecto de Supabase, así que esto no es un
 * respaldo contra perderlos: es para tener una copia a mano, mirarla, o
 * llevártela si algún día cambias de base. Vuelve a entrar con "Importar
 * respaldo".
 *
 * Va por la sesión y la RLS, así que sólo salen tus filas.
 */
export async function GET() {
  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.json({ ok: false, message: "No hay sesión" }, { status: 401 });

  let salida;
  try {
    salida = await buildExport(ctx, { tasks: TASK_COLS, notes: NOTE_COLS });
  } catch (e) {
    const message = e instanceof BackupError ? e.message : "No se pudo armar el respaldo";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }

  const nombre = `taskflow-${ctx.today}.json`;
  return new NextResponse(JSON.stringify(salida, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${nombre}"`,
      "cache-control": "no-store",
    },
  });
}

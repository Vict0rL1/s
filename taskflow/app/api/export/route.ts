import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCtx } from "@/lib/data";

/** Las tablas que son tuyas. `profiles` va aparte porque su clave es `id`. */
const TABLAS = ["tasks", "events", "notes", "habits", "habit_log", "blocks", "sync_state"] as const;

/**
 * `GET /api/export` — baja todos tus datos como un JSON.
 *
 * Los datos ya viven en tu propio proyecto de Supabase, así que esto no es un
 * respaldo contra perderlos: es para tener una copia a mano, mirarla, o
 * llevártela si algún día cambias de base.
 *
 * Va por la sesión y la RLS, así que sólo salen tus filas.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ ok: false, message: "No hay sesión" }, { status: 401 });
  }

  const ctx = await getCtx();

  const salida: Record<string, unknown> = {
    exportado_en: new Date().toISOString(),
    zona_horaria: ctx.tz,
    perfil: ctx.profile,
  };

  for (const tabla of TABLAS) {
    const { data, error } = await ctx.supabase.from(tabla).select("*");
    if (error) {
      return NextResponse.json(
        { ok: false, message: `No se pudo leer ${tabla}: ${error.message}` },
        { status: 500 },
      );
    }
    salida[tabla] = data ?? [];
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

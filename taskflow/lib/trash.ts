import "server-only";

import type { Ctx } from "./data";
import { addDays } from "./date";

/**
 * La papelera: tareas y notas borradas, recuperables durante 30 días.
 *
 * Una tarea borrada no desaparece: tiene `deleted_at`. Así se puede restaurar
 * y, sobre todo, el sync de Canvas ve que la fila existe y no la vuelve a
 * crear. Por lo mismo, "eliminar para siempre" una tarea de Canvas la deja
 * como lápida (`purged_at`) en vez de borrarla.
 */

export const TRASH_DAYS = 30;

export type TrashTask = {
  id: string;
  title: string;
  source: string;
  course: string | null;
  due_date: string | null;
  deleted_at: string;
};
export type TrashNote = { id: string; body: string; deleted_at: string };

export async function loadTrash(ctx: Pick<Ctx, "supabase" | "userId">): Promise<{ tasks: TrashTask[]; notes: TrashNote[] }> {
  const [tasks, notes] = await Promise.all([
    ctx.supabase
      .from("tasks")
      .select("id, title, source, course, due_date, deleted_at")
      .eq("user_id", ctx.userId)
      .not("deleted_at", "is", null)
      .is("purged_at", null)
      .order("deleted_at", { ascending: false })
      .limit(300)
      .returns<TrashTask[]>(),
    ctx.supabase
      .from("notes")
      .select("id, body, deleted_at")
      .eq("user_id", ctx.userId)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(300)
      .returns<TrashNote[]>(),
  ]);
  return { tasks: tasks.data ?? [], notes: notes.data ?? [] };
}

/**
 * Elimina para siempre esas tareas (que ya estaban en la papelera). Las
 * manuales se borran; las de una fuente externa quedan como lápida, para que
 * el sync no las recree. Devuelve cuántas.
 */
export async function purgeTasks(ctx: Pick<Ctx, "supabase" | "userId">, ids: string[] | "all"): Promise<number> {
  if (ids !== "all" && !ids.length) return 0;

  let borrar = ctx.supabase.from("tasks").delete()
    .eq("user_id", ctx.userId).eq("source", "manual").not("deleted_at", "is", null).is("purged_at", null);
  let lapida = ctx.supabase.from("tasks").update({ purged_at: new Date().toISOString(), focus_day: null })
    .eq("user_id", ctx.userId).neq("source", "manual").not("deleted_at", "is", null).is("purged_at", null);
  if (ids !== "all") {
    borrar = borrar.in("id", ids);
    lapida = lapida.in("id", ids);
  }

  const [b, l] = await Promise.all([borrar.select("id"), lapida.select("id")]);
  return (b.data?.length ?? 0) + (l.data?.length ?? 0);
}

export async function purgeNotes(ctx: Pick<Ctx, "supabase" | "userId">, ids: string[] | "all"): Promise<number> {
  if (ids !== "all" && !ids.length) return 0;
  let q = ctx.supabase.from("notes").delete().eq("user_id", ctx.userId).not("deleted_at", "is", null);
  if (ids !== "all") q = q.in("id", ids);
  const { data } = await q.select("id");
  return data?.length ?? 0;
}

/**
 * La limpieza automática, que corre el reloj: lo que lleva más de 30 días en
 * la papelera se va. Y las lápidas de Canvas se borran de verdad cuando su
 * fecha quedó bien atrás de lo que se le pide a Canvas (14 días): para
 * entonces Canvas ya no las devuelve y no hay nada que recrear.
 */
export async function autoEmptyTrash(
  ctx: Pick<Ctx, "supabase" | "userId">,
  now: Date,
  today: string,
): Promise<{ tasks: number; notes: number; tombstones: number }> {
  const corte = new Date(now.getTime() - TRASH_DAYS * 86400_000).toISOString();

  const viejasManual = await ctx.supabase
    .from("tasks").delete().eq("user_id", ctx.userId).eq("source", "manual")
    .not("deleted_at", "is", null).lt("deleted_at", corte).select("id");
  const viejasExternas = await ctx.supabase
    .from("tasks").update({ purged_at: now.toISOString(), focus_day: null }).eq("user_id", ctx.userId).neq("source", "manual")
    .not("deleted_at", "is", null).lt("deleted_at", corte).is("purged_at", null).select("id");
  const notas = await ctx.supabase
    .from("notes").delete().eq("user_id", ctx.userId)
    .not("deleted_at", "is", null).lt("deleted_at", corte).select("id");
  const lapidas = await ctx.supabase
    .from("tasks").delete().eq("user_id", ctx.userId)
    .not("purged_at", "is", null).lt("due_date", addDays(today, -TRASH_DAYS)).select("id");

  return {
    tasks: (viejasManual.data?.length ?? 0) + (viejasExternas.data?.length ?? 0),
    notes: notas.data?.length ?? 0,
    tombstones: lapidas.data?.length ?? 0,
  };
}

import "server-only";

import type { Ctx } from "./data";
import { likeSafe, toTsQuery } from "./search-query";

export type SearchResults = {
  tasks: { id: string; title: string; due_date: string | null; course: string | null; done: boolean }[];
  notes: { id: string; excerpt: string }[];
  courses: string[];
  habits: { id: string; name: string }[];
};

const VACIO: SearchResults = { tasks: [], notes: [], courses: [], habits: [] };

/**
 * Busca en tus tareas, notas, cursos y rutinas. Con tu sesión: la RLS sólo
 * deja ver lo tuyo, y además cada consulta filtra por `user_id`.
 */
export async function search(ctx: Ctx, q: string): Promise<SearchResults> {
  const ts = toTsQuery(q);
  const like = likeSafe(q);
  if (!ts || like.length < 2) return VACIO;

  const [tasks, notes, courses, habits] = await Promise.all([
    ctx.supabase
      .from("tasks")
      .select("id, title, due_date, course, done")
      .eq("user_id", ctx.userId)
      .is("deleted_at", null)
      .textSearch("search", ts, { config: "simple" })
      .order("done", { ascending: true })
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(8)
      .returns<SearchResults["tasks"]>(),
    ctx.supabase
      .from("notes")
      .select("id, body")
      .eq("user_id", ctx.userId)
      .is("deleted_at", null)
      .textSearch("search", ts, { config: "simple" })
      .order("created_at", { ascending: false })
      .limit(5)
      .returns<{ id: string; body: string }[]>(),
    ctx.supabase
      .from("tasks")
      .select("course")
      .eq("user_id", ctx.userId)
      .is("deleted_at", null)
      .ilike("course", `%${like}%`)
      .limit(50)
      .returns<{ course: string | null }[]>(),
    ctx.supabase
      .from("habits")
      .select("id, name")
      .eq("user_id", ctx.userId)
      .eq("archived", false)
      .ilike("name", `%${like}%`)
      .limit(5)
      .returns<SearchResults["habits"]>(),
  ]);

  return {
    tasks: tasks.data ?? [],
    notes: (notes.data ?? []).map((n) => ({ id: n.id, excerpt: n.body.replace(/\s+/g, " ").slice(0, 90) })),
    courses: [...new Set((courses.data ?? []).map((c) => c.course).filter((c): c is string => Boolean(c)))].sort().slice(0, 5),
    habits: habits.data ?? [],
  };
}

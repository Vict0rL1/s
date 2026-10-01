import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getApiCtx: async () => state.ctx,
}));

import { POST as importRoute } from "@/app/api/import/route";
import { BackupError, SCHEMA_VERSION, applyImport, buildExport, parseBackup, planImport } from "@/lib/backup";
import { NOTE_COLS, TASK_COLS } from "@/lib/data";
import { ctxFor, fakeProject } from "./helpers/supa";

const A = "a@ejemplo.com", B = "b@ejemplo.com";
let p: Awaited<ReturnType<typeof fakeProject>>;
let a: string, b: string;

beforeEach(async () => {
  p = await fakeProject([A, B]);
  a = p.id(A);
  b = p.id(B);
});

const cols = { tasks: TASK_COLS, notes: NOTE_COLS };

async function seedA() {
  const { data: t } = await p.as(A).from("tasks").insert([
    { user_id: a, title: "Midterm 1", due_date: "2026-10-13", kind: "midterm", weight_pct: 25, course: "ECON 342", source: "manual", external_id: null },
    { user_id: a, title: "PS4", due_date: "2026-10-03", kind: null, weight_pct: null, course: null, source: "canvas", external_id: "canvas:assignment:4" },
  ]).select("id, title");
  const { data: h } = await p.as(A).from("habits").insert({ user_id: a, name: "Correr" }).select("id").single();
  await p.as(A).from("habit_log").insert({ habit_id: h!.id, user_id: a, day: "2026-09-30" });
  await p.as(A).from("notes").insert({ user_id: a, body: "Idea" });
  const mid = t!.find((x) => x.title === "Midterm 1")!.id;
  await p.as(A).from("blocks").insert({ user_id: a, day: "2026-10-05", start_min: 600, end_min: 660, title: "Estudiar", task_id: mid });
  await p.as(A).from("events").insert({
    user_id: a, title: "ECON 342", source: "ics", external_id: "x1", starts_at: "2026-10-05T17:00:00Z", ends_at: null, all_day_date: null,
  });
}

const counts = async (uid: string) => {
  const n = async (t: string) => (await p.admin.from(t).select("*", { count: "exact", head: true }).eq("user_id", uid)).count;
  return { tasks: await n("tasks"), notes: await n("notes"), habits: await n("habits"), habit_log: await n("habit_log"), blocks: await n("blocks"), events: await n("events") };
};

describe("respaldo", () => {
  it("exporta en v2 sin lápidas ni columnas de búsqueda", async () => {
    await seedA();
    await p.as(A).from("tasks").insert({ user_id: a, title: "lápida", source: "canvas", external_id: "canvas:x", deleted_at: "2026-09-01T00:00:00Z", purged_at: "2026-09-02T00:00:00Z" });
    const out = await buildExport(ctxFor(p.as(A), a), cols);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks.map((t) => t.title).sort()).toEqual(["Midterm 1", "PS4"]);
    expect(tasks[0]).not.toHaveProperty("search");
  });

  it("ida y vuelta a otra cuenta: entra todo, con las referencias reconectadas", async () => {
    await seedA();
    const respaldo = JSON.parse(JSON.stringify(await buildExport(ctxFor(p.as(A), a), cols)));
    const ctxB = ctxFor(p.as(B), b);
    const plan = await planImport(ctxB, parseBackup(respaldo));
    expect(plan.summary.tasks).toMatchObject({ total: 2, new: 2, duplicates: 0 });
    await applyImport(ctxB, plan);

    expect(await counts(b)).toEqual({ tasks: 2, notes: 1, habits: 1, habit_log: 1, blocks: 1, events: 1 });
    // El bloque apunta a la tarea NUEVA de B, no a la de A.
    const { data: bl } = await p.admin.from("blocks").select("task_id").eq("user_id", b).single();
    const { data: mid } = await p.admin.from("tasks").select("id, weight_pct, kind").eq("user_id", b).eq("title", "Midterm 1").single();
    expect(bl!.task_id).toBe(mid!.id);
    expect(mid).toMatchObject({ weight_pct: 25, kind: "midterm" });
    // Y lo de A sigue intacto.
    expect(await counts(a)).toEqual({ tasks: 2, notes: 1, habits: 1, habit_log: 1, blocks: 1, events: 1 });
  });

  it("importar dos veces el mismo respaldo no duplica nada", async () => {
    await seedA();
    const respaldo = JSON.parse(JSON.stringify(await buildExport(ctxFor(p.as(A), a), cols)));
    const ctxA = ctxFor(p.as(A), a);
    const plan = await planImport(ctxA, parseBackup(respaldo));
    expect(Object.values(plan.summary).filter((v) => typeof v === "object" && v && "new" in v).every((v) => (v as { new: number }).new === 0)).toBe(true);
    await applyImport(ctxA, plan);
    expect(await counts(a)).toEqual({ tasks: 2, notes: 1, habits: 1, habit_log: 1, blocks: 1, events: 1 });
  });

  it("nunca cambia lo que ya tienes, aunque el respaldo traiga otra versión", async () => {
    await seedA();
    const respaldo = JSON.parse(JSON.stringify(await buildExport(ctxFor(p.as(A), a), cols)));
    for (const t of respaldo.tasks) t.done = true;
    await p.as(A).from("tasks").update({ title: "Midterm 1 (sala B)" }).eq("title", "Midterm 1");
    const ctxA = ctxFor(p.as(A), a);
    await applyImport(ctxA, await planImport(ctxA, parseBackup(respaldo)));
    const { data } = await p.admin.from("tasks").select("title, done").eq("user_id", a).order("title");
    expect(data).toEqual([{ title: "Midterm 1 (sala B)", done: false }, { title: "PS4", done: false }]);
  });

  it("un respaldo viejo (sin schemaVersion ni columnas nuevas) entra igual", async () => {
    const viejo = {
      exportado_en: "2026-09-20T00:00:00Z",
      tasks: [{ id: "11111111-1111-4111-8111-111111111111", title: "Tarea vieja", due_date: "2026-09-25", priority: 2, done: false, source: "manual" }],
      notes: [{ body: "nota vieja", pinned: true }],
      habits: [], habit_log: [], events: [], blocks: [], sync_state: [{ source: "canvas" }],
    };
    const ctxB = ctxFor(p.as(B), b);
    const plan = await planImport(ctxB, parseBackup(viejo));
    expect(plan.summary.version).toBe(1);
    await applyImport(ctxB, plan);
    const { data } = await p.admin.from("tasks").select("title, kind, tracked_sec").eq("user_id", b);
    expect(data).toEqual([{ title: "Tarea vieja", kind: null, tracked_sec: 0 }]);
  });

  it("una fila mala se cuenta y se salta; una versión más nueva se rechaza", async () => {
    const r = parseBackup({ schemaVersion: 2, tasks: [{ title: "ok" }, { title: "" }, { due_date: "mañana" }, "basura"] });
    expect(r.tasks.ok).toHaveLength(1);
    expect(r.tasks.invalid).toBe(3);
    expect(() => parseBackup({ schemaVersion: 3, tasks: [] })).toThrow(BackupError);
    expect(() => parseBackup({ hola: 1 })).toThrow(/no trae ninguna tabla/);
    expect(() => parseBackup([])).toThrow(BackupError);
  });

  it("la ruta: la vista previa no escribe nada; aplicar sí, y lo anota", async () => {
    state.ctx = ctxFor(p.as(B), b);
    const backup = { schemaVersion: 2, tasks: [{ title: "Nueva" }], notes: [] };
    const req = (mode: string) => new Request("https://x/api/import", { method: "POST", body: JSON.stringify({ mode, backup }) });

    const prev = await (await importRoute(req("preview"))).json();
    expect(prev).toMatchObject({ ok: true, applied: false, summary: { tasks: { new: 1 } } });
    expect((await counts(b)).tasks).toBe(0);

    const ap = await (await importRoute(req("apply"))).json();
    expect(ap.applied).toBe(true);
    expect((await counts(b)).tasks).toBe(1);
    const { data: log } = await p.admin.from("activity_log").select("kind").eq("user_id", b);
    expect(log).toEqual([{ kind: "backup.imported" }]);
  });

  it("la ruta: sin sesión 401; JSON roto 400", async () => {
    state.ctx = null;
    expect((await importRoute(new Request("https://x", { method: "POST", body: "{}" }))).status).toBe(401);
    state.ctx = ctxFor(p.as(B), b);
    expect((await importRoute(new Request("https://x", { method: "POST", body: "{no" }))).status).toBe(400);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CANVAS_BASE_URL = "https://canvas.prueba/api/v1";
  process.env.CANVAS_TOKEN = "7~token-de-prueba-de-canvas-123456";
});

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
}));

import { deleteNote, deleteTask, emptyTrash, purgeTrashItem, restoreTask } from "@/app/actions";
import { syncCanvas } from "@/lib/canvas-sync";
import { autoEmptyTrash, loadTrash } from "@/lib/trash";
import type { CanvasPlannerItem } from "@/lib/canvas";
import { ctxFor, fakeProject } from "./helpers/supa";

const A = "a@ejemplo.com", B = "b@ejemplo.com";
let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;
let items: CanvasPlannerItem[];

beforeEach(async () => {
  p = await fakeProject([A, B]);
  uid = p.id(A);
  state.ctx = ctxFor(p.as(A), uid, "2026-10-01");
  items = [{
    course_id: "1", plannable_id: "7", plannable_type: "assignment", plannable_date: "2026-10-20T06:59:00Z",
    plannable: { title: "Problem Set 6" }, submissions: { submitted: false },
  }];
  vi.stubGlobal("fetch", vi.fn(async (u: string) =>
    new URL(String(u)).pathname.endsWith("/planner/items") ? Response.json(items) : Response.json([])));
});
afterEach(() => vi.unstubAllGlobals());

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const sync = () => syncCanvas(ctxFor(p.admin, uid, "2026-10-01"));
const canvasRow = async () =>
  (await p.admin.from("tasks").select("id, deleted_at, purged_at, user_edited_at").eq("user_id", uid).eq("source", "canvas")).data ?? [];

describe("papelera", () => {
  it("borrar manda a la papelera y restaurar la saca", async () => {
    const { data } = await p.as(A).from("tasks").insert({ user_id: uid, title: "Leer cap 4" }).select("id").single();
    await deleteTask(fd({ id: data!.id }));
    expect((await loadTrash(state.ctx as never)).tasks.map((t) => t.title)).toEqual(["Leer cap 4"]);
    await restoreTask(fd({ id: data!.id }));
    expect((await loadTrash(state.ctx as never)).tasks).toEqual([]);
  });

  it("eliminar para siempre: una manual se borra de verdad", async () => {
    const { data } = await p.as(A).from("tasks").insert({ user_id: uid, title: "x" }).select("id").single();
    await deleteTask(fd({ id: data!.id }));
    await purgeTrashItem(fd({ id: data!.id, type: "task" }));
    expect((await p.admin.from("tasks").select("id").eq("id", data!.id)).data).toEqual([]);
  });

  it("una de Canvas eliminada para siempre queda como lápida y Canvas no la recrea", async () => {
    await sync();
    const [t] = await canvasRow();
    await deleteTask(fd({ id: t.id }));
    await purgeTrashItem(fd({ id: t.id, type: "task" }));

    expect((await loadTrash(state.ctx as never)).tasks).toEqual([]); // ni en la papelera
    await sync();
    await sync();
    const rows = await canvasRow();
    expect(rows).toHaveLength(1); // la lápida, nada nuevo
    expect(rows[0].purged_at).not.toBeNull();
  });

  it("restaurar una de Canvas que ya no está en Canvas: es tuya, el sync no la vuelve a quitar", async () => {
    await sync();
    const [t] = await canvasRow();
    // El profesor la borró (y queda otra, para que la respuesta no venga vacía).
    items = [{
      course_id: "1", plannable_id: "8", plannable_type: "assignment",
      plannable_date: "2026-10-22T06:59:00Z", plannable: { title: "otra" }, submissions: { submitted: false },
    }];
    await sync();
    expect((await canvasRow()).find((r) => r.id === t.id)!.deleted_at).not.toBeNull(); // se fue a la papelera

    await restoreTask(fd({ id: t.id }));
    await sync();
    const r = (await canvasRow()).find((x) => x.id === t.id)!;
    expect(r.deleted_at).toBeNull();
    expect(r.user_edited_at).not.toBeNull();
  });

  it("a los 30 días se vacía sola, y las lápidas se van cuando su fecha queda atrás", async () => {
    const { data } = await p.as(A).from("tasks").insert([
      { user_id: uid, title: "vieja", source: "manual", external_id: null, deleted_at: "2026-08-15T00:00:00Z", purged_at: null, due_date: null },
      { user_id: uid, title: "reciente", source: "manual", external_id: null, deleted_at: "2026-09-25T00:00:00Z", purged_at: null, due_date: null },
      { user_id: uid, title: "lápida vieja", source: "canvas", external_id: "canvas:a:1", deleted_at: "2026-07-01T00:00:00Z", purged_at: "2026-07-02T00:00:00Z", due_date: "2026-07-10" },
      { user_id: uid, title: "lápida vigente", source: "canvas", external_id: "canvas:a:2", deleted_at: "2026-09-01T00:00:00Z", purged_at: "2026-09-02T00:00:00Z", due_date: "2026-10-20" },
      { user_id: uid, title: "canvas en papelera vieja", source: "canvas", external_id: "canvas:a:3", deleted_at: "2026-08-01T00:00:00Z", purged_at: null, due_date: "2026-12-01" },
    ]).select("title");
    expect(data).toHaveLength(5);
    await p.as(A).from("notes").insert({ user_id: uid, body: "nota vieja", deleted_at: "2026-08-01T00:00:00Z" });

    const r = await autoEmptyTrash(ctxFor(p.admin, uid), new Date("2026-10-01T12:00:00Z"), "2026-10-01");
    expect(r).toEqual({ tasks: 2, notes: 1, tombstones: 1 });

    const quedan = (await p.admin.from("tasks").select("title, purged_at").eq("user_id", uid).order("title")).data!;
    expect(quedan.map((x) => x.title)).toEqual(["canvas en papelera vieja", "lápida vigente", "reciente"]);
    expect(quedan.find((x) => x.title === "canvas en papelera vieja")!.purged_at).not.toBeNull(); // pasó a lápida
  });

  it("vaciar la papelera no toca la de otra cuenta", async () => {
    await p.as(B).from("tasks").insert({ user_id: p.id(B), title: "de B", deleted_at: new Date().toISOString() });
    const { data } = await p.as(A).from("notes").insert({ user_id: uid, body: "n" }).select("id").single();
    await deleteNote(fd({ id: data!.id }));
    expect((await emptyTrash()).message).toBe("Papelera vacía");
    expect((await p.admin.from("tasks").select("title").eq("user_id", p.id(B))).data).toEqual([{ title: "de B" }]);
  });
});

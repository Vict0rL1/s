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

import { updateTaskDetails } from "@/app/actions";
import { syncCanvas } from "@/lib/canvas-sync";
import { ctxFor, fakeProject } from "./helpers/supa";

const A = "a@ejemplo.com";
let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;

beforeEach(async () => {
  p = await fakeProject([A]);
  uid = p.id(A);
  state.ctx = ctxFor(p.as(A), uid);
  vi.stubGlobal("fetch", vi.fn(async (u: string) =>
    new URL(String(u)).pathname.endsWith("/planner/items")
      ? Response.json([{
          course_id: "1", plannable_id: "9", plannable_type: "quiz", plannable_date: "2026-10-20T06:59:00Z",
          plannable: { title: "Final" }, submissions: { submitted: false },
        }])
      : Response.json([{ id: "1", name: "ECON 342 D100" }])));
});
afterEach(() => vi.unstubAllGlobals());

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const row = async (id: string) =>
  (await p.admin.from("tasks").select("kind, course, weight_pct, difficulty, est_minutes, user_edited_at").eq("id", id).single()).data!;

async function nueva() {
  const { data } = await p.as(A).from("tasks").insert({ user_id: uid, title: "Proyecto" }).select("id").single();
  return data!.id as string;
}

describe("detalles académicos de una tarea", () => {
  it("guarda los campos y la marca como editada", async () => {
    const id = await nueva();
    const r = await updateTaskDetails(null, fd({
      id, kind: "project", course: "ECON 370", weight_pct: "28", difficulty: "3", est_minutes: "600",
    }));
    expect(r.ok).toBe(true);
    expect(await row(id)).toMatchObject({ kind: "project", course: "ECON 370", weight_pct: 28, difficulty: 3, est_minutes: 600 });
    expect((await row(id)).user_edited_at).toBeTruthy();
  });

  it("vacío es vacío: borra el dato en vez de inventarlo", async () => {
    const id = await nueva();
    await updateTaskDetails(null, fd({ id, kind: "quiz", course: "X", weight_pct: "10", difficulty: "1", est_minutes: "30" }));
    await updateTaskDetails(null, fd({ id, kind: "", course: "", weight_pct: "", difficulty: "", est_minutes: "" }));
    expect(await row(id)).toMatchObject({ kind: null, course: null, weight_pct: null, difficulty: null, est_minutes: null });
  });

  it("rechaza valores fuera de rango sin tocar nada", async () => {
    const id = await nueva();
    const malos: Record<string, string>[] = [
      { weight_pct: "120" }, { difficulty: "5" }, { est_minutes: "0" }, { est_minutes: "12.5" }, { kind: "examen" },
    ];
    for (const bad of malos) {
      const r = await updateTaskDetails(null, fd({ id, kind: "", ...bad }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await row(id)).user_edited_at).toBeNull();
  });

  it("acepta coma decimal en el peso", async () => {
    const id = await nueva();
    await updateTaskDetails(null, fd({ id, weight_pct: "12,5" }));
    expect((await row(id)).weight_pct).toBe(12.5);
  });

  it("si corriges el tipo que trajo Canvas, el sync lo respeta", async () => {
    const ctx = ctxFor(p.admin, uid, "2026-09-30");
    await syncCanvas(ctx);
    const { data } = await p.admin.from("tasks").select("id, kind, course").eq("user_id", uid).single();
    // Un quiz de Canvas que se llama "Final": para el sync, el final.
    expect(data).toMatchObject({ kind: "final", course: "ECON 342" });

    // Victor sabe que es un quiz de práctica, no el examen.
    await updateTaskDetails(null, fd({ id: data!.id, kind: "quiz", course: "ECON 342" }));
    await syncCanvas(ctx);
    expect((await row(data!.id)).kind).toBe("quiz");
  });
});

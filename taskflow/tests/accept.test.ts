import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptable, freeGaps } from "@/lib/schedule";
import { ctxFor, fakeProject } from "./helpers/supa";
import type { Ctx } from "@/lib/data";

/* Las acciones del servidor piden la sesión con `getCtx` y revalidan con
   `revalidatePath`; aquí la sesión es la del proyecto en memoria. */
const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
}));
// "Ahora" son las 00:00: así "ya pasó" no depende de la hora a la que corran
// las pruebas. La prueba de lo pasado usa `acceptable` directamente.
vi.mock("@/lib/date", async (orig) => ({
  ...(await orig<typeof import("@/lib/date")>()),
  minutesInTz: () => 0,
}));

import { applyBreakdown, applyPlan } from "@/app/actions";

const A = "a@ejemplo.com";

let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;
let ctx: Ctx;

beforeEach(async () => {
  p = await fakeProject([A]);
  uid = p.id(A);
  ctx = ctxFor(p.as(A), uid, "2026-09-30");
  state.ctx = ctx;
});

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function blocks() {
  const { data } = await p.admin.from("blocks").select("start_min, end_min, title, task_id").eq("user_id", uid).order("start_min");
  return data ?? [];
}

const plan = (b: object[]) => fd({ plan: JSON.stringify(b), day: ctx.today });
const late = { start: 1380, end: 1410 }; // 23:00–23:30

describe("aceptar un plan", () => {
  it("aceptar dos veces la misma propuesta no duplica bloques", async () => {
    const propuesta = [{ ...late, title: "repasar", kind: "tarea", taskId: null }];
    const r1 = await applyPlan(null, plan(propuesta));
    const r2 = await applyPlan(null, plan(propuesta));
    expect(r1.ok).toBe(true);
    expect(r2).toMatchObject({ ok: false });
    expect(r2.message).toMatch(/ya está agendado/);
    expect(await blocks()).toHaveLength(1);
  });

  it("no pisa un bloque que pusiste a mano mientras mirabas la propuesta", async () => {
    await p.as(A).from("blocks").insert({ user_id: uid, day: ctx.today, start_min: 1390, end_min: 1420, title: "a mano" });
    const r = await applyPlan(null, plan([{ ...late, title: "repasar", kind: "tarea", taskId: null }]));
    expect(r.ok).toBe(false);
    expect((await blocks()).map((b) => b.title)).toEqual(["a mano"]);
  });

  it("si la tarea ya está hecha o borrada, su bloque no entra; el resto sí", async () => {
    // Mismas columnas en las tres filas: PostgREST pone NULL donde falte una.
    const { data: t } = await p.as(A).from("tasks").insert([
      { user_id: uid, title: "hecha", done: true, deleted_at: null },
      { user_id: uid, title: "borrada", done: false, deleted_at: new Date().toISOString() },
      { user_id: uid, title: "viva", done: false, deleted_at: null },
    ]).select("id, title");
    const id = (title: string) => t!.find((x) => x.title === title)!.id;

    const r = await applyPlan(null, plan([
      { start: 1300, end: 1320, title: "x", kind: "tarea", taskId: id("hecha") },
      { start: 1330, end: 1350, title: "y", kind: "tarea", taskId: id("borrada") },
      { start: 1360, end: 1380, title: "z", kind: "tarea", taskId: id("viva") },
    ]));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/1 bloque agendado · 2 ya no cabían/);
    expect((await blocks()).map((b) => b.task_id)).toEqual([id("viva")]);
  });

  it("un plan de otro día no se aplica", async () => {
    const r = await applyPlan(null, fd({ plan: JSON.stringify([{ ...late, title: "x" }]), day: "2020-01-01" }));
    expect(r.ok).toBe(false);
    expect(await blocks()).toHaveLength(0);
  });

  it("horas imposibles o no enteras no llegan a la base", async () => {
    const r = await applyPlan(null, plan([
      { start: 1300.5, end: 1320, title: "x" },
      { start: 1400, end: 1500, title: "y" },
      { start: 1330, end: 1320, title: "z" },
    ]));
    expect(r.ok).toBe(false);
    expect(await blocks()).toHaveLength(0);
  });
});

describe("aceptar los pasos de una tarea", () => {
  it("aceptar dos veces no duplica los pasos", async () => {
    const pasos = fd({
      steps: JSON.stringify([
        { title: "elegir tema", date: "2026-10-02", minutes: 30 },
        { title: "borrador", date: "2026-10-05", minutes: 120 },
      ]),
    });
    expect((await applyBreakdown(null, pasos)).ok).toBe(true);
    const r2 = await applyBreakdown(null, pasos);
    expect(r2).toMatchObject({ ok: false, message: "Esos pasos ya estaban agregados" });
    const { data } = await p.admin.from("tasks").select("title").eq("user_id", uid);
    expect(data).toHaveLength(2);
  });

  it("una fecha mal formada no entra", async () => {
    const r = await applyBreakdown(null, fd({ steps: JSON.stringify([{ title: "x", date: "mañana" }]) }));
    expect(r.ok).toBe(false);
  });
});

describe("acceptable, en frío", () => {
  it("rechaza lo encimado entre sí, lo ocupado y lo que ya pasó", () => {
    const r = acceptable(
      [
        { start: 480, end: 540 },
        { start: 500, end: 560 },
        { start: 600, end: 660 },
        { start: 300, end: 360 },
      ],
      [{ start: 620, end: 700 }],
      { now: 400 },
    );
    expect(r.accepted).toEqual([{ start: 480, end: 540 }]);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["ocupado", "ocupado", "pasado"]);
  });

  it("freeGaps funde lo encimado y descarta los huecos mínimos", () => {
    expect(freeGaps([{ start: 600, end: 700 }, { start: 650, end: 720 }, { start: 730, end: 800 }], 480, 900)).toEqual([
      { start: 480, end: 600 },
      { start: 800, end: 900 },
    ]);
  });
});

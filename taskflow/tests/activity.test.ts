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

import { discardProposal } from "@/app/actions";
import { logActivity, purgeActivity, recentAiCost } from "@/lib/activity";
import { runCanvasSync } from "@/lib/canvas-sync";
import type { CanvasPlannerItem } from "@/lib/canvas";
import { fakeSupabase } from "./helpers/fake-supabase";
import { ctxFor, fakeProject } from "./helpers/supa";

const item = (id: number, title: string, iso: string, extra: Partial<CanvasPlannerItem> = {}): CanvasPlannerItem => ({
  course_id: "101", plannable_id: String(id), plannable_type: "assignment", plannable_date: iso,
  plannable: { title }, submissions: { submitted: false }, html_url: `/a/${id}`, ...extra,
});

let canvasItems: CanvasPlannerItem[] = [];
let plannerStatus = 200;

beforeEach(() => {
  plannerStatus = 200;
  canvasItems = [item(1, "Problem Set 4", "2026-10-03T06:59:00Z"), item(2, "Midterm 1", "2026-10-15T17:30:00Z")];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    const path = new URL(String(u)).pathname;
    if (path.endsWith("/planner/items")) {
      return plannerStatus === 200 ? Response.json(canvasItems) : new Response("", { status: plannerStatus });
    }
    return Response.json([{ id: "101", name: "ECON 342 D100" }]);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const A = "a@ejemplo.com";

async function setup() {
  const p = await fakeProject([A]);
  const uid = p.id(A);
  const ctx = ctxFor(p.admin, uid, "2026-09-30");
  state.ctx = ctxFor(p.as(A), uid, "2026-09-30");
  const log = async () =>
    ((await p.admin.from("activity_log").select("actor, kind, summary, task_id").eq("user_id", uid).order("id")).data ?? []);
  return { p, uid, ctx, log };
}

describe("Actividad de Canvas", () => {
  it("cuenta lo que agregó, enlazado a cada tarea, y un resync idéntico no anota nada", async () => {
    const s = await setup();
    await runCanvasSync(s.ctx, "cron");
    const primera = await s.log();
    const agregadas = primera.filter((r) => r.kind === "canvas.added");
    expect(agregadas.map((r) => r.summary)).toEqual([
      "Canvas agregó «Problem Set 4» · vence 2 oct",
      "Canvas agregó «Midterm 1» · vence 15 oct",
    ]);
    expect(agregadas.every((r) => r.actor === "canvas" && r.task_id)).toBe(true);
    expect(primera.some((r) => r.actor === "system" && /El reloj sincronizó Canvas/.test(r.summary))).toBe(true);

    await runCanvasSync(s.ctx, "cron");
    expect(await s.log()).toHaveLength(primera.length);
  });

  it("dice qué cambió y si respetó tu edición", async () => {
    const s = await setup();
    await runCanvasSync(s.ctx, "cron");
    await s.p.as(A).from("tasks").update({ priority: 1, user_edited_at: new Date().toISOString() })
      .eq("external_id", "canvas:assignment:2");

    canvasItems = [
      item(1, "Problem Set 4", "2026-10-10T06:59:00Z"),
      item(2, "Midterm 1 (sala B)", "2026-10-15T17:30:00Z"),
    ];
    await runCanvasSync(s.ctx, "cron");
    const cambios = (await s.log()).filter((r) => r.kind.startsWith("canvas.updated"));
    expect(cambios.map((r) => r.summary)).toEqual([
      "Canvas movió «Problem Set 4» del 2 oct al 9 oct",
      "Canvas renombró «Midterm 1» a «Midterm 1 (sala B)» (respetó tus cambios: sólo tocó título y fecha)",
    ]);
  });

  it("anota lo entregado y lo que desapareció", async () => {
    const s = await setup();
    await runCanvasSync(s.ctx, "cron");
    canvasItems = [{ ...canvasItems[0], submissions: { submitted: true } }]; // la 1 entregada, la 2 borrada
    await runCanvasSync(s.ctx, "cron");
    const kinds = (await s.log()).map((r) => r.kind);
    expect(kinds).toContain("canvas.completed");
    expect(kinds).toContain("canvas.vanished");
  });

  it("un fallo se anota cuando empieza, no cada hora mientras dura", async () => {
    const s = await setup();
    await runCanvasSync(s.ctx, "cron");
    plannerStatus = 401;
    await runCanvasSync(s.ctx, "cron");
    await runCanvasSync(s.ctx, "cron");
    await runCanvasSync(s.ctx, "cron");
    const fallos = (await s.log()).filter((r) => r.kind === "canvas.failed");
    expect(fallos).toHaveLength(1);
    expect(fallos[0].summary).toMatch(/token/);

    plannerStatus = 200;
    await runCanvasSync(s.ctx, "cron");
    expect((await s.log()).some((r) => /Canvas volvió a sincronizar/.test(r.summary))).toBe(true);
  });

  it("el sync a mano lo firma el usuario", async () => {
    const s = await setup();
    await runCanvasSync(s.ctx, "manual");
    expect((await s.log())[0]).toMatchObject({ actor: "user", kind: "canvas.sync" });
  });
});

describe("Actividad en general", () => {
  it("descartar una propuesta de Claude queda anotado", async () => {
    const s = await setup();
    await discardProposal("plan");
    expect((await s.log())[0]).toMatchObject({ actor: "user", kind: "ai.discarded" });
  });

  it("purga lo que tiene más de 90 días y deja lo demás", async () => {
    const s = await setup();
    await s.p.admin.from("activity_log").insert([
      { user_id: s.uid, actor: "system", kind: "x", summary: "vieja", at: "2026-06-01T00:00:00Z" },
      { user_id: s.uid, actor: "system", kind: "x", summary: "nueva", at: "2026-09-29T00:00:00Z" },
    ]);
    await purgeActivity(s.ctx, new Date("2026-09-30T12:00:00Z"));
    expect((await s.log()).map((r) => r.summary)).toEqual(["nueva"]);
  });

  it("el costo reciente de Claude suma las propuestas de los últimos 30 días", async () => {
    const s = await setup();
    await s.p.admin.from("activity_log").insert([
      { user_id: s.uid, actor: "ai", kind: "ai.proposal", summary: "a", at: "2026-09-29T00:00:00Z", meta: { costUsd: 0.012 } },
      { user_id: s.uid, actor: "ai", kind: "ai.proposal", summary: "b", at: "2026-09-20T00:00:00Z", meta: { costUsd: 0.02 } },
      { user_id: s.uid, actor: "ai", kind: "ai.proposal", summary: "vieja", at: "2026-07-01T00:00:00Z", meta: { costUsd: 5 } },
      { user_id: s.uid, actor: "ai", kind: "ai.failed", summary: "f", at: "2026-09-29T00:00:00Z", meta: {} },
    ]);
    const c = await recentAiCost(s.ctx, Date.parse("2026-09-30T12:00:00Z"));
    expect(c.calls).toBe(2);
    expect(c.usd).toBeCloseTo(0.032);
  });

  it("si la base falla, escribir actividad no tumba nada y recorta lo largo", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, queries } = fakeSupabase(() => ({ data: null, error: { message: "boom" } }));
    await expect(
      logActivity({ supabase: client as never, userId: "u" }, { actor: "user", kind: "x", summary: "a".repeat(500) }),
    ).resolves.toBeUndefined();
    const row = (queries[0].calls.find((c) => c.method === "insert")!.args[0] as { summary: string }[])[0];
    expect(row.summary).toHaveLength(240);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

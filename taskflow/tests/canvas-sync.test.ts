import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `env.server` lee las variables al cargarse: tienen que existir antes del import.
vi.hoisted(() => {
  process.env.CANVAS_BASE_URL = "https://canvas.prueba/api/v1";
  process.env.CANVAS_TOKEN = "7~token-de-prueba-de-canvas-123456";
});

import { planSync, submittedIds, type CanvasPlannerItem, type CanvasTask } from "@/lib/canvas";
import { runCanvasSync, syncCanvas } from "@/lib/canvas-sync";
import { fakeSupabase } from "./helpers/fake-supabase";
import { ctxFor, fakeProject } from "./helpers/supa";

/* ------------------------------------------------------------- Canvas falso */

const COURSES = [
  { id: "101", name: "ECON 342 D100", course_code: "ECON342" },
  { id: "202", name: "ECON 370 D100", course_code: "ECON370" },
];

const item = (id: number, title: string, isoDate: string, extra: Partial<CanvasPlannerItem> = {}): CanvasPlannerItem => ({
  course_id: "101",
  plannable_id: String(id),
  plannable_type: "assignment",
  plannable_date: isoDate,
  plannable: { title },
  submissions: { submitted: false },
  html_url: `/courses/101/assignments/${id}`,
  ...extra,
});

let canvasItems: CanvasPlannerItem[] = [];
let coursesStatus = 200;
let plannerStatus = 200;

function canvasFetch(url: string): Promise<Response> {
  const u = new URL(url);
  if (u.pathname.endsWith("/planner/items")) {
    if (plannerStatus !== 200) return Promise.resolve(new Response("", { status: plannerStatus }));
    return Promise.resolve(Response.json(canvasItems));
  }
  if (u.pathname.endsWith("/favorites/courses")) {
    if (coursesStatus !== 200) return Promise.resolve(new Response("", { status: coursesStatus }));
    return Promise.resolve(Response.json(COURSES));
  }
  return Promise.resolve(new Response("", { status: 404 }));
}

beforeEach(() => {
  coursesStatus = 200;
  plannerStatus = 200;
  canvasItems = [
    item(1, "Problem Set 4", "2026-10-03T06:59:00Z"), // 2 oct 23:59 Vancouver
    item(2, "Midterm 1", "2026-10-15T17:30:00Z", { plannable_type: "quiz", course_id: "202" }),
    item(3, "Reading response", "2026-10-08T06:59:00Z"),
  ];
  vi.stubGlobal("fetch", vi.fn((u: string) => canvasFetch(String(u))));
});
afterEach(() => vi.unstubAllGlobals());

const TODAY = "2026-09-30";
const A = "a@ejemplo.com";

async function setup() {
  const p = await fakeProject([A, "b@ejemplo.com"]);
  const uid = p.id(A);
  const ctx = ctxFor(p.admin, uid, TODAY);
  const rows = async () => {
    const { data } = await p.admin
      .from("tasks")
      .select("external_id, title, area, body, due_date, due_time, done, priority, est_minutes, deleted_at, user_edited_at")
      .eq("user_id", uid)
      .order("external_id");
    return data ?? [];
  };
  const row = async (ext: string) => (await rows()).find((r) => r.external_id === ext)!;
  return { p, uid, ctx, rows, row };
}

/* ---------------------------------------------------------------- tests */

describe("sync de Canvas contra la base", () => {
  it("dos syncs seguidos dejan exactamente las mismas filas", async () => {
    const { ctx, rows } = await setup();
    await syncCanvas(ctx);
    const first = await rows();
    await syncCanvas(ctx);
    expect(await rows()).toEqual(first);
    expect(first).toHaveLength(3);
    expect(first.find((r) => r.external_id === "canvas:assignment:1")).toMatchObject({
      due_date: "2026-10-02",
      due_time: "23:59:00",
      body: "ECON 342 D100",
      area: "SFU",
    });
  });

  it("dos syncs a la vez no duplican nada", async () => {
    const { ctx, rows } = await setup();
    await Promise.all([syncCanvas(ctx), syncCanvas(ctx), syncCanvas(ctx)]);
    expect(await rows()).toHaveLength(3);
  });

  it("un cambio de fecha o de nombre en Canvas se refleja", async () => {
    const { ctx, row } = await setup();
    await syncCanvas(ctx);
    canvasItems[0] = item(1, "Problem Set 4 (corregido)", "2026-10-06T06:59:00Z");
    await syncCanvas(ctx);
    expect(await row("canvas:assignment:1")).toMatchObject({
      title: "Problem Set 4 (corregido)",
      due_date: "2026-10-05",
    });
  });

  it("después de una edición manual sólo cambian título y fecha", async () => {
    const { p, ctx, row } = await setup();
    await syncCanvas(ctx);

    // Victor la edita desde la app, con su sesión.
    await p.as(A).from("tasks").update({
      area: "Proyectos", priority: 1, est_minutes: 120, done: true,
      user_edited_at: new Date().toISOString(),
    }).eq("external_id", "canvas:assignment:1");

    canvasItems[0] = item(1, "PS4 v2", "2026-10-10T06:59:00Z", { course_id: "202" });
    const r = await syncCanvas(ctx);
    expect(r.protected).toBe(1);

    expect(await row("canvas:assignment:1")).toMatchObject({
      title: "PS4 v2",
      due_date: "2026-10-09",
      area: "Proyectos",
      priority: 1,
      est_minutes: 120,
      done: true,
      body: "ECON 342 D100", // el curso tampoco cambia en una fila editada
    });
  });

  it("una tarea de Canvas borrada se queda borrada", async () => {
    const { p, ctx, row, rows } = await setup();
    await syncCanvas(ctx);
    await p.as(A).from("tasks").update({ deleted_at: new Date().toISOString() }).eq("external_id", "canvas:assignment:1");

    await syncCanvas(ctx);
    await syncCanvas(ctx);

    expect((await row("canvas:assignment:1")).deleted_at).not.toBeNull();
    expect(await rows()).toHaveLength(3); // no se recreó al lado
  });

  it("si fallan los cursos, las filas existentes no pierden curso ni área", async () => {
    const { ctx, row } = await setup();
    await syncCanvas(ctx);
    coursesStatus = 500;
    canvasItems[1] = item(2, "Midterm 1 (sala B)", "2026-10-15T17:30:00Z", { plannable_type: "quiz", course_id: "202" });
    await syncCanvas(ctx);
    expect(await row("canvas:quiz:2")).toMatchObject({ title: "Midterm 1 (sala B)", body: "ECON 370 D100" });
  });

  it("lo entregado en Canvas se marca hecho, salvo que lo hayas tocado", async () => {
    const { p, ctx, row } = await setup();
    await syncCanvas(ctx);
    // A la 3 la tocó Victor (y la dejó pendiente a propósito).
    await p.as(A).from("tasks").update({ priority: 1, user_edited_at: new Date().toISOString() })
      .eq("external_id", "canvas:assignment:3");

    canvasItems = canvasItems.map((i) => ({ ...i, submissions: { submitted: true } }));
    const r = await syncCanvas(ctx);
    expect(r.completed).toBe(2);

    expect((await row("canvas:assignment:1")).done).toBe(true);
    expect((await row("canvas:quiz:2")).done).toBe(true);
    expect((await row("canvas:assignment:3")).done).toBe(false);
  });

  it("lo que desaparece de Canvas va a la papelera — no lo editado ni lo que salió de la ventana", async () => {
    const { p, ctx, row } = await setup();
    await syncCanvas(ctx);
    await p.as(A).from("tasks").update({ user_edited_at: new Date().toISOString() })
      .eq("external_id", "canvas:assignment:3");

    canvasItems = [canvasItems[1]]; // el profesor borró la 1 y la 3
    const r = await syncCanvas(ctx);
    expect(r.vanished).toBe(1);
    expect((await row("canvas:assignment:1")).deleted_at).not.toBeNull();
    expect((await row("canvas:assignment:3")).deleted_at).toBeNull(); // la tocaste: es tuya
    expect((await row("canvas:quiz:2")).deleted_at).toBeNull();
  });

  it("una respuesta vacía no vacía la lista", async () => {
    const { ctx, rows } = await setup();
    await syncCanvas(ctx);
    canvasItems = [];
    await syncCanvas(ctx);
    expect((await rows()).every((r) => r.deleted_at === null)).toBe(true);
  });

  it("si Canvas falla, no se escribe nada y queda constancia con su código", async () => {
    const { p, uid, ctx, rows } = await setup();
    await runCanvasSync(ctx, "cron");
    const antes = await rows();

    plannerStatus = 401;
    const r = await runCanvasSync(ctx, "cron");
    expect(r).toMatchObject({ ok: false, code: "CANVAS_TOKEN_EXPIRED" });
    expect(await rows()).toEqual(antes);

    const { data: st } = await p.admin.from("sync_state").select("*").eq("user_id", uid).eq("source", "canvas").single();
    expect(st.last_error_code).toBe("CANVAS_TOKEN_EXPIRED");
    expect(st.last_success_at).not.toBeNull(); // el éxito anterior sigue ahí
    expect(st.last_error_at > st.last_success_at).toBe(true);
    expect(st.items_synced).toBe(3); // el fallo no borra el conteo
    expect(JSON.stringify(st)).not.toContain("token-de-prueba");
  });

  it("si no se pueden leer las filas guardadas, no escribe nada", async () => {
    const { client, queries } = fakeSupabase((q) =>
      q.calls.some((c) => c.method === "select") ? { data: null, error: { message: "boom" } } : { data: null, error: null },
    );
    const { ctx } = await setup();
    await expect(syncCanvas({ ...ctx, supabase: client as never })).rejects.toMatchObject({ code: "CANVAS_DB_FAILED" });
    expect(queries.some((q) => q.calls.some((c) => c.method === "upsert" || c.method === "update"))).toBe(false);
  });
});

/* -------------------------------------------------- reglas del plan, en frío */

const T = (id: string, due = "2026-10-10"): CanvasTask => ({
  externalId: id, title: id, area: "SFU", dueDate: due, dueTime: null, body: null, externalUrl: null,
  kind: "assignment", course: null,
});
const W = { start: "2026-09-16", end: "2027-03-29", complete: true };

describe("planSync", () => {
  it("con muchas desapariciones de golpe, frena y no borra nada", () => {
    const existing = Array.from({ length: 8 }, (_, i) => ({
      external_id: `c:${i}`, user_edited_at: null, done: false, deleted_at: null, due_date: "2026-10-10",
    }));
    const plan = planSync([T("c:0")], existing, { window: W });
    expect(plan.vanished).toEqual([]);
    expect(plan.vanishedHeld).toBe(7);
  });

  it("con la paginación incompleta, no concluye que algo desapareció", () => {
    const existing = [{ external_id: "c:1", user_edited_at: null, done: false, deleted_at: null, due_date: "2026-10-10" }];
    expect(planSync([T("c:2")], existing, { window: { ...W, complete: false } }).vanished).toEqual([]);
  });

  it("lo que salió por el borde de la ventana no desapareció", () => {
    const existing = [{ external_id: "c:1", user_edited_at: null, done: false, deleted_at: null, due_date: "2026-09-16" }];
    expect(planSync([T("c:2")], existing, { window: W }).vanished).toEqual([]);
  });

  it("submittedIds sólo toma tipos de deadline entregados", () => {
    expect(
      submittedIds([
        item(1, "a", "2026-10-01T00:00:00Z", { submissions: { submitted: true } }),
        item(2, "b", "2026-10-01T00:00:00Z"),
        item(3, "c", "2026-10-01T00:00:00Z", { plannable_type: "announcement", submissions: { submitted: true } }),
      ]),
    ).toEqual(["canvas:assignment:1"]);
  });
});

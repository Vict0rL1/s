import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
  getApiCtx: async () => state.ctx,
}));
// "Ahora" son las 8:00: así lo que cae hoy no depende de la hora de la prueba.
vi.mock("@/lib/date", async (orig) => ({
  ...(await orig<typeof import("@/lib/date")>()),
  minutesInTz: () => 8 * 60,
}));

import { applyPrepPlan, applyReplan } from "@/app/actions";
import { POST as prepRoute } from "@/app/api/prep/route";
import { POST as replanRoute } from "@/app/api/replan/route";
import { nameSessions } from "@/lib/prep-ai";
import { addDays } from "@/lib/date";
import { ctxFor, fakeProject } from "./helpers/supa";
import type { Task } from "@/lib/types";

const A = "a@ejemplo.com";
const HOY = "2026-10-01";
let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;

beforeEach(async () => {
  p = await fakeProject([A]);
  uid = p.id(A);
  state.ctx = ctxFor(p.as(A), uid, HOY, "America/Vancouver", { day_start: 8, day_end: 22 });
});

const post = (body: object) => new Request("https://x", { method: "POST", body: JSON.stringify(body) });
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function task(over: Record<string, unknown>) {
  const { data } = await p.as(A).from("tasks").insert({ user_id: uid, title: "Midterm 1", ...over }).select("*").single();
  return data as Task;
}
const blocks = async () =>
  ((await p.admin.from("blocks").select("day, start_min, end_min, title, task_id").eq("user_id", uid).order("day").order("start_min")).data ?? []);

/** Una clase de 10:00 a 12:00 todos los días: los planes tienen que esquivarla. */
async function clasesDiarias(n = 10) {
  const rows = Array.from({ length: n }, (_, i) => {
    const d = addDays(HOY, i);
    return {
      user_id: uid, title: "ECON 342", source: "ics", external_id: `c${i}`,
      starts_at: `${d}T17:00:00Z`, ends_at: `${d}T19:00:00Z`, all_day_date: null,
    };
  });
  await p.as(A).from("events").insert(rows);
}

describe("plan de preparación", () => {
  it("la ruta propone sesiones que esquivan clases, nunca el día del examen, repaso el día antes", async () => {
    await clasesDiarias();
    const t = await task({ kind: "midterm", due_date: addDays(HOY, 6) });
    const r = await (await prepRoute(post({ taskId: t.id, totalMin: 360, sessionMin: 90 }))).json();
    expect(r.ok).toBe(true);
    expect(r.shortfall).toBe(0);
    for (const s of r.sessions) {
      expect(s.day < t.due_date!).toBe(true);
      expect(s.end <= 600 || s.start >= 720).toBe(true); // fuera de 10:00–12:00
    }
    expect(r.sessions.at(-1)).toMatchObject({ day: addDays(t.due_date!, -1), review: true });
  });

  it("no ofrece plan para una tarea común", async () => {
    const t = await task({ kind: "assignment", due_date: addDays(HOY, 5) });
    expect((await prepRoute(post({ taskId: t.id, totalMin: 120 }))).status).toBe(400);
  });

  it("agendar dos veces la misma propuesta no duplica nada", async () => {
    const t = await task({ kind: "midterm", due_date: addDays(HOY, 6) });
    const { sessions } = await (await prepRoute(post({ taskId: t.id, totalMin: 180, sessionMin: 60 }))).json();
    const form = fd({ taskId: t.id, sessions: JSON.stringify(sessions) });
    expect((await applyPrepPlan(null, form)).ok).toBe(true);
    const r2 = await applyPrepPlan(null, form);
    expect(r2.ok).toBe(false);
    expect(await blocks()).toHaveLength(sessions.length);
    expect((await blocks()).every((b) => b.task_id === t.id)).toBe(true);
  });

  it("al aceptar descarta lo que cae el día del deadline o después, aunque venga en el formulario", async () => {
    const t = await task({ kind: "project", due_date: addDays(HOY, 3) });
    const r = await applyPrepPlan(null, fd({
      taskId: t.id,
      sessions: JSON.stringify([
        { day: addDays(HOY, 1), start: 900, end: 960, title: "ok" },
        { day: addDays(HOY, 3), start: 900, end: 960, title: "el día del deadline" },
        { day: addDays(HOY, 5), start: 900, end: 960, title: "después" },
      ]),
    }));
    expect(r.ok).toBe(true);
    expect((await blocks()).map((b) => b.title)).toEqual(["ok"]);
  });

  it("nunca toca un bloque que pusiste a mano", async () => {
    const t = await task({ kind: "midterm", due_date: addDays(HOY, 4) });
    await p.as(A).from("blocks").insert({ user_id: uid, day: addDays(HOY, 1), start_min: 900, end_min: 960, title: "a mano" });
    await applyPrepPlan(null, fd({
      taskId: t.id, sessions: JSON.stringify([{ day: addDays(HOY, 1), start: 930, end: 990, title: "choca" }]),
    }));
    expect((await blocks()).map((b) => b.title)).toEqual(["a mano"]);
  });
});

describe("replanificar", () => {
  it("encuentra el hueco de hoy después de la clase", async () => {
    await clasesDiarias(1);
    await p.as(A).from("blocks").insert({ user_id: uid, day: HOY, start_min: 480, end_min: 600, title: "gimnasio" });
    const t = await task({ due_date: addDays(HOY, 3), est_minutes: 60 });
    const r = await (await replanRoute(post({ taskId: t.id, scope: "today", minutes: 60 }))).json();
    expect(r.slot).toMatchObject({ day: HOY, start: 720, end: 780 });
    expect(r.slot.why).toMatch(/después de ECON 342/);
  });

  it("el día del deadline, antes de la hora de entrega", async () => {
    const t = await task({ due_date: HOY, due_time: "08:30:00" });
    const r = await (await replanRoute(post({ taskId: t.id, scope: "today", minutes: 60 }))).json();
    expect(r.slot).toBeNull();
    expect(r.message).toMatch(/No hay un hueco/);
  });

  it("agendar: crea el bloque; en una tarea manual atrasada puede mover también la fecha", async () => {
    const t = await task({ source: "manual", due_date: addDays(HOY, -2) });
    const r = await applyReplan(null, fd({ taskId: t.id, day: addDays(HOY, 1), start: "900", end: "960", moveDate: "1" }));
    expect(r.ok).toBe(true);
    const { data } = await p.admin.from("tasks").select("due_date, user_edited_at").eq("id", t.id).single();
    expect(data).toMatchObject({ due_date: addDays(HOY, 1) });
    expect(data!.user_edited_at).toBeTruthy();
    expect(await blocks()).toHaveLength(1);
  });

  it("en una tarea de Canvas, la fecha de entrega no se toca", async () => {
    const t = await task({ source: "canvas", external_id: "canvas:assignment:1", due_date: addDays(HOY, 4) });
    const r = await (await replanRoute(post({ taskId: t.id, scope: "tomorrow", minutes: 60 }))).json();
    expect(r.canMoveDate).toBe(false);
    await applyReplan(null, fd({ taskId: t.id, day: r.slot.day, start: String(r.slot.start), end: String(r.slot.end), moveDate: "1" }));
    const { data } = await p.admin.from("tasks").select("due_date").eq("id", t.id).single();
    expect(data!.due_date).toBe(addDays(HOY, 4));
  });

  it("no agenda después del deadline ni encima de algo ocupado", async () => {
    const t = await task({ due_date: addDays(HOY, 1) });
    expect((await applyReplan(null, fd({ taskId: t.id, day: addDays(HOY, 2), start: "900", end: "960" }))).ok).toBe(false);
    await p.as(A).from("blocks").insert({ user_id: uid, day: HOY, start_min: 900, end_min: 960, title: "a mano" });
    expect((await applyReplan(null, fd({ taskId: t.id, day: HOY, start: "930", end: "990" }))).ok).toBe(false);
    expect(await blocks()).toHaveLength(1);
  });
});

describe("Claude sólo pone nombres", () => {
  const t = { title: "Midterm 1", course: "ECON 342", body: null } as Task;
  const fake = (sesiones: string[]) => ({
    beta: { messages: { parse: vi.fn(async () => ({
      stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 500, output_tokens: 100 },
      parsed_output: { sesiones },
    })) } },
  }) as never;

  it("usa los títulos en orden y completa los que falten con los de siempre", async () => {
    const r = await nameSessions(t, [{ minutes: 60, review: false }, { minutes: 60, review: false }, { minutes: 45, review: true }],
      ["def 1", "def 2", "def 3"], fake(["repasar caps 1–3", "  "]));
    expect(r.titles).toEqual(["repasar caps 1–3", "def 2", "def 3"]);
  });

  it("si devuelve de más, se ignoran: el número de sesiones no lo decide Claude", async () => {
    const r = await nameSessions(t, [{ minutes: 60, review: false }], ["def"], fake(["a", "b", "c"]));
    expect(r.titles).toEqual(["a"]);
  });
});

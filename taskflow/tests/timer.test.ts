import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
}));

import { deleteTask, finishTimer, pauseTimer, startTimer, toggleTask } from "@/app/actions";
import { MAX_SESSION_SEC } from "@/lib/timing";
import { ctxFor, fakeProject } from "./helpers/supa";

const A = "a@ejemplo.com", B = "b@ejemplo.com";
let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;
const T0 = Date.parse("2026-10-01T16:00:00Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  p = await fakeProject([A, B]);
  uid = p.id(A);
  state.ctx = ctxFor(p.as(A), uid, "2026-10-01");
});
afterEach(() => vi.useRealTimers());

const fd = (id: string) => {
  const f = new FormData();
  f.set("id", id);
  return f;
};
const later = (min: number) => vi.setSystemTime(Date.now() + min * 60_000);
async function task(title = "PS4", est: number | null = 60) {
  const { data } = await p.as(A).from("tasks").insert({ user_id: uid, title, est_minutes: est }).select("id").single();
  return data!.id as string;
}
const row = async (id: string) =>
  (await p.admin.from("tasks").select("tracked_sec, track_sessions, track_started_at, done, deleted_at").eq("id", id).single()).data!;
const log = async () => ((await p.admin.from("activity_log").select("kind, summary").eq("user_id", uid)).data ?? []);

describe("cronómetro", () => {
  it("empezar, pausar y volver a empezar suman sesiones y tiempo", async () => {
    const id = await task();
    expect((await startTimer(null, fd(id))).ok).toBe(true);
    later(25);
    expect((await pauseTimer(null, fd(id))).message).toMatch(/25m esta vez/);
    await startTimer(null, fd(id));
    later(10);
    await pauseTimer(null, fd(id));
    expect(await row(id)).toMatchObject({ tracked_sec: 35 * 60, track_sessions: 2, track_started_at: null });
  });

  it("una sola en marcha: empezar otra pausa la primera", async () => {
    const a = await task("A"), b = await task("B");
    await startTimer(null, fd(a));
    later(15);
    expect((await startTimer(null, fd(b))).message).toMatch(/la otra quedó en pausa/);
    expect(await row(a)).toMatchObject({ tracked_sec: 15 * 60, track_sessions: 1, track_started_at: null });
    expect((await row(b)).track_started_at).not.toBeNull();
  });

  it("pausar dos veces (doble clic) no cuenta el tiempo dos veces", async () => {
    const id = await task();
    await startTimer(null, fd(id));
    later(20);
    const [r1, r2] = await Promise.all([pauseTimer(null, fd(id)), pauseTimer(null, fd(id))]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ tracked_sec: 20 * 60, track_sessions: 1 });
  });

  it("terminar cierra la sesión, marca hecha y lo anota con el estimado", async () => {
    const id = await task("PS4", 60);
    await startTimer(null, fd(id));
    later(82);
    await finishTimer(null, fd(id));
    expect(await row(id)).toMatchObject({ done: true, tracked_sec: 82 * 60, track_started_at: null });
    expect((await log()).find((r) => r.kind === "timer.finished")?.summary).toBe("Terminaste «PS4»: 1h22 (estimado 1h)");
  });

  it("marcarla hecha con el check también cierra el cronómetro", async () => {
    const id = await task();
    await startTimer(null, fd(id));
    later(30);
    await toggleTask(fd(id));
    expect(await row(id)).toMatchObject({ done: true, tracked_sec: 30 * 60, track_started_at: null });
  });

  it("mandarla a la papelera también", async () => {
    const id = await task();
    await startTimer(null, fd(id));
    later(5);
    await deleteTask(fd(id));
    const r = await row(id);
    expect(r.track_started_at).toBeNull();
    expect(r.deleted_at).not.toBeNull();
    expect(r.tracked_sec).toBe(5 * 60);
  });

  it("un cronómetro olvidado cuenta como mucho 6 h, y se avisa", async () => {
    const id = await task();
    await startTimer(null, fd(id));
    later(14 * 60);
    await pauseTimer(null, fd(id));
    expect((await row(id)).tracked_sec).toBe(MAX_SESSION_SEC);
    expect((await log()).some((r) => r.kind === "timer.capped")).toBe(true);
  });

  it("no se puede empezar una tarea hecha ni una ajena", async () => {
    const hecha = await task();
    await p.admin.from("tasks").update({ done: true }).eq("id", hecha);
    expect((await startTimer(null, fd(hecha))).ok).toBe(false);

    const { data } = await p.as(B).from("tasks").insert({ user_id: p.id(B), title: "de B" }).select("id").single();
    expect((await startTimer(null, fd(data!.id))).ok).toBe(false);
    expect((await row(data!.id)).track_started_at).toBeNull();
  });
});

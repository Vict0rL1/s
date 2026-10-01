import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
}));

import { deleteHabit, pauseHabit, resumeHabit, toggleHabit, updateHabit } from "@/app/actions";
import { compliance, habitSince, pctText, streak } from "@/lib/habits";
import { loadHabits } from "@/lib/data";
import type { Habit } from "@/lib/types";
import { ctxFor, fakeProject } from "./helpers/supa";

const HOY = "2026-10-01"; // jueves
const TZ = "America/Vancouver";

const habit = (o: Partial<Habit> = {}): Habit => ({
  id: "h", user_id: "u", name: "Correr", days: [0, 1, 2, 3, 4, 5, 6], archived: false, sort_order: 0,
  created_at: "2026-01-01T12:00:00Z", show_streak: true, active_from: null, ...o,
});
const logOf = (days: string[], id = "h") => new Map(days.map((d) => [d, new Set([id])]));

describe("cumplimiento", () => {
  it("de los días en que tocaba, en cuántos se hizo", () => {
    const c = compliance(habit(), logOf(["2026-09-30", "2026-09-29", "2026-09-27"]), HOY, 7, "2026-01-01");
    // Hoy no está hecho y el día sigue: no cuenta. Quedan seis días, tres hechos.
    expect(c).toEqual({ done: 3, scheduled: 6, pct: 50 });
    expect(pctText(c)).toBe("50 %");
  });

  it("hoy cuenta en cuanto se marca", () => {
    expect(compliance(habit(), logOf([HOY]), HOY, 7, "2026-01-01")).toEqual({ done: 1, scheduled: 7, pct: 14 });
  });

  it("lo de antes de crearla no cuenta como fallado", () => {
    // Creada ayer y hecha ayer: 100 %, no 1 de 30.
    const c = compliance(habit(), logOf(["2026-09-30"]), HOY, 30, "2026-09-30");
    expect(c).toEqual({ done: 1, scheduled: 1, pct: 100 });
  });

  it("sólo los días en que toca; hacerla un día que no tocaba no pasa del 100 %", () => {
    // Lun, mié y vie. En los últimos 7 días (vie 25 → jue 1): vie 25, lun 28, mié 30.
    const h = habit({ days: [1, 3, 5] });
    const c = compliance(h, logOf(["2026-09-25", "2026-09-28", "2026-09-30", "2026-09-27"]), HOY, 7, "2026-01-01");
    expect(c).toEqual({ done: 3, scheduled: 3, pct: 100 });
  });

  it("recién creada, sin ningún día que tocara todavía: sin porcentaje", () => {
    const c = compliance(habit(), new Map(), HOY, 7, HOY);
    expect(c.pct).toBeNull();
    expect(pctText(c)).toBe("—");
  });
});

describe("desde cuándo cuenta", () => {
  it("el día de creación es el de tu zona, no el de UTC", () => {
    // 03:00 UTC del 20 es todavía el 19 en Vancouver.
    expect(habitSince(habit({ created_at: "2026-09-20T03:00:00Z" }), TZ)).toBe("2026-09-19");
  });

  it("con marcas de antes de crearla (vino de un respaldo), cuenta desde la primera", () => {
    const h = habit({ created_at: "2026-09-30T18:00:00Z" });
    expect(habitSince(h, TZ, logOf(["2026-09-26", "2026-09-28"]))).toBe("2026-09-26");
    expect(habitSince(h, TZ, logOf(["2026-09-26"], "otra"))).toBe("2026-09-30");
  });

  it("al reanudar, cuenta desde la vuelta; las semanas en pausa no son fallas", () => {
    const h = habit({ created_at: "2026-09-01T18:00:00Z", active_from: "2026-09-28" });
    expect(habitSince(h, TZ, logOf(["2026-09-02"]))).toBe("2026-09-28");
    expect(compliance(h, logOf(["2026-09-28", "2026-09-29", "2026-09-30"]), HOY, 30, habitSince(h, TZ))).toMatchObject({ pct: 100 });
  });
});

describe("racha", () => {
  it("días seguidos en que tocaba; hoy sin marcar no la rompe", () => {
    const h = habit({ days: [1, 3, 5] });
    expect(streak(h, logOf(["2026-09-30", "2026-09-28", "2026-09-25"]), HOY)).toBe(3);
    expect(streak(habit(), logOf(["2026-09-30", "2026-09-29"]), HOY)).toBe(2);
    expect(streak(habit(), logOf(["2026-09-29"]), HOY)).toBe(0);
  });
});

describe("acciones de rutinas", () => {
  const A = "a@ejemplo.com", B = "b@ejemplo.com";
  let p: Awaited<ReturnType<typeof fakeProject>>;
  let a: string, hId: string, hB: string;
  const fd = (o: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
    return f;
  };

  beforeEach(async () => {
    p = await fakeProject([A, B]);
    a = p.id(A);
    state.ctx = ctxFor(p.as(A), a, HOY);
    hId = (await p.as(A).from("habits").insert({ user_id: a, name: "Correr" }).select("id").single()).data!.id;
    hB = (await p.as(B).from("habits").insert({ user_id: p.id(B), name: "De B" }).select("id").single()).data!.id;
  });

  const logDays = async () => (await p.admin.from("habit_log").select("day").eq("habit_id", hId)).data!.map((r) => r.day);

  it("marcar sólo acepta días que ya pasaron y que se ven", async () => {
    await toggleHabit(fd({ id: hId, day: "2026-10-02" })); // mañana
    await toggleHabit(fd({ id: hId, day: "ayer" }));
    await toggleHabit(fd({ id: hId, day: "2025-01-01" })); // fuera de la ventana
    expect(await logDays()).toEqual([]);
    await toggleHabit(fd({ id: hId, day: "2026-09-30" }));
    expect(await logDays()).toEqual(["2026-09-30"]);
  });

  it("ajustar: días, nombre y racha; nunca la de otro", async () => {
    const r = await updateHabit(null, fd({ id: hId, name: "Correr 5 km", days: ["1", "3", "5", "9"], show_streak: "" }));
    expect(r.ok).toBe(true);
    const { data } = await p.admin.from("habits").select("name, days, show_streak").eq("id", hId).single();
    expect(data).toEqual({ name: "Correr 5 km", days: [1, 3, 5], show_streak: false });

    expect((await updateHabit(null, fd({ id: hB, name: "mía", days: ["1"] }))).ok).toBe(false);
    expect((await p.admin.from("habits").select("name").eq("id", hB).single()).data!.name).toBe("De B");
  });

  it("pausar la saca de la lista sin perder el historial; reanudar cuenta desde hoy", async () => {
    await toggleHabit(fd({ id: hId, day: "2026-09-30" }));
    await pauseHabit(fd({ id: hId }));
    expect(await loadHabits(state.ctx as never)).toEqual([]);
    expect((await loadHabits(state.ctx as never, { paused: true })).map((h) => h.name)).toEqual(["Correr"]);
    expect(await logDays()).toEqual(["2026-09-30"]);

    await resumeHabit(fd({ id: hId }));
    const [h] = await loadHabits(state.ctx as never);
    expect(h).toMatchObject({ archived: false, active_from: HOY });
  });

  it("borrar se lleva el historial, lo anota, y no toca rutinas ajenas", async () => {
    await toggleHabit(fd({ id: hId, day: "2026-09-30" }));
    await deleteHabit(fd({ id: hB }));
    expect((await p.admin.from("habits").select("id").eq("id", hB)).data).toHaveLength(1);

    await deleteHabit(fd({ id: hId }));
    expect((await p.admin.from("habits").select("id").eq("id", hId)).data).toEqual([]);
    expect(await logDays()).toEqual([]);
    const { data: act } = await p.admin.from("activity_log").select("kind, summary").eq("user_id", a);
    expect(act).toEqual([{ kind: "habit.deleted", summary: "Borraste la rutina «Correr» y su historial" }]);
  });
});

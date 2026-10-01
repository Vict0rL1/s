import { describe, expect, it } from "vitest";
import { todayContext } from "@/lib/today";
import type { Block, DayEvent, Task } from "@/lib/types";

const HOY = "2026-10-01";
const ev = (title: string, start: number, end: number, day = HOY): DayEvent => ({ id: title, title, day, start, end, source: "ics", courseRef: null });
const bl = (title: string, start: number, end: number): Block => ({
  id: title, user_id: "u", day: HOY, start_min: start, end_min: end, title, kind: "tarea", task_id: null, created_at: "",
});
const task = (o: Partial<Task>): Task => ({
  id: "t", user_id: "u", title: "x", area: null, due_date: null, due_time: null, est_minutes: null, priority: 3,
  done: false, done_at: null, body: null, source: "manual", external_id: null, external_url: null, focus_day: null,
  user_edited_at: null, deleted_at: null, kind: null, course: null, weight_pct: null, difficulty: null,
  tracked_sec: 0, track_sessions: 0, track_started_at: null, created_at: "", updated_at: "", ...o,
});

const ctx = (nowMin: number, o: { events?: DayEvent[]; blocks?: Block[]; tasks?: Task[] } = {}) =>
  todayContext({ nowMin, today: HOY, dayEnd: 23, events: o.events ?? [], blocks: o.blocks ?? [], tasks: o.tasks ?? [] });

describe("el contexto de Hoy", () => {
  it("la próxima clase en minutos y el hueco hasta ella", () => {
    const c = ctx(9 * 60 + 48, { events: [ev("ECON 342", 10 * 60 + 30, 12 * 60)] });
    expect(c.lines).toEqual(["Próximo: ECON 342 en 42 min", "Tienes un hueco de 42 min hasta las 10:30"]);
  });

  it("durante una clase: hasta cuándo, y el hueco que queda después", () => {
    const c = ctx(11 * 60, {
      events: [ev("ECON 342", 10 * 60 + 30, 12 * 60)],
      blocks: [bl("Leer", 13 * 60 + 20, 14 * 60)],
    });
    expect(c.lines).toEqual(["Ahora: ECON 342, hasta las 12:00", "Próximo: Leer a las 13:20", "Tienes un hueco de 1 h 20 min hasta las 13:20"]);
  });

  it("lo lejano dice la hora, no los minutos", () => {
    expect(ctx(8 * 60, { events: [ev("ECON 370", 15 * 60, 16 * 60)] }).lines[0]).toBe("Próximo: ECON 370 a las 15:00");
  });

  it("sin compromisos lo dice, sin inventar un hueco", () => {
    expect(ctx(16 * 60).lines).toEqual(["Sin más compromisos hoy"]);
  });

  it("un hueco de menos de 30 min no se ofrece", () => {
    expect(ctx(10 * 60 + 10, { events: [ev("Clase", 10 * 60 + 30, 11 * 60)] }).gap).toBeNull();
  });

  it("la entrega importante más cercana de la semana, con el curso", () => {
    const c = ctx(9 * 60, {
      tasks: [
        task({ title: "PS5", kind: "assignment", due_date: "2026-10-02" }), // no es importante
        task({ title: "Midterm 1", kind: "midterm", course: "ECON 342", due_date: "2026-10-04" }),
        task({ title: "Final", kind: "final", due_date: "2026-10-20" }), // fuera de la semana
      ],
    });
    expect(c.lines.at(-1)).toBe("ECON 342 vence en 3 días: midterm");
  });

  it("no cuenta lo hecho ni lo de otros días en la agenda", () => {
    const c = ctx(9 * 60, {
      events: [ev("mañana", 10 * 60, 11 * 60, "2026-10-02")],
      tasks: [task({ kind: "midterm", course: "ECON 342", due_date: "2026-10-02", done: true })],
    });
    expect(c.next).toBeNull();
    expect(c.deadline).toBeNull();
  });
});

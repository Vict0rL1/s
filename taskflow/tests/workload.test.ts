import { describe, expect, it } from "vitest";
import { dayLoad, upcomingWorkload } from "@/lib/workload";
import type { Task } from "@/lib/types";

const HOY = "2026-10-01"; // jueves

let n = 0;
const t = (over: Partial<Task>): Task => ({
  id: String(++n), user_id: "u", title: "x", area: null, due_date: null, due_time: null, est_minutes: null,
  priority: 3, done: false, done_at: null, body: null, source: "manual", external_id: null, external_url: null,
  focus_day: null, user_edited_at: null, deleted_at: null, kind: null, course: null, weight_pct: null,
  difficulty: null, tracked_sec: 0, track_sessions: 0, track_started_at: null, created_at: "", updated_at: "", ...over,
});

describe("upcomingWorkload", () => {
  it("cuenta lo importante de los próximos 14 días, en el orden de siempre", () => {
    const w = upcomingWorkload(
      [
        t({ kind: "midterm", due_date: "2026-10-08" }),
        t({ kind: "project", due_date: "2026-10-14" }), // último día de la ventana
        t({ kind: "midterm", due_date: "2026-10-05" }),
        t({ kind: "assignment", due_date: "2026-10-03" }),
        t({ kind: "final", due_date: "2026-10-15" }), // fuera: día 15
        t({ kind: "quiz", due_date: "2026-09-30" }), // ya pasó
        t({ kind: "midterm", due_date: "2026-10-06", done: true }), // hecho
        t({ kind: "midterm", due_date: "2026-10-06", deleted_at: "2026-09-30T00:00:00Z" }), // en la papelera
      ],
      HOY,
    );
    expect(w.line).toBe("Próximos 14 días: 2 midterms + 1 proyecto");
    expect(w.majors.map((m) => m.due_date)).toEqual(["2026-10-05", "2026-10-08", "2026-10-14"]);
    expect(w.others).toBe(1);
  });

  it("sin nada importante y pocas entregas, no dice nada", () => {
    expect(upcomingWorkload([t({ kind: "assignment", due_date: "2026-10-03" })], HOY).line).toBeNull();
  });

  it("muchas entregas juntas también se dicen", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => t({ due_date: `2026-10-0${i + 2}` }));
    expect(upcomingWorkload(tasks, HOY).line).toBe("Próximos 14 días: 5 entregas");
  });

  it("una tarea sin tipo no se adivina: cuenta como entrega", () => {
    const w = upcomingWorkload([t({ title: "Midterm review", due_date: "2026-10-03" })], HOY);
    expect(w.majors).toEqual([]);
    expect(w.others).toBe(1);
  });

  it("suma sólo los pesos que conoce y dice cuántos eran", () => {
    const w = upcomingWorkload(
      [
        t({ kind: "midterm", due_date: "2026-10-05", weight_pct: 25 }),
        t({ kind: "project", due_date: "2026-10-09", weight_pct: 12.5 }),
        t({ kind: "quiz", due_date: "2026-10-09" }),
      ],
      HOY,
    );
    expect(w.weight).toEqual({ pct: 37.5, known: 2 });
  });

  it("marca las semanas con dos o más cosas importantes", () => {
    const w = upcomingWorkload(
      [
        t({ kind: "midterm", due_date: "2026-10-05" }), // lunes 5
        t({ kind: "presentation", due_date: "2026-10-09" }), // viernes 9, misma semana
        t({ kind: "quiz", due_date: "2026-10-13" }), // semana siguiente, sola
      ],
      HOY,
    );
    expect(w.heavyWeeks).toEqual([{ monday: "2026-10-05", count: 2, kinds: "1 midterm + 1 presentación" }]);
  });
});

describe("dayLoad", () => {
  const D = "2026-10-05";
  const ev = (start: number | null, end: number | null, day = D) => ({ day, start, end });
  const bl = (start_min: number, end_min: number, day = D) => ({ day, start_min, end_min });
  const load = (events: ReturnType<typeof ev>[], blocks: ReturnType<typeof bl>[] = []) =>
    dayLoad({ day: D, dayStart: 7, dayEnd: 23, events, blocks });

  it("un día sin nada, o con menos de una hora, es libre", () => {
    expect(load([])).toMatchObject({ level: 0, minutes: 0, label: "Carga del día: libre" });
    expect(load([ev(600, 650)]).level).toBe(0);
  });

  it("lo que se pisa no cuenta dos veces", () => {
    // Clase 10:00–12:00 y un bloque 11:00–13:00: tres horas, no cuatro.
    expect(load([ev(600, 720)], [bl(660, 780)]).minutes).toBe(180);
  });

  it("sólo cuenta lo que cae dentro de tu horario, y nada de otros días", () => {
    expect(load([ev(360, 480), ev(1350, 1440), ev(600, 700, "2026-10-06")]).minutes).toBe(60 + 30);
  });

  it("los eventos de todo el día no ocupan horas", () => {
    expect(load([ev(null, null)]).minutes).toBe(0);
  });

  it("tres niveles por proporción del día, con las horas redondeadas a la media hora", () => {
    // Ventana 7–23: 16 h.
    expect(load([ev(600, 700)])).toMatchObject({ level: 1, label: "Carga del día: ligero, unas 1,5 h ocupadas" });
    expect(load([ev(480, 780)])).toMatchObject({ level: 2, word: "medio" });
    expect(load([ev(480, 960)])).toMatchObject({ level: 3, label: "Carga del día: lleno, unas 8 h ocupadas" });
  });

  it("una clase sin hora de fin cuenta una hora, igual que en la agenda", () => {
    expect(load([ev(600, null)]).minutes).toBe(60);
  });
});

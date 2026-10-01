import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/date";
import {
  PREP_DAY_CAP,
  PREP_LAST_DAY_CAP,
  type DayWindow,
  dayWindows,
  findSlot,
  lightestFirst,
  overlaps,
  planPrep,
  replanDays,
} from "@/lib/schedule";

const HOY = "2026-10-01"; // jueves

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));

function windows(n: number, busyFor: (day: string) => { start: number; end: number; title: string }[] = () => [], nowMin = 8 * 60) {
  const ds = days(HOY, n);
  return dayWindows({
    days: ds, today: HOY, nowMin, dayStart: 8, dayEnd: 22,
    events: ds.flatMap((day) => busyFor(day).map((b) => ({ day, ...b }))),
    blocks: [],
  });
}

describe("dayWindows y findSlot", () => {
  it("hoy empieza ahora, redondeado al cuarto de hora", () => {
    const w = windows(2, () => [], 14 * 60 + 7);
    expect(w[0]).toMatchObject({ day: HOY, from: 14 * 60 + 15 });
    expect(w[1].from).toBe(8 * 60);
  });

  it("el primer hueco que cabe, explicando dónde cae", () => {
    const w = windows(1, () => [{ start: 8 * 60, end: 10 * 60, title: "ECON 342" }]);
    expect(findSlot(w, 90)).toEqual({ day: HOY, start: 600, end: 690, why: "después de ECON 342, hueco de 12 h" });
  });

  it("si no cabe en ningún lado, null", () => {
    expect(findSlot(windows(1, () => [{ start: 8 * 60, end: 22 * 60, title: "todo el día" }]), 30)).toBeNull();
  });
});

describe("planPrep", () => {
  const due = addDays(HOY, 12); // 13 oct

  it("nunca el día del deadline ni después; el día antes, sólo un repaso corto", () => {
    const r = planPrep({ windows: windows(20), dueDate: due, totalMin: 600, sessionMin: 90, otherDeadlines: [] });
    expect(r.sessions.every((s) => s.day < due)).toBe(true);
    const ultimo = r.sessions.filter((s) => s.day === addDays(due, -1));
    expect(ultimo.reduce((a, s) => a + s.minutes, 0)).toBeLessThanOrEqual(PREP_LAST_DAY_CAP);
    expect(ultimo.every((s) => s.review)).toBe(true);
    expect(r.shortfall).toBe(0);
  });

  it("4 sesiones en 12 días quedan repartidas, no amontonadas al principio", () => {
    const r = planPrep({ windows: windows(12), dueDate: due, totalMin: 240, sessionMin: 60, otherDeadlines: [] });
    expect(r.sessions.map((s) => s.day)).toEqual(["2026-10-01", "2026-10-05", "2026-10-08", "2026-10-12"]);
  });

  it("respeta otros deadlines: nada ese día, poco el día antes", () => {
    const otro = "2026-10-06";
    const r = planPrep({
      windows: windows(12), dueDate: due, totalMin: 900, sessionMin: 60,
      otherDeadlines: [{ day: otro, title: "«PS5»" }],
    });
    expect(r.sessions.some((s) => s.day === otro)).toBe(false);
    const antes = r.sessions.filter((s) => s.day === addDays(otro, -1));
    expect(antes.reduce((a, s) => a + s.minutes, 0)).toBeLessThanOrEqual(60);
    expect(antes[0]?.why).toMatch(/mañana vence «PS5»/);
  });

  it("si no cabe todo, dice cuánto falta en vez de esconderlo", () => {
    const lleno = (day: string) => (day === HOY ? [] : [{ start: 8 * 60, end: 22 * 60, title: "ocupado" }]);
    const r = planPrep({ windows: windows(5, lleno), dueDate: addDays(HOY, 4), totalMin: 600, sessionMin: 60, otherDeadlines: [] });
    expect(r.sessions.reduce((a, s) => a + s.minutes, 0)).toBe(PREP_DAY_CAP);
    expect(r.shortfall).toBe(600 - PREP_DAY_CAP);
  });

  it("el mismo día y la misma agenda dan siempre el mismo plan", () => {
    const a = planPrep({ windows: windows(10), dueDate: due, totalMin: 420, sessionMin: 90, otherDeadlines: [] });
    const b = planPrep({ windows: windows(10), dueDate: due, totalMin: 420, sessionMin: 90, otherDeadlines: [] });
    expect(a).toEqual(b);
  });

  it("propiedades, sobre 300 agendas al azar (con semilla)", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

    for (let caso = 0; caso < 300; caso++) {
      const n = 2 + Math.floor(rnd() * 14);
      const dueDate = addDays(HOY, n);
      const busy = new Map<string, { start: number; end: number; title: string }[]>();
      for (const d of days(HOY, n + 2)) {
        const k = Math.floor(rnd() * 4);
        busy.set(d, Array.from({ length: k }, () => {
          const s = 480 + Math.floor(rnd() * 48) * 15;
          return { start: s, end: Math.min(1320, s + 30 + Math.floor(rnd() * 8) * 15), title: "x" };
        }));
      }
      const ws: DayWindow[] = windows(n + 2, (d) => busy.get(d) ?? [], 8 * 60 + Math.floor(rnd() * 600));
      const otherDeadlines = rnd() < 0.5 ? [{ day: addDays(HOY, Math.floor(rnd() * n)), title: "otro" }] : [];
      const total = 30 + Math.floor(rnd() * 40) * 15;
      const r = planPrep({ windows: ws, dueDate, totalMin: total, sessionMin: 30 + Math.floor(rnd() * 4) * 15, otherDeadlines });

      const placed = r.sessions.reduce((a, s) => a + s.minutes, 0);
      expect(placed + r.shortfall).toBe(total);
      for (const s of r.sessions) {
        expect(s.day < dueDate).toBe(true);
        expect(s.end - s.start).toBe(s.minutes);
        const w = ws.find((x) => x.day === s.day)!;
        expect(s.start >= w.from && s.end <= w.to).toBe(true);
        expect(w.busy.some((b) => overlaps(b, s))).toBe(false);
        expect(otherDeadlines.some((o) => o.day === s.day)).toBe(false);
      }
      // Ninguna sesión pisa a otra.
      for (const a of r.sessions) for (const b of r.sessions) {
        if (a !== b && a.day === b.day) expect(overlaps(a, b)).toBe(false);
      }
      // Topes por día.
      const porDia = new Map<string, number>();
      for (const s of r.sessions) porDia.set(s.day, (porDia.get(s.day) ?? 0) + s.minutes);
      for (const [d, m] of porDia) expect(m).toBeLessThanOrEqual(d === addDays(dueDate, -1) ? PREP_LAST_DAY_CAP : PREP_DAY_CAP);
    }
  });
});

describe("replanificar", () => {
  it("cada opción busca en sus días, y nunca después del deadline", () => {
    expect(replanDays("today", HOY)).toEqual([HOY]);
    expect(replanDays("tomorrow", HOY)).toEqual(["2026-10-02"]);
    expect(replanDays("week", HOY)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(replanDays("week", HOY, { due: "2026-10-03" })).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(replanDays("tomorrow", HOY, { due: "2026-10-01" })).toEqual([]); // vence hoy: mañana ya es tarde
    expect(replanDays("tomorrow", HOY, { due: "2026-09-25" })).toEqual(["2026-10-02"]); // atrasada: sin límite
    expect(replanDays("date", HOY, { date: "2026-10-09" })).toEqual(["2026-10-09"]);
    expect(replanDays("date", HOY, { date: "2026-09-20" })).toEqual([]); // en el pasado, no
    expect(replanDays("auto", HOY)).toHaveLength(14);
  });

  it("'esta semana' prueba primero el día más liviano", () => {
    const w = windows(3, (d) => (d === HOY ? [{ start: 480, end: 1200, title: "x" }] : d === "2026-10-02" ? [{ start: 480, end: 600, title: "y" }] : []));
    expect(lightestFirst(w).map((x) => x.day)).toEqual(["2026-10-03", "2026-10-02", HOY]);
  });
});

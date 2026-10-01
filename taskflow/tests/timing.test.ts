import { describe, expect, it } from "vitest";
import { MAX_SESSION_SEC, elapsedSec, estimateStats, fmtClockSec, statsLine, trackedTotal } from "@/lib/timing";
import type { Task } from "@/lib/types";

let n = 0;
const t = (over: Partial<Task>): Task => ({
  id: String(++n), user_id: "u", title: "x", area: null, due_date: null, due_time: null, est_minutes: null,
  priority: 3, done: true, done_at: null, body: null, source: "manual", external_id: null, external_url: null,
  focus_day: null, user_edited_at: null, deleted_at: null, kind: null, course: null, weight_pct: null,
  difficulty: null, tracked_sec: 0, track_sessions: 0, track_started_at: null, created_at: "", updated_at: "", ...over,
});

const NOW = Date.parse("2026-10-01T18:00:00Z");

describe("cronómetro", () => {
  it("cuenta lo que va de la sesión", () => {
    expect(elapsedSec("2026-10-01T17:35:00Z", NOW)).toEqual({ sec: 25 * 60, capped: false });
    expect(trackedTotal({ tracked_sec: 600, track_started_at: "2026-10-01T17:50:00Z" }, NOW)).toBe(600 + 600);
    expect(trackedTotal({ tracked_sec: 600, track_started_at: null }, NOW)).toBe(600);
  });

  it("un cronómetro olvidado toda la noche no cuenta como 14 h de trabajo", () => {
    expect(elapsedSec("2026-10-01T04:00:00Z", NOW)).toEqual({ sec: MAX_SESSION_SEC, capped: true });
  });

  it("un reloj adelantado no da tiempo negativo", () => {
    expect(elapsedSec("2026-10-01T18:05:00Z", NOW).sec).toBe(0);
  });

  it("formato", () => {
    expect(fmtClockSec(59)).toBe("0:59");
    expect(fmtClockSec(25 * 60 + 3)).toBe("25:03");
    expect(fmtClockSec(3600 + 5 * 60 + 9)).toBe("1:05:09");
  });
});

describe("estimado frente a real", () => {
  it("con menos de 3 muestras, no dice nada", () => {
    expect(estimateStats([t({ est_minutes: 60, tracked_sec: 4000 }), t({ est_minutes: 60, tracked_sec: 4000 })])).toBeNull();
  });

  it("usa medianas: una tarea que se fue de las manos no tuerce el resultado", () => {
    const s = estimateStats([
      t({ est_minutes: 60, tracked_sec: 80 * 60 }),
      t({ est_minutes: 60, tracked_sec: 82 * 60 }),
      t({ est_minutes: 45, tracked_sec: 90 * 60 }),
      t({ est_minutes: 60, tracked_sec: 600 * 60 }), // el desastre
    ])!;
    expect(s).toMatchObject({ samples: 4, est: 60, real: 86 });
    expect(statsLine({ est: 60, real: 82 })).toBe("Sueles estimar 60 min y tardar 82 min (37% más).");
  });

  it("ignora lo pendiente, lo sin estimado y los clics sin querer", () => {
    const s = estimateStats([
      t({ est_minutes: 30, tracked_sec: 30 * 60 }),
      t({ est_minutes: 30, tracked_sec: 30 * 60 }),
      t({ est_minutes: 30, tracked_sec: 30 * 60 }),
      t({ est_minutes: 30, tracked_sec: 30 * 60, done: false }),
      t({ est_minutes: null, tracked_sec: 90 * 60 }),
      t({ est_minutes: 30, tracked_sec: 60 }),
    ])!;
    expect(s.samples).toBe(3);
    expect(statsLine(s)).toBe("Sueles estimar 30 min y tardar 30 min (bastante cerca).");
  });

  it("por tipo, sólo con 3 o más de ese tipo", () => {
    const s = estimateStats([
      ...Array.from({ length: 3 }, () => t({ kind: "reading" as const, est_minutes: 30, tracked_sec: 45 * 60 })),
      t({ kind: "quiz", est_minutes: 20, tracked_sec: 20 * 60 }),
    ])!;
    expect(s.byKind).toEqual([{ kind: "reading", samples: 3, est: 30, real: 45 }]);
  });
});

import { describe, expect, it } from "vitest";
import {
  type Ctx,
  loadBlocks,
  loadCounts,
  loadEvents,
  loadHabitLog,
  loadHabits,
  loadIcsSources,
  loadNotes,
  loadSyncState,
  loadTasks,
} from "@/lib/data";
import { fakeSupabase, filtersBy } from "./helpers/fake-supabase";

const USER = "11111111-1111-4111-8111-111111111111";

function ctxWith(client: unknown): Ctx {
  return {
    supabase: client as Ctx["supabase"],
    userId: USER,
    profile: {
      id: USER,
      areas: ["SFU"],
      day_start: 7,
      day_end: 23,
      timezone: "America/Vancouver",
      created_at: "2026-09-01T00:00:00Z",
    },
    tz: "America/Vancouver",
    today: "2026-09-30",
  };
}

/**
 * El reloj (`/api/sync`) llama a estos mismos cargadores con la service role,
 * que SALTA la RLS. Si una consulta no lleva su `user_id`, el aviso de un
 * usuario sale con las tareas de todos. Pasó: `loadTasks` no filtraba.
 */
describe("los cargadores filtran por user_id aunque la RLS no esté", () => {
  const casos: [string, (ctx: Ctx) => Promise<unknown>][] = [
    ["loadTasks", (c) => loadTasks(c)],
    ["loadEvents", (c) => loadEvents(c, "2026-09-30", "2026-10-01")],
    ["loadIcsSources", (c) => loadIcsSources(c)],
    ["loadNotes", (c) => loadNotes(c)],
    ["loadHabits", (c) => loadHabits(c)],
    ["loadHabitLog", (c) => loadHabitLog(c, "2026-09-01", "2026-09-30")],
    ["loadBlocks", (c) => loadBlocks(c, "2026-09-30", "2026-09-30")],
    ["loadSyncState", (c) => loadSyncState(c, "canvas")],
    ["loadCounts", (c) => loadCounts(c)],
  ];

  for (const [nombre, cargar] of casos) {
    it(nombre, async () => {
      const { client, queries } = fakeSupabase();
      await cargar(ctxWith(client));

      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) {
        expect(filtersBy(q, "user_id", USER), `${nombre} → ${q.table} sin user_id`).toBe(true);
      }
    });
  }
});

import { describe, expect, it } from "vitest";
import { canvasSyncDue } from "@/lib/canvas";
import { isFailing, recordRun } from "@/lib/sync-state";
import type { Ctx } from "@/lib/data";
import { fakeSupabase } from "./helpers/fake-supabase";

const H = 3600_000;
const NOW = Date.parse("2026-10-01T18:00:00Z");

describe("canvasSyncDue", () => {
  it("sin ningún sync bueno, toca", () => {
    expect(canvasSyncDue(null, NOW)).toBe(true);
  });

  it("con uno bueno hace menos de 3 h, no toca", () => {
    expect(canvasSyncDue(new Date(NOW - 2 * H).toISOString(), NOW)).toBe(false);
  });

  it("con uno bueno hace 3 h o más, toca", () => {
    expect(canvasSyncDue(new Date(NOW - 3 * H).toISOString(), NOW)).toBe(true);
  });

  it("una fecha corrupta no bloquea el sync para siempre", () => {
    expect(canvasSyncDue("no-es-fecha", NOW)).toBe(true);
  });
});

describe("isFailing", () => {
  it("un error más nuevo que el último éxito es un fallo vigente", () => {
    expect(isFailing({ last_error_at: "2026-10-01T10:00:00Z", last_success_at: "2026-09-30T10:00:00Z" })).toBe(true);
    expect(isFailing({ last_error_at: "2026-10-01T10:00:00Z", last_success_at: null })).toBe(true);
  });

  it("un error viejo ya se resolvió", () => {
    expect(isFailing({ last_error_at: "2026-09-29T10:00:00Z", last_success_at: "2026-10-01T10:00:00Z" })).toBe(false);
    expect(isFailing({ last_error_at: null, last_success_at: null })).toBe(false);
    expect(isFailing(null)).toBe(false);
  });
});

describe("recordRun", () => {
  async function run(outcome: Parameters<typeof recordRun>[3]) {
    let row: Record<string, unknown> = {};
    const { client, queries } = fakeSupabase((q) => {
      const up = q.calls.find((c) => c.method === "upsert");
      row = up?.args[0] as Record<string, unknown>;
      return { data: null, error: null };
    });
    await recordRun(client as unknown as Ctx["supabase"], "u1", "canvas", outcome);
    expect(queries[0].table).toBe("sync_state");
    return row;
  }

  it("un fallo no toca last_success_at: es el dato que dice desde cuándo no anda", async () => {
    const row = await run({ ok: false, error: "token vencido", code: "CANVAS_TOKEN_EXPIRED" });
    expect(row).not.toHaveProperty("last_success_at");
    expect(row).not.toHaveProperty("items_synced");
    expect(row).toMatchObject({ user_id: "u1", source: "canvas", last_error: "token vencido", last_error_code: "CANVAS_TOKEN_EXPIRED" });
    expect(row.last_synced_at).toBe(row.last_error_at);
  });

  it("un éxito pone last_success_at y el conteo", async () => {
    const row = await run({ ok: true, items: 12 });
    expect(row).toMatchObject({ user_id: "u1", source: "canvas", items_synced: 12 });
    expect(row.last_success_at).toBe(row.last_synced_at);
    expect(row).not.toHaveProperty("last_error");
  });
});

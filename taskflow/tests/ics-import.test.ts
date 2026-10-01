import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctxFor, fakeProject } from "./helpers/supa";
import { fakeSupabase } from "./helpers/fake-supabase";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
}));

import { importIcs } from "@/app/actions";

const A = "a@ejemplo.com";

function ics(events: { uid: string; summary: string; start: string; end: string }[]) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `SUMMARY:${e.summary}`,
      `DTSTART:${e.start}`,
      `DTEND:${e.end}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
}

const fd = (text: string) => {
  const f = new FormData();
  f.set("text", text);
  f.set("name", "Horario");
  return f;
};

let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;

beforeEach(async () => {
  p = await fakeProject([A]);
  uid = p.id(A);
  state.ctx = ctxFor(p.as(A), uid, "2026-09-30");
});

const events = async () =>
  ((await p.admin.from("events").select("title, starts_at, ends_at").eq("user_id", uid).order("title")).data ?? []);

describe("importar un .ics", () => {
  it("reimportar actualiza lo que cambió y quita lo que ya no está", async () => {
    await importIcs(null, fd(ics([
      { uid: "a", summary: "ECON 342", start: "20261005T170000Z", end: "20261005T183000Z" },
      { uid: "b", summary: "ECON 370", start: "20261006T170000Z", end: "20261006T183000Z" },
    ])));
    expect(await events()).toHaveLength(2);

    const r = await importIcs(null, fd(ics([
      { uid: "a", summary: "ECON 342 (sala nueva)", start: "20261005T180000Z", end: "20261005T193000Z" },
    ])));
    expect(r.ok).toBe(true);
    const after = await events();
    expect(after).toHaveLength(1);
    expect(after[0].title).toBe("ECON 342 (sala nueva)");
    expect(after[0].starts_at).toContain("18:00:00");
  });

  it("un evento que termina antes de empezar no tumba la importación", async () => {
    const r = await importIcs(null, fd(ics([
      { uid: "a", summary: "raro", start: "20261005T180000Z", end: "20261005T170000Z" },
      { uid: "b", summary: "normal", start: "20261006T170000Z", end: "20261006T180000Z" },
    ])));
    expect(r.ok).toBe(true);
    const ev = await events();
    expect(ev).toHaveLength(2);
    // Sea cual sea la corrección (el parser le pone un fin propio), la fila
    // queda válida: nunca termina antes de empezar.
    const raro = ev.find((e) => e.title === "raro")!;
    expect(raro.ends_at === null || raro.ends_at >= raro.starts_at!).toBe(true);
  });

  it("si guardar falla, lo que ya tenías sigue intacto", async () => {
    await importIcs(null, fd(ics([{ uid: "a", summary: "ECON 342", start: "20261005T170000Z", end: "20261005T183000Z" }])));

    // La misma sesión, pero el upsert de eventos falla.
    const { client, queries } = fakeSupabase((q) =>
      q.calls.some((c) => c.method === "upsert") ? { data: null, error: { message: "boom" } } : { data: [], error: null },
    );
    state.ctx = ctxFor(client, uid, "2026-09-30");
    const r = await importIcs(null, fd(ics([{ uid: "z", summary: "otro", start: "20261007T170000Z", end: "20261007T180000Z" }])));

    expect(r.ok).toBe(false);
    expect(queries.some((q) => q.calls.some((c) => c.method === "delete"))).toBe(false);
    expect((await events()).map((e) => e.title)).toEqual(["ECON 342"]);
  });
});

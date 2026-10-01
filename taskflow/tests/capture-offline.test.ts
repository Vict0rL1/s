import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
}));

import { capture } from "@/app/actions";
import { config } from "@/proxy";
import { ctxFor, fakeProject } from "./helpers/supa";

const A = "a@ejemplo.com";
let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;

beforeEach(async () => {
  p = await fakeProject([A]);
  uid = p.id(A);
  state.ctx = ctxFor(p.as(A), uid, "2026-10-01");
});

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("captura con id del navegador", () => {
  it("subir dos veces la misma captura (la cola sin conexión, un reintento) no la duplica", async () => {
    const cid = "6f1c2b3a-1111-4222-8333-944455556666";
    const r1 = await capture(null, fd({ text: "Leer cap 4 vie 45m", mode: "tarea", cid }));
    const r2 = await capture(null, fd({ text: "Leer cap 4 vie 45m", mode: "tarea", cid }));
    expect(r1).toMatchObject({ ok: true, message: "Tarea agregada" });
    expect(r2).toMatchObject({ ok: true, message: "Esa tarea ya estaba guardada" });
    expect((await p.admin.from("tasks").select("id").eq("user_id", uid)).data).toEqual([{ id: cid }]);
  });

  it("también para notas", async () => {
    const cid = "6f1c2b3a-1111-4222-8333-944455557777";
    await capture(null, fd({ text: "idea", mode: "nota", cid }));
    await capture(null, fd({ text: "idea", mode: "nota", cid }));
    expect((await p.admin.from("notes").select("id").eq("user_id", uid)).data).toHaveLength(1);
  });

  it("un id que no es UUID se ignora y la base pone el suyo", async () => {
    await capture(null, fd({ text: "x", mode: "tarea", cid: "'; drop table tasks; --" }));
    expect((await p.admin.from("tasks").select("id").eq("user_id", uid)).data).toHaveLength(1);
  });
});

describe("el proxy deja pasar sin sesión lo que el navegador pide sin cookies", () => {
  const re = new RegExp("^" + config.matcher[0] + "$");
  it.each(["/offline.html", "/sw.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/maskable-512.png", "/apple-icon.png", "/icon.svg"])(
    "%s queda fuera del proxy",
    (path) => expect(re.test(path)).toBe(false),
  );
  it.each(["/hoy", "/tareas", "/ajustes/estado", "/api/sync"])("%s pasa por el proxy", (path) => expect(re.test(path)).toBe(true));
});

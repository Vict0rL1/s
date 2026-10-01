import { describe, expect, it } from "vitest";
import { loadTasks } from "@/lib/data";
import { ctxFor, fakeProject } from "./helpers/supa";

/** El harness tiene que comportarse como Supabase en lo que la app usa. */
describe("proyecto de Supabase en memoria", () => {
  it("la sesión ve sólo lo suyo; la service role ve todo y filtra a mano", async () => {
    const p = await fakeProject();
    const A = p.id("a@ejemplo.com"), B = p.id("b@ejemplo.com");

    const ins = await p.as("a@ejemplo.com").from("tasks").insert({ user_id: A, title: "de A" });
    expect(ins.error).toBeNull();
    await p.as("b@ejemplo.com").from("tasks").insert({ user_id: B, title: "de B" });

    // Con sesión, la RLS separa.
    const deB = await loadTasks(ctxFor(p.as("b@ejemplo.com"), B));
    expect(deB.map((t) => t.title)).toEqual(["de B"]);

    // Con la service role, sólo el filtro de la app separa — y separa.
    const adminA = await loadTasks(ctxFor(p.admin, A));
    expect(adminA.map((t) => t.title)).toEqual(["de A"]);

    // B no puede escribir a nombre de A.
    const intruso = await p.as("b@ejemplo.com").from("tasks").insert({ user_id: A, title: "x" });
    expect(intruso.error).not.toBeNull();
  });

  it("un filtro desconocido revienta en vez de ignorarse", async () => {
    const p = await fakeProject();
    const r = await p.admin.from("tasks").select("*").filter("title", "cs", "{x}");
    expect(r.error).not.toBeNull();
  });
});

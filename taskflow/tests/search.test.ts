import { beforeEach, describe, expect, it } from "vitest";
import { fold, likeSafe, toTsQuery } from "@/lib/search-query";
import { search } from "@/lib/search";
import { ctxFor, fakeProject } from "./helpers/supa";

describe("de lo escrito a un tsquery", () => {
  it("minúsculas, sin acentos, cada palabra como prefijo", () => {
    expect(toTsQuery("Lección Midt")).toBe("leccion:* & midt:*");
    expect(fold("Presentación Ñandú")).toBe("presentacion nandu");
  });

  it("nada de lo escrito llega crudo: sin operadores ni símbolos", () => {
    expect(toTsQuery("a & b | !c :*")).toBe("a:* & b:* & c:*");
    expect(toTsQuery("&&&")).toBeNull();
    expect(toTsQuery("")).toBeNull();
    expect(likeSafe("50% _x_ (a,b)")).toBe("50   x   a b");
  });

  it("como mucho 6 palabras", () => {
    expect(toTsQuery("a b c d e f g h")!.split(" & ")).toHaveLength(6);
  });
});

describe("búsqueda contra la base", () => {
  const A = "a@ejemplo.com", B = "b@ejemplo.com";
  let p: Awaited<ReturnType<typeof fakeProject>>;
  let ctx: ReturnType<typeof ctxFor>;

  beforeEach(async () => {
    p = await fakeProject([A, B]);
    const a = p.id(A), b = p.id(B);
    ctx = ctxFor(p.as(A), a);
    await p.as(A).from("tasks").insert([
      { user_id: a, title: "Midterm 1", course: "ECON 342", body: null, deleted_at: null },
      { user_id: a, title: "Lección de práctica", course: "ECON 260", body: null, deleted_at: null },
      { user_id: a, title: "Midterm viejo", course: null, body: null, deleted_at: "2026-09-01T00:00:00Z" },
    ]);
    await p.as(A).from("notes").insert({ user_id: a, body: "Idea para el midterm: repasar elasticidades" });
    await p.as(A).from("habits").insert({ user_id: a, name: "Repasar econometría" });
    await p.as(B).from("tasks").insert({ user_id: b, title: "Midterm de B", course: "ECON 342" });
  });

  it("encuentra por prefijo y sin acentos, en tareas y notas", async () => {
    const r = await search(ctx, "midt");
    expect(r.tasks.map((t) => t.title)).toEqual(["Midterm 1"]);
    expect(r.notes[0].excerpt).toMatch(/Idea para el midterm/);
    expect((await search(ctx, "leccion practica")).tasks.map((t) => t.title)).toEqual(["Lección de práctica"]);
  });

  it("busca también por curso y en las rutinas", async () => {
    expect((await search(ctx, "econ 342")).tasks.map((t) => t.title)).toEqual(["Midterm 1"]);
    expect((await search(ctx, "econ")).courses).toEqual(["ECON 260", "ECON 342"]);
    expect((await search(ctx, "repasar")).habits.map((h) => h.name)).toEqual(["Repasar econometría"]);
  });

  it("no trae lo de la papelera ni lo de otra cuenta", async () => {
    const r = await search(ctx, "midterm");
    expect(r.tasks.map((t) => t.title)).toEqual(["Midterm 1"]);
  });

  it("una entrada rara no rompe nada", async () => {
    for (const q of ["'); drop table tasks; --", "a:*|b", "%%%", "(", "m"]) {
      await expect(search(ctx, q)).resolves.toBeTruthy();
    }
    expect((await search(ctx, "midterm")).tasks).toHaveLength(1);
  });
});

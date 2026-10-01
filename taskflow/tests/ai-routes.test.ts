import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Con la sesión vencida, las rutas de la IA responden 401 en JSON. Antes
 * redirigían al login y el navegador recibía HTML donde esperaba JSON.
 */
afterEach(() => {
  vi.doUnmock("@/lib/data");
  vi.resetModules();
});

async function withoutSession<T>(path: string): Promise<T> {
  vi.resetModules();
  process.env.ANTHROPIC_API_KEY = "sk-ant-de-prueba-que-no-se-usa";
  vi.doMock("@/lib/data", async (orig) => ({
    ...(await orig<typeof import("@/lib/data")>()),
    getApiCtx: async () => null,
  }));
  return (await import(path)) as T;
}

describe("rutas de la IA sin sesión", () => {
  it("/api/plan → 401 JSON", async () => {
    const { POST } = await withoutSession<{ POST: () => Promise<Response> }>("@/app/api/plan/route");
    const r = await POST();
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect((await r.json()).message).toMatch(/sesión/);
  });

  it("/api/breakdown → 401 JSON", async () => {
    const { POST } = await withoutSession<{ POST: (r: Request) => Promise<Response> }>("@/app/api/breakdown/route");
    const r = await POST(new Request("https://x/api/breakdown", { method: "POST", body: "{}" }));
    expect(r.status).toBe(401);
  });
});

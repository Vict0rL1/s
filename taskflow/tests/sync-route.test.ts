import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeProject } from "./helpers/supa";

/**
 * La ruta del reloj. `env.server` lee las variables al cargarse, así que cada
 * prueba arma su entorno y carga la ruta de cero.
 */
async function loadRoute(env: Record<string, string | undefined>, admin?: unknown) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (admin) vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
  return (await import("@/app/api/sync/route")).GET;
}

const SECRET = "secreto-del-reloj-de-prueba-1234567890";
const call = (GET: (r: Request) => Promise<Response>, auth?: string) =>
  GET(new Request("https://taskflow.prueba/api/sync", { headers: auth ? { authorization: auth } : {} }));

afterEach(() => {
  vi.doUnmock("@/lib/supabase/admin");
  vi.restoreAllMocks();
});

describe("GET /api/sync", () => {
  it("sin CRON_SECRET en el servidor, 503 y la ruta no hace nada", async () => {
    const GET = await loadRoute({ CRON_SECRET: undefined });
    const r = await call(GET, "Bearer cualquiera");
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("CRON_CONFIG_MISSING");
  });

  it("sin cabecera o con el secreto equivocado, 401 y queda en el log", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const GET = await loadRoute({ CRON_SECRET: SECRET });
    expect((await call(GET)).status).toBe(401);
    const r = await call(GET, "Bearer " + SECRET.slice(0, -1) + "x");
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe("CRON_AUTH_FAILED");
    const logged = err.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(logged.every((l) => l.errorCode === "CRON_AUTH_FAILED")).toBe(true);
    // El log no repite lo que mandó quien llamaba, ni el secreto.
    expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET.slice(0, 20));
  });

  it("sin la service role, 503 con un mensaje claro en vez de un 500 mudo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const GET = await loadRoute({ CRON_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: undefined });
    const r = await call(GET, "Bearer " + SECRET);
    expect(r.status).toBe(503);
    expect((await r.json()).message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("con todo en orden, corre y responde 200 con una línea por perfil", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const p = await fakeProject(["a@ejemplo.com"]);
    const GET = await loadRoute(
      { CRON_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: "presente", CANVAS_TOKEN: undefined },
      p.admin,
    );
    const r = await call(GET, "Bearer " + SECRET);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, perfiles: 1 });
  });
});

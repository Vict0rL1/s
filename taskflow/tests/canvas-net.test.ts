import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasError, canvasGet, canvasGetAll } from "@/lib/canvas";

const TOKEN = "7~token-de-canvas-de-prueba-0123456789";
const URL_ = "https://canvas.sfu.ca/api/v1/planner/items?per_page=100";
const FAST = { backoffMs: 0 };

afterEach(() => vi.unstubAllGlobals());

/** Respuestas en orden; la última se repite si piden más. */
function mockFetch(...responses: (Response | Error | (() => Promise<Response>))[]) {
  let i = 0;
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r();
    return r.clone();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

async function falla(p: Promise<unknown>): Promise<CanvasError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CanvasError);
    // Ningún mensaje lleva el token, pase lo que pase.
    expect((e as Error).message).not.toContain(TOKEN);
    return e as CanvasError;
  }
  throw new Error("se esperaba un error");
}

describe("canvasGet clasifica los fallos", () => {
  it("401 es token vencido y no se reintenta", async () => {
    const f = mockFetch(new Response("", { status: 401 }));
    const e = await falla(canvasGet(URL_, TOKEN, FAST));
    expect(e.code).toBe("CANVAS_TOKEN_EXPIRED");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("403 con 'Rate Limit Exceeded' es límite de peticiones, no token malo", async () => {
    const f = mockFetch(new Response("403 Forbidden (Rate Limit Exceeded)", { status: 403 }));
    const e = await falla(canvasGet(URL_, TOKEN, FAST));
    expect(e.code).toBe("CANVAS_RATE_LIMITED");
    expect(f).toHaveBeenCalledTimes(2); // un reintento
  });

  it("403 con X-Rate-Limit-Remaining en 0 también", async () => {
    mockFetch(new Response("", { status: 403, headers: { "x-rate-limit-remaining": "0.0" } }));
    expect((await falla(canvasGet(URL_, TOKEN, FAST))).code).toBe("CANVAS_RATE_LIMITED");
  });

  it("un 403 cualquiera es falta de permiso", async () => {
    const f = mockFetch(new Response("unauthorized", { status: 403 }));
    expect((await falla(canvasGet(URL_, TOKEN, FAST))).code).toBe("CANVAS_FORBIDDEN");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("429 se reintenta y, si al segundo intento contesta, sale bien", async () => {
    const f = mockFetch(new Response("", { status: 429 }), json([{ id: 1 }]));
    const r = await canvasGet(URL_, TOKEN, FAST);
    expect(r.items).toEqual([{ id: 1 }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("500 es Canvas caído", async () => {
    const f = mockFetch(new Response("", { status: 500 }));
    expect((await falla(canvasGet(URL_, TOKEN, FAST))).code).toBe("CANVAS_UNAVAILABLE");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("si Canvas no contesta, corta por timeout en vez de colgarse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
          ),
      ),
    );
    const e = await falla(canvasGet(URL_, TOKEN, { timeoutMs: 20, retries: 0 }));
    expect(e.code).toBe("CANVAS_TIMEOUT");
  });

  it("un fallo de red es CANVAS_NETWORK", async () => {
    mockFetch(new TypeError("fetch failed"));
    expect((await falla(canvasGet(URL_, TOKEN, FAST))).code).toBe("CANVAS_NETWORK");
  });

  it("HTML con 200 no es una lista vacía", async () => {
    mockFetch(new Response("<html>mantenimiento</html>", { status: 200 }));
    expect((await falla(canvasGet(URL_, TOKEN, FAST))).code).toBe("CANVAS_BAD_RESPONSE");
  });

  it("un objeto en vez de una lista tampoco", async () => {
    mockFetch(json({ errors: [{ message: "algo" }] }));
    expect((await falla(canvasGet(URL_, TOKEN, { ...FAST, retries: 0 }))).code).toBe("CANVAS_BAD_RESPONSE");
  });

  it("el token viaja en la cabecera, no en la URL", async () => {
    const f = mockFetch(json([]));
    await canvasGet(URL_, TOKEN, FAST);
    const [url, init] = f.mock.calls[0];
    expect(url).not.toContain(TOKEN);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("canvasGetAll", () => {
  it("dice si llegó a la última página", async () => {
    mockFetch(
      json([1], { headers: { link: `<${URL_}&page=2>; rel="next"` } }),
      json([2]),
    );
    expect(await canvasGetAll(URL_, TOKEN, FAST)).toEqual({ items: [1, 2], complete: true });
  });

  it("si el Link da vueltas en círculo, la lista no cuenta como completa", async () => {
    mockFetch(json([1], { headers: { link: `<${URL_}>; rel="next"` } }));
    expect(await canvasGetAll(URL_, TOKEN, FAST)).toEqual({ items: [1], complete: false });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "cliente-de-prueba.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "secreto-de-cliente-google-de-prueba";
  delete process.env.CANVAS_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.VAPID_PRIVATE_KEY;
});

const state = vi.hoisted(() => ({ ctx: null as unknown, cookie: "" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "tf_gcal_state" && state.cookie ? { value: state.cookie } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
  getApiCtx: async () => state.ctx,
}));

import { GET as connectRoute } from "@/app/api/gcal/connect/route";
import { GET as callbackRoute } from "@/app/api/gcal/callback/route";
import { disconnectGcal } from "@/app/actions";
import { GCAL_SCOPE, authUrl, mapEvent, openToken, sealToken } from "@/lib/gcal";
import { runGcalSync, syncGcal } from "@/lib/gcal-sync";
import { runClock } from "@/lib/clock";
import { computeHealth } from "@/lib/health";
import { redact } from "@/lib/log";
import { ctxFor, fakeProject } from "./helpers/supa";

const SECRET = "secreto-de-cliente-google-de-prueba";
const REFRESH = "1//refresh-token-de-google-de-prueba-abcdefghij";
const HOY = "2026-10-01";
const CAL = { id: "victor@gmail.com", name: "Personal" };

/* ------------------------------------------------------------ Google falso */

type Ev = Record<string, unknown>;
const g = {
  calendars: [] as Ev[],
  events: {} as Record<string, Ev[]>,
  token: { status: 200, body: { access_token: "ya29.acceso-de-prueba-1234567890" } as Record<string, unknown> },
  exchange: { status: 200, body: {} as Record<string, unknown> },
  /** Respuestas forzadas para la lista de eventos de un calendario, en orden. */
  fallas: {} as Record<string, (number | "timeout")[]>,
  pageSize: 0,
  calls: [] as { method: string; url: URL; body?: string }[],
};

const timed = (id: string, start: string, end: string, extra: Ev = {}): Ev => ({
  id, status: "confirmed", summary: id, start: { dateTime: start }, end: { dateTime: end }, ...extra,
});

beforeEach(() => {
  g.calendars = [
    { id: "victor@gmail.com", summary: "victor@gmail.com", summaryOverride: "Personal", selected: true, primary: true },
    { id: "sfu@group.calendar.google.com", summary: "SFU", selected: true },
    { id: "feriados@group.v.calendar.google.com", summary: "Feriados", selected: false },
  ];
  g.events = {
    "victor@gmail.com": [
      timed("dentista", "2026-10-02T10:00:00-07:00", "2026-10-02T11:00:00-07:00"),
      { id: "receso", status: "confirmed", summary: "Receso", start: { date: "2026-10-12" }, end: { date: "2026-10-14" } },
    ],
    "sfu@group.calendar.google.com": [timed("econ342_20261005", "2026-10-05T10:30:00-07:00", "2026-10-05T12:00:00-07:00", { summary: "ECON 342" })],
    "feriados@group.v.calendar.google.com": [timed("feriado", "2026-10-03T00:00:00Z", "2026-10-03T01:00:00Z")],
  };
  g.token = { status: 200, body: { access_token: "ya29.acceso-de-prueba-1234567890" } };
  g.exchange = { status: 200, body: { access_token: "ya29.x-1234567890", refresh_token: REFRESH, scope: GCAL_SCOPE } };
  g.fallas = {};
  g.pageSize = 0;
  g.calls = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL, init?: RequestInit) => {
      const url = new URL(String(u));
      const method = init?.method ?? "GET";
      g.calls.push({ method, url, body: init?.body ? String(init.body) : undefined });

      if (url.origin === "https://oauth2.googleapis.com") {
        if (url.pathname === "/revoke") return new Response(null, { status: 200 });
        const p = new URLSearchParams(String(init?.body));
        const r = p.get("grant_type") === "authorization_code" ? g.exchange : g.token;
        return Response.json(r.body, { status: r.status });
      }
      if (url.origin !== "https://www.googleapis.com") throw new Error("fetch inesperado: " + url);

      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer ya29.acceso-de-prueba-1234567890") return Response.json({}, { status: 401 });

      if (url.pathname === "/calendar/v3/users/me/calendarList") return Response.json({ items: g.calendars });
      const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
      if (!m) throw new Error("ruta inesperada: " + url.pathname);
      const cal = decodeURIComponent(m[1]);
      const falla = g.fallas[cal]?.shift();
      if (falla === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (falla) return Response.json({ error: { errors: [{ reason: "x" }] } }, { status: falla });
      const all = g.events[cal] ?? [];
      if (!g.pageSize) return Response.json({ items: all });
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      const next = from + g.pageSize;
      return Response.json({ items: all.slice(from, next), ...(next < all.length ? { nextPageToken: String(next) } : {}) });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/* -------------------------------------------------------------- escenario */

const A = "a@ejemplo.com", B = "b@ejemplo.com";
let p: Awaited<ReturnType<typeof fakeProject>>;
let a: string, b: string;

beforeEach(async () => {
  p = await fakeProject([A, B]);
  a = p.id(A);
  b = p.id(B);
  state.ctx = ctxFor(p.as(A), a, HOY);
  state.cookie = "";
});

const link = (uid: string, email = A) =>
  p.as(email).from("gcal_links").insert({ user_id: uid, refresh_token: sealToken(REFRESH, SECRET) });
const gcalRows = async (uid = a) =>
  (await p.admin.from("events").select("id, title, external_id, starts_at, ends_at, all_day_date, course_ref").eq("user_id", uid).eq("source", "gcal").order("external_id")).data!;
const fast = { backoffMs: 1 };

/* ------------------------------------------------------------------ piezas */

describe("mapeo de eventos", () => {
  it("con hora: instante en UTC, el calendario como referencia", () => {
    expect(mapEvent(timed("x", "2026-10-02T10:00:00-07:00", "2026-10-02T11:00:00-07:00"), CAL)).toEqual([{
      title: "x", starts_at: "2026-10-02T17:00:00.000Z", ends_at: "2026-10-02T18:00:00.000Z", all_day_date: null,
      location: null, course_ref: "Personal", source: "gcal", external_id: "gcal:victor@gmail.com:x",
    }]);
  });

  it("de día completo: el fin es exclusivo, y varios días salen uno por día", () => {
    const uno = mapEvent({ id: "f", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }, CAL);
    expect(uno.map((r) => [r.all_day_date, r.external_id])).toEqual([["2026-10-12", "gcal:victor@gmail.com:f"]]);
    const tres = mapEvent({ id: "r", start: { date: "2026-10-12" }, end: { date: "2026-10-15" } }, CAL);
    expect(tres.map((r) => r.external_id)).toEqual([
      "gcal:victor@gmail.com:r:2026-10-12", "gcal:victor@gmail.com:r:2026-10-13", "gcal:victor@gmail.com:r:2026-10-14",
    ]);
  });

  it("lo cancelado, lo que rechazaste y lo roto no entra", () => {
    expect(mapEvent({ ...timed("c", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z"), status: "cancelled" }, CAL)).toEqual([]);
    expect(mapEvent(timed("d", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z", {
      attendees: [{ email: "otro@x.com", responseStatus: "accepted" }, { self: true, responseStatus: "declined" }],
    }), CAL)).toEqual([]);
    expect(mapEvent({ id: "z", start: { dateTime: "mañana" } }, CAL)).toEqual([]);
    expect(mapEvent(null, CAL)).toEqual([]);
  });

  it("sin título dice que no tiene; un fin antes del inicio se descarta", () => {
    const [r] = mapEvent({ id: "s", start: { dateTime: "2026-10-02T10:00:00Z" }, end: { dateTime: "2026-10-02T09:00:00Z" } }, CAL);
    expect(r).toMatchObject({ title: "(sin título)", ends_at: null });
  });
});

describe("el permiso guardado", () => {
  it("se guarda cifrado y sólo se abre con el secreto del servidor", () => {
    const s = sealToken(REFRESH, SECRET);
    expect(s).not.toContain(REFRESH);
    expect(s).not.toContain("refresh-token");
    expect(openToken(s, SECRET)).toBe(REFRESH);
    expect(openToken(s, "otro-secreto-cualquiera")).toBeNull();
    const [v, iv, tag, ct] = s.split(".");
    expect(openToken([v, iv, tag, ct.slice(0, -2) + (ct.endsWith("A") ? "B" : "A") + ct.slice(-1)].join("."), SECRET)).toBeNull();
    expect(openToken("texto-plano", SECRET)).toBeNull();
  });

  it("la URL de permiso pide sólo lectura, sin conexión y con consentimiento", () => {
    const u = new URL(authUrl({ clientId: "c", redirectUri: "https://app/api/gcal/callback", state: "s" }));
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("s");
  });

  it("los tokens de Google no llegan a un log", () => {
    expect(redact(`fallo con ya29.acceso-de-prueba-1234567890 y ${REFRESH}`)).toBe("fallo con [redactado] y [redactado]");
  });
});

/* ------------------------------------------------------------------- sync */

describe("sync de Google Calendar", () => {
  it("trae los calendarios visibles; dos veces deja exactamente lo mismo", async () => {
    await link(a);
    const r1 = await syncGcal(state.ctx as never, fast);
    expect(r1).toMatchObject({ items: 4, added: 4, removed: 0, complete: true });
    expect(r1.calendars.map((c) => c.name)).toEqual(["Personal", "SFU"]);
    const antes = await gcalRows();
    expect(antes.map((r) => r.title).sort()).toEqual(["ECON 342", "Receso", "Receso", "dentista"]);
    const econ = antes.find((r) => r.title === "ECON 342")!;
    expect(econ.course_ref).toBe("SFU");
    expect(Date.parse(econ.starts_at)).toBe(Date.parse("2026-10-05T17:30:00Z"));

    const r2 = await syncGcal(state.ctx as never, fast);
    expect(r2).toMatchObject({ items: 4, added: 0, removed: 0 });
    expect(await gcalRows()).toEqual(antes);
  });

  it("un evento que cambió de hora se actualiza en su lugar; uno borrado en Google se quita", async () => {
    await link(a);
    await syncGcal(state.ctx as never, fast);
    const [dentista] = (await gcalRows()).filter((r) => r.title === "dentista");

    g.events["victor@gmail.com"][0] = timed("dentista", "2026-10-02T15:00:00-07:00", "2026-10-02T16:00:00-07:00");
    g.events["sfu@group.calendar.google.com"] = [];
    const r = await syncGcal(state.ctx as never, fast);
    expect(r).toMatchObject({ removed: 1, added: 0 });
    const despues = await gcalRows();
    const movido = despues.find((x) => x.title === "dentista")!;
    expect(movido.id).toBe(dentista.id);
    expect(Date.parse(movido.starts_at)).toBe(Date.parse("2026-10-02T22:00:00Z"));
    expect(despues.some((x) => x.title === "ECON 342")).toBe(false);
  });

  it("si un calendario falla a medias, no se quita nada", async () => {
    await link(a);
    await syncGcal(state.ctx as never, fast);
    g.events["victor@gmail.com"] = [];
    g.fallas["sfu@group.calendar.google.com"] = [404];
    const r = await syncGcal(state.ctx as never, fast);
    expect(r).toMatchObject({ complete: false, removed: 0 });
    expect(r.message).toMatch(/incompleta/);
    expect(await gcalRows()).toHaveLength(4);
  });

  it("lo que empezó antes de la ventana no entra, y no cuenta como nuevo en cada corrida", async () => {
    await link(a);
    // La ventana empieza el 24 sep (una semana antes de hoy) en Vancouver.
    g.events["victor@gmail.com"].push(
      timed("congreso", "2026-09-20T09:00:00-07:00", "2026-09-26T17:00:00-07:00"),
      { id: "viaje", start: { date: "2026-09-22" }, end: { date: "2026-09-26" } },
    );
    const r1 = await syncGcal(state.ctx as never, fast);
    expect((await gcalRows()).map((r) => r.external_id).filter((x) => /congreso|viaje/.test(x))).toEqual([
      "gcal:victor@gmail.com:viaje:2026-09-24", "gcal:victor@gmail.com:viaje:2026-09-25",
    ]);
    expect(r1.added).toBe(6);
    expect(await syncGcal(state.ctx as never, fast)).toMatchObject({ added: 0, removed: 0 });
  });

  it("pagina hasta el final", async () => {
    await link(a);
    g.pageSize = 1;
    expect(await syncGcal(state.ctx as never, fast)).toMatchObject({ items: 4, complete: true });
  });

  it("no toca tus .ics, ni lo de otra cuenta, ni lo que está fuera de la ventana", async () => {
    await link(a);
    await p.as(A).from("events").insert([
      { user_id: a, title: "clase ics", source: "ics", external_id: "ics:x", starts_at: "2026-10-02T17:00:00Z" },
      { user_id: a, title: "viejo", source: "gcal", external_id: "gcal:victor@gmail.com:viejo", starts_at: "2026-01-02T17:00:00Z" },
    ]);
    await p.as(B).from("events").insert({ user_id: b, title: "de B", source: "gcal", external_id: "gcal:b:x", starts_at: "2026-10-02T17:00:00Z" });
    await syncGcal(state.ctx as never, fast);
    expect((await p.admin.from("events").select("title").eq("user_id", a).eq("source", "ics")).data).toEqual([{ title: "clase ics" }]);
    expect((await gcalRows()).some((r) => r.title === "viejo")).toBe(true);
    expect((await gcalRows(b)).map((r) => r.title)).toEqual(["de B"]);
  });

  it("sólo lee: a la API de Calendar no le manda más que GET", async () => {
    await link(a);
    await syncGcal(state.ctx as never, fast);
    const api = g.calls.filter((c) => c.url.origin === "https://www.googleapis.com");
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((c) => c.method === "GET")).toBe(true);
    // El calendario oculto en Google no se lee.
    expect(api.some((c) => c.url.pathname.includes("feriados"))).toBe(false);
  });
});

describe("cuando Google falla", () => {
  const estado = async () =>
    (await p.admin.from("sync_state").select("last_error_code, last_success_at").eq("user_id", a).eq("source", "gcal").maybeSingle()).data;

  it("sin conexión guardada no hace nada y lo dice", async () => {
    await expect(syncGcal(state.ctx as never, fast)).rejects.toMatchObject({ code: "GCAL_NOT_LINKED" });
  });

  it("permiso retirado: queda el error con su código, la actividad lo anota y no se borra nada", async () => {
    await link(a);
    await syncGcal(state.ctx as never, fast);
    g.token = { status: 400, body: { error: "invalid_grant" } };
    const r = await runGcalSync(state.ctx as never, "cron", fast);
    expect(r).toMatchObject({ ok: false, code: "GCAL_REVOKED" });
    expect(await estado()).toMatchObject({ last_error_code: "GCAL_REVOKED" });
    expect(await gcalRows()).toHaveLength(4);
    const { data: act } = await p.admin.from("activity_log").select("kind").eq("user_id", a);
    expect(act!.map((x) => x.kind)).toEqual(["gcal.failed"]);

    // El reloj vuelve a fallar igual: no se repite en la actividad cada 3 h.
    await runGcalSync(state.ctx as never, "cron", fast);
    expect((await p.admin.from("activity_log").select("kind").eq("user_id", a)).data).toHaveLength(1);
  });

  it("un 500 o un 429 pasajero se reintenta una vez; si sigue, error con código", async () => {
    await link(a);
    g.fallas["victor@gmail.com"] = [429];
    expect(await runGcalSync(state.ctx as never, "cron", fast)).toMatchObject({ ok: true });

    g.fallas["victor@gmail.com"] = [503, 503];
    expect(await runGcalSync(state.ctx as never, "cron", fast)).toMatchObject({ ok: false, code: "GCAL_UNAVAILABLE" });
    expect(await gcalRows()).toHaveLength(4);
  });

  it("sin respuesta: error de tiempo, no un cuelgue", async () => {
    await link(a);
    g.fallas["victor@gmail.com"] = ["timeout", "timeout"];
    expect(await runGcalSync(state.ctx as never, "manual", fast)).toMatchObject({ ok: false, code: "GCAL_TIMEOUT" });
  });

  it("un permiso guardado que no se puede abrir pide reconectar", async () => {
    await p.as(A).from("gcal_links").insert({ user_id: a, refresh_token: "v1.basura.basura.basura" });
    expect(await runGcalSync(state.ctx as never, "manual", fast)).toMatchObject({ ok: false, code: "GCAL_REVOKED" });
  });
});

/* ------------------------------------------------------------------ rutas */

describe("conectar", () => {
  it("manda a Google con sólo lectura y una cookie de estado httpOnly", async () => {
    const res = await connectRoute(new Request("https://taskflow.prueba/api/gcal/connect"));
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("scope")).toBe(GCAL_SCOPE);
    expect(to.searchParams.get("redirect_uri")).toBe("https://taskflow.prueba/api/gcal/callback");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`tf_gcal_state=${to.searchParams.get("state")}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/gcal/);
  });

  it("sin sesión, al login", async () => {
    state.ctx = null;
    const res = await connectRoute(new Request("https://taskflow.prueba/api/gcal/connect"));
    expect(res.headers.get("location")).toBe("https://taskflow.prueba/login");
  });

  const vuelta = (q: string) => callbackRoute(new Request(`https://taskflow.prueba/api/gcal/callback?${q}`));

  it("una vuelta con otro estado no conecta nada", async () => {
    state.cookie = "estado-de-este-navegador";
    const res = await vuelta("code=c&state=otro-estado");
    expect(res.headers.get("location")).toBe("https://taskflow.prueba/ajustes/estado?gcal=estado-invalido#st-gcal");
    expect((await p.admin.from("gcal_links").select("user_id").eq("user_id", a)).data).toEqual([]);
    expect(g.calls).toEqual([]);
  });

  it("si cancelaste en Google, lo dice", async () => {
    state.cookie = "s1";
    expect((await vuelta("error=access_denied&state=s1")).headers.get("location")).toContain("gcal=cancelado");
  });

  it("si desmarcaste el calendario en el permiso, no se guarda nada", async () => {
    state.cookie = "s1";
    g.exchange.body = { refresh_token: REFRESH, scope: "openid email" };
    expect((await vuelta("code=c&state=s1")).headers.get("location")).toContain("gcal=error");
    expect((await p.admin.from("gcal_links").select("user_id").eq("user_id", a)).data).toEqual([]);
  });

  it("la vuelta buena guarda el permiso cifrado, lee el calendario y lo anota", async () => {
    state.cookie = "s1";
    const res = await vuelta("code=codigo-de-google&state=s1");
    expect(res.headers.get("location")).toBe("https://taskflow.prueba/ajustes/estado?gcal=ok#st-gcal");
    expect(res.headers.get("set-cookie")).toMatch(/tf_gcal_state=;/);

    const canje = g.calls.find((c) => c.body?.includes("authorization_code"))!;
    expect(new URLSearchParams(canje.body).get("redirect_uri")).toBe("https://taskflow.prueba/api/gcal/callback");

    const { data: fila } = await p.admin.from("gcal_links").select("refresh_token, calendars").eq("user_id", a).single();
    expect(fila!.refresh_token).not.toContain(REFRESH);
    expect(openToken(fila!.refresh_token, SECRET)).toBe(REFRESH);
    expect(fila!.calendars).toEqual([CAL, { id: "sfu@group.calendar.google.com", name: "SFU" }]);
    expect(await gcalRows()).toHaveLength(4);
    const { data: act } = await p.admin.from("activity_log").select("kind").eq("user_id", a).order("id");
    expect(act!.map((x) => x.kind)).toEqual(["gcal.linked", "gcal.sync"]);
  });
});

describe("desconectar", () => {
  it("revoca en Google, borra el permiso y sus eventos, y deja lo demás", async () => {
    await link(a);
    await syncGcal(state.ctx as never, fast);
    await p.as(A).from("events").insert({ user_id: a, title: "clase ics", source: "ics", external_id: "ics:x", starts_at: "2026-10-02T17:00:00Z" });

    const r = await disconnectGcal();
    expect(r.ok).toBe(true);
    const revoke = g.calls.find((c) => c.url.pathname === "/revoke")!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe(REFRESH);
    expect((await p.admin.from("gcal_links").select("user_id").eq("user_id", a)).data).toEqual([]);
    expect(await gcalRows()).toEqual([]);
    expect((await p.admin.from("sync_state").select("source").eq("user_id", a).eq("source", "gcal")).data).toEqual([]);
    expect((await p.admin.from("events").select("title").eq("user_id", a)).data).toEqual([{ title: "clase ics" }]);
  });
});

/* ------------------------------------------------------------------- reloj */

describe("el reloj", () => {
  const AHORA = new Date("2026-10-01T18:00:00Z");

  it("sincroniza a quien tiene Google conectado, y no a los demás", async () => {
    await link(a);
    const lines = await runClock(p.admin, { origin: "https://taskflow.prueba", now: AHORA });
    expect(lines.find((l) => l.user === a)!.message).toMatch(/Google Calendar: 4 eventos de 2 calendarios/);
    expect(lines.find((l) => l.user === b)!.message).not.toMatch(/Google/);
    expect(await gcalRows()).toHaveLength(4);
  });

  it("si sincronizó hace poco, se salta", async () => {
    await link(a);
    await p.admin.from("sync_state").upsert({ user_id: a, source: "gcal", last_success_at: new Date(AHORA.getTime() - 3600_000).toISOString() }, { onConflict: "user_id,source" });
    await runClock(p.admin, { origin: "https://taskflow.prueba", now: AHORA });
    expect(g.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ estado */

describe("salud de Google Calendar", () => {
  const base = {
    now: Date.parse("2026-10-01T18:00:00Z"), canvasConfigured: false, pushConfigured: false, pushDevices: 0,
    telegramConfigured: false, telegramLinked: false, aiConfigured: false,
  };
  const row = (o: Partial<{ last_success_at: string | null; last_error_at: string | null; last_error_code: string | null }>) => ({
    source: "gcal", last_synced_at: "2026-10-01T17:00:00Z", last_success_at: null, last_error: "Google ya no acepta el permiso guardado",
    last_error_at: null, last_error_code: null, items_synced: 4, ...o,
  });
  const gcal = (h: ReturnType<typeof computeHealth>) => h.items.find((i) => i.key === "gcal")!;

  it("sin configurar o sin conectar está apagado, no en rojo", () => {
    expect(gcal(computeHealth({ ...base, states: {} })).level).toBe("off");
    expect(gcal(computeHealth({ ...base, gcalConfigured: true, gcalLinked: false, states: {} })).summary).toBe("Sin conectar");
  });

  it("un permiso retirado es error desde el primer momento y sale arriba", () => {
    const h = computeHealth({
      ...base, gcalConfigured: true, gcalLinked: true,
      states: { gcal: row({ last_success_at: "2026-10-01T16:00:00Z", last_error_at: "2026-10-01T17:00:00Z", last_error_code: "GCAL_REVOKED" }) },
    });
    expect(gcal(h).level).toBe("error");
    expect(h.alerts.map((x) => x.key)).toContain("gcal");
  });

  it("al día: ok", () => {
    expect(gcal(computeHealth({ ...base, gcalConfigured: true, gcalLinked: true, states: { gcal: row({ last_success_at: "2026-10-01T17:00:00Z" }) } })).level).toBe("ok");
  });
});

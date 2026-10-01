import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "llave-publica-de-prueba";
  process.env.VAPID_PRIVATE_KEY = "llave-privada-vapid-de-prueba";
  process.env.TELEGRAM_BOT_TOKEN = "123456789:token-de-telegram-de-prueba-abcdef";
  process.env.TELEGRAM_API_BASE = "https://telegram.prueba";
  delete process.env.CANVAS_TOKEN;
});

// El envío real de push va por HTTPS a Google/Apple/Mozilla; aquí se simula
// la respuesta de cada endpoint.
const push = vi.hoisted(() => ({
  status: new Map<string, number | "timeout">(),
  sent: [] as { endpoint: string; payload: string }[],
}));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string) => {
      const st = push.status.get(sub.endpoint) ?? 201;
      if (st === "timeout") throw new Error("Socket timeout");
      if (st >= 300) throw Object.assign(new Error("Received unexpected response code"), { statusCode: st });
      push.sent.push({ endpoint: sub.endpoint, payload });
      return { statusCode: st };
    }),
  },
}));

import { runClock } from "@/lib/clock";
import { fakeProject } from "./helpers/supa";

/* ----------------------------------------------------------- Telegram falso */

type TgReply = { ok: boolean; error_code?: number; description?: string } | "timeout";
let tgReply: TgReply = { ok: true };
let tgSent: { chat_id: number; text: string }[] = [];

beforeEach(() => {
  push.status.clear();
  push.sent = [];
  tgReply = { ok: true };
  tgSent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("https://telegram.prueba/")) throw new Error("fetch inesperado: " + url);
      if (tgReply === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (tgReply.ok) tgSent.push(JSON.parse(String(init?.body)));
      return Response.json(tgReply.ok ? { ok: true, result: {} } : tgReply);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/* -------------------------------------------------------------- escenario */

const A = "a@ejemplo.com", B = "b@ejemplo.com";
// 30 sep 2026, 08:30 en Vancouver (UTC-7): dentro de la ventana de la mañana.
const MANANA = new Date("2026-09-30T15:30:00Z");
const ORIGIN = "https://taskflow.prueba";

async function setup() {
  const p = await fakeProject([A, B]);
  const a = p.id(A), b = p.id(B);
  await p.as(A).from("tasks").insert({ user_id: a, title: "Problem Set 4", due_date: "2026-09-30" });
  await p.as(B).from("tasks").insert({ user_id: b, title: "SECRETO DE B", due_date: "2026-09-30" });
  await p.as(A).from("push_subscriptions").insert([
    { endpoint: "https://push.prueba/celular", user_id: a, p256dh: "k", auth: "a" },
    { endpoint: "https://push.prueba/laptop", user_id: a, p256dh: "k", auth: "a" },
  ]);
  await p.admin.from("telegram_chats").insert({ user_id: a, chat_id: 555, linked_at: new Date().toISOString() });

  const state = async (source: string) =>
    (await p.admin.from("sync_state").select("*").eq("user_id", a).eq("source", source).maybeSingle()).data;
  const subs = async () =>
    ((await p.admin.from("push_subscriptions").select("endpoint").eq("user_id", a)).data ?? []).map((r) => r.endpoint);
  const chat = async () => (await p.admin.from("telegram_chats").select("chat_id").eq("user_id", a).maybeSingle()).data;
  const run = (now = MANANA) => runClock(p.admin, { origin: ORIGIN, now });
  return { p, a, b, state, subs, chat, run };
}

const sentTo = (who: string) => push.sent.filter((s) => s.endpoint.endsWith(who)).length;

/* ------------------------------------------------------------------ tests */

describe("el reloj", () => {
  it("manda el aviso de la mañana una sola vez aunque corra dos veces", async () => {
    const s = await setup();
    await s.run();
    await s.run(new Date(MANANA.getTime() + 3600_000));
    expect(sentTo("celular")).toBe(1);
    expect(sentTo("laptop")).toBe(1);
    expect(tgSent).toHaveLength(1);
  });

  it("dos corridas simultáneas tampoco lo duplican", async () => {
    const s = await setup();
    await Promise.all([s.run(), s.run(), s.run()]);
    expect(sentTo("celular")).toBe(1);
    expect(tgSent).toHaveLength(1);
  });

  it("si llega tarde, todavía avisa dentro de la ventana; pasado mediodía, no", async () => {
    const tarde = await setup();
    await tarde.run(new Date("2026-09-30T18:45:00Z")); // 11:45
    expect(tgSent).toHaveLength(1);

    tgSent = [];
    const muyTarde = await setup();
    await muyTarde.run(new Date("2026-09-30T19:05:00Z")); // 12:05
    expect(tgSent).toHaveLength(0);
  });

  it("deja un latido en sync_state: la corrida empezó y terminó", async () => {
    const s = await setup();
    await s.run();
    const st = await s.state("cron");
    expect(st?.last_synced_at).toBeTruthy();
    expect(st?.last_success_at).toBeTruthy();
  });

  it("el aviso de un usuario no lleva tareas de otro", async () => {
    const s = await setup();
    await s.run();
    const todo = JSON.stringify([push.sent, tgSent]);
    expect(todo).toContain("Problem Set 4");
    expect(todo).not.toContain("SECRETO DE B");
  });

  it("no escribe secretos en el log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    tgReply = { ok: false, error_code: 500, description: "boom" };
    const s = await setup();
    await s.run();
    const salida = JSON.stringify([...log.mock.calls, ...err.mock.calls]);
    expect(salida).not.toContain("token-de-telegram-de-prueba");
    expect(salida).not.toContain("llave-privada-vapid");
    log.mockRestore();
    err.mockRestore();
  });
});

describe("push", () => {
  it("una suscripción caducada (410) se borra; las demás siguen recibiendo", async () => {
    const s = await setup();
    push.status.set("https://push.prueba/laptop", 410);
    await s.run();
    expect(sentTo("celular")).toBe(1);
    expect(await s.subs()).toEqual(["https://push.prueba/celular"]);
    expect((await s.state("push"))?.last_success_at).toBeTruthy();
  });

  it("si todas caducaron, queda dicho: el usuario cree que tiene avisos y no", async () => {
    const s = await setup();
    push.status.set("https://push.prueba/laptop", 410);
    push.status.set("https://push.prueba/celular", 404);
    await s.run();
    expect(await s.subs()).toEqual([]);
    expect((await s.state("push"))?.last_error_code).toBe("PUSH_SUBSCRIPTION_GONE");
  });

  it("una firma VAPID rechazada no borra la suscripción pero se registra", async () => {
    const s = await setup();
    push.status.set("https://push.prueba/laptop", 403);
    push.status.set("https://push.prueba/celular", 403);
    await s.run();
    expect(await s.subs()).toHaveLength(2);
    expect((await s.state("push"))?.last_error_code).toBe("PUSH_VAPID_REJECTED");
  });

  it("un servicio de push colgado no detiene a Telegram", async () => {
    const s = await setup();
    push.status.set("https://push.prueba/laptop", "timeout");
    push.status.set("https://push.prueba/celular", "timeout");
    await s.run();
    expect(tgSent).toHaveLength(1);
    expect((await s.state("push"))?.last_error_code).toBe("PUSH_TIMEOUT");
  });
});

describe("Telegram", () => {
  it("bot bloqueado (403): se desconecta, queda el motivo, y el push llega igual", async () => {
    const s = await setup();
    tgReply = { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
    await s.run();
    expect(await s.chat()).toBeNull();
    const st = await s.state("telegram");
    expect(st?.last_error_code).toBe("TELEGRAM_BOT_BLOCKED");
    expect(st?.last_error).toMatch(/Bloqueaste al bot/);
    expect(sentTo("celular")).toBe(1);

    // Y no se reintenta el aviso dentro de una hora: el push ya salió.
    await s.run(new Date(MANANA.getTime() + 3600_000));
    expect(sentTo("celular")).toBe(1);
  });

  it("chat inexistente (400 chat not found): se desconecta", async () => {
    const s = await setup();
    tgReply = { ok: false, error_code: 400, description: "Bad Request: chat not found" };
    await s.run();
    expect(await s.chat()).toBeNull();
    expect((await s.state("telegram"))?.last_error_code).toBe("TELEGRAM_CHAT_GONE");
  });

  it("429 no desconecta, sólo se registra", async () => {
    const s = await setup();
    tgReply = { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" };
    await s.run();
    expect(await s.chat()).not.toBeNull();
    expect((await s.state("telegram"))?.last_error_code).toBe("TELEGRAM_RATE_LIMITED");
  });

  it("timeout no desconecta, sólo se registra", async () => {
    const s = await setup();
    tgReply = "timeout";
    await s.run();
    expect(await s.chat()).not.toBeNull();
    expect((await s.state("telegram"))?.last_error_code).toBe("TELEGRAM_TIMEOUT");
  });

  it("un envío bueno deja constancia", async () => {
    const s = await setup();
    await s.run();
    expect(tgSent[0].chat_id).toBe(555);
    expect((await s.state("telegram"))?.last_success_at).toBeTruthy();
  });
});

describe("horario de verano y viajes", () => {
  it("el día del cambio de hora (1 nov) el aviso sale una vez, y la hora repetida no cuenta como mañana", async () => {
    const s = await setup();
    await s.p.as(A).from("tasks").insert({ user_id: s.a, title: "PS5", due_date: "2026-11-01" });
    await s.run(new Date("2026-11-01T08:30:00Z")); // 1:30 PDT
    await s.run(new Date("2026-11-01T09:30:00Z")); // 1:30 PST, otra vez
    expect(tgSent).toHaveLength(0);
    await s.run(new Date("2026-11-01T15:30:00Z")); // 7:30 PST
    await s.run(new Date("2026-11-01T16:30:00Z")); // 8:30 PST
    expect(tgSent).toHaveLength(1);
  });

  it("de viaje: cambiar de zona no repite el aviso del mismo día local; un día nuevo allá sí avisa", async () => {
    const s = await setup();
    await s.run(); // 30 sep, 8:30 en Vancouver
    expect(tgSent).toHaveLength(1);

    // Mismo instante: en Toronto son las 11:30 del mismo 30 de septiembre.
    await s.p.admin.from("profiles").update({ timezone: "America/Toronto" }).eq("id", s.a);
    await s.run(new Date(MANANA.getTime() + 60_000));
    expect(tgSent).toHaveLength(1);

    // Tokio, 1 oct a las 8:30: es otro día allá, y es de mañana.
    await s.p.admin.from("profiles").update({ timezone: "Asia/Tokyo" }).eq("id", s.a);
    await s.run(new Date("2026-09-30T23:30:00Z"));
    expect(tgSent).toHaveLength(2);
  });
});

describe("el resumen de la mañana avisa lo que falla", () => {
  const telegramRoto = (a: string) => ({
    user_id: a, source: "telegram", last_synced_at: "2026-09-29T15:00:00Z", last_success_at: "2026-09-28T15:00:00Z",
    last_error_at: "2026-09-29T15:00:00Z", last_error: "Telegram no respondió en 10 s", last_error_code: "TELEGRAM_TIMEOUT",
  });

  it("si Telegram falló, el push de la mañana lo dice", async () => {
    const s = await setup();
    await s.p.admin.from("sync_state").insert(telegramRoto(s.a));
    tgReply = "timeout";
    await s.run();
    const payload = JSON.parse(push.sent.find((x) => x.endpoint.endsWith("celular"))!.payload);
    expect(payload.body).toMatch(/⚠ Telegram: El último mensaje no llegó/);
    expect(payload.title).toMatch(/para hoy/); // el aviso normal sigue ahí
  });

  it("aunque no haya nada que avisar, si algo falla sale un aviso", async () => {
    const s = await setup();
    await s.p.admin.from("tasks").delete().eq("user_id", s.a);
    await s.p.admin.from("sync_state").insert(telegramRoto(s.a));
    await s.run();
    const payload = JSON.parse(push.sent[0].payload);
    expect(payload).toMatchObject({ title: "TaskFlow necesita atención", url: "/ajustes/estado" });
  });

  it("si todo anda, el aviso es el de siempre", async () => {
    const s = await setup();
    await s.run();
    expect(JSON.parse(push.sent[0].payload).body).not.toMatch(/⚠/);
  });
});

describe("el reloj deja constancia en Actividad", () => {
  const log = async (s: Awaited<ReturnType<typeof setup>>) =>
    ((await s.p.admin.from("activity_log").select("actor, kind, summary").eq("user_id", s.a).order("id")).data ?? []);

  it("el resumen enviado, con los canales por los que salió", async () => {
    const s = await setup();
    await s.run();
    const sent = (await log(s)).find((r) => r.kind === "digest.sent")!;
    expect(sent.actor).toBe("system");
    expect(sent.summary).toMatch(/^Resumen de la mañana enviado: «.+» \(push a 2 dispositivos y Telegram\)$/);
  });

  it("Telegram bloqueado: queda escrito por qué se desconectó", async () => {
    const s = await setup();
    tgReply = { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
    await s.run();
    const entries = await log(s);
    expect(entries.some((r) => r.kind === "telegram.unlinked" && /Bloqueaste al bot/.test(r.summary))).toBe(true);
    expect(entries.find((r) => r.kind === "digest.sent")!.summary).toMatch(/\(push a 2 dispositivos\)$/);
  });
});

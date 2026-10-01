import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "llave-publica-de-prueba";
  process.env.VAPID_PRIVATE_KEY = "llave-privada-vapid-de-prueba";
  process.env.TELEGRAM_BOT_TOKEN = "123456789:token-de-telegram-de-prueba-abcdef";
  process.env.TELEGRAM_API_BASE = "https://telegram.prueba";
});

const push = vi.hoisted(() => ({ status: new Map<string, number>(), sent: [] as string[] }));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }) => {
      const st = push.status.get(sub.endpoint) ?? 201;
      if (st >= 300) throw Object.assign(new Error("x"), { statusCode: st });
      push.sent.push(sub.endpoint);
      return { statusCode: st };
    }),
  },
}));

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "taskflow.prueba", "x-forwarded-proto": "https" }) }));
vi.mock("@/lib/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/data")>()),
  getCtx: async () => state.ctx,
  getApiCtx: async () => state.ctx,
}));

import { sendTestPush, sendTestTelegram, syncPushSubscription } from "@/app/actions";
import { POST as resubscribe } from "@/app/api/push/subscription/route";
import { ctxFor, fakeProject } from "./helpers/supa";

const A = "a@ejemplo.com";
let p: Awaited<ReturnType<typeof fakeProject>>;
let uid: string;
let tg: { ok: boolean; error_code?: number; description?: string } = { ok: true };

beforeEach(async () => {
  push.status.clear();
  push.sent = [];
  tg = { ok: true };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(tg.ok ? { ok: true, result: {} } : tg)));
  p = await fakeProject([A]);
  uid = p.id(A);
  state.ctx = ctxFor(p.as(A), uid);
});
afterEach(() => vi.unstubAllGlobals());

const subs = async () =>
  ((await p.admin.from("push_subscriptions").select("endpoint").eq("user_id", uid).order("endpoint")).data ?? []).map((r) => r.endpoint);
const state_ = async (source: string) =>
  (await p.admin.from("sync_state").select("*").eq("user_id", uid).eq("source", source).maybeSingle()).data;

describe("notificación de prueba", () => {
  it("sin dispositivos lo dice", async () => {
    expect(await sendTestPush()).toMatchObject({ ok: false, message: expect.stringMatching(/Ningún dispositivo|No hay ningún dispositivo/) });
  });

  it("con varios dispositivos: cuenta los que llegaron y quita los muertos", async () => {
    await p.as(A).from("push_subscriptions").insert([
      { endpoint: "https://push.prueba/1", user_id: uid, p256dh: "k", auth: "a" },
      { endpoint: "https://push.prueba/2", user_id: uid, p256dh: "k", auth: "a" },
    ]);
    push.status.set("https://push.prueba/2", 410);
    const r = await sendTestPush();
    expect(r).toMatchObject({ ok: true, message: "Enviado a 1 dispositivo · 1 ya no estaba suscrito" });
    expect(await subs()).toEqual(["https://push.prueba/1"]);
    expect((await state_("push"))?.last_success_at).toBeTruthy();
  });
});

describe("mensaje de prueba de Telegram", () => {
  it("sin chat conectado lo dice", async () => {
    expect((await sendTestTelegram()).ok).toBe(false);
  });

  it("bot bloqueado: falla con la explicación y se desconecta", async () => {
    await p.admin.from("telegram_chats").insert({ user_id: uid, chat_id: 77, linked_at: new Date().toISOString() });
    tg = { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
    const r = await sendTestTelegram();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Bloqueaste al bot/);
    expect((await p.admin.from("telegram_chats").select("*").eq("user_id", uid)).data).toEqual([]);
  });

  it("con chat conectado, sale", async () => {
    await p.admin.from("telegram_chats").insert({ user_id: uid, chat_id: 77, linked_at: new Date().toISOString() });
    expect(await sendTestTelegram()).toMatchObject({ ok: true });
  });
});

describe("la suscripción del navegador se mantiene al día", () => {
  it("syncPushSubscription vuelve a registrar una suscripción que el servidor perdió, sin duplicar", async () => {
    const sub = { endpoint: "https://push.prueba/x", p256dh: "k", auth: "a" };
    await syncPushSubscription(sub);
    await syncPushSubscription(sub);
    expect(await subs()).toEqual(["https://push.prueba/x"]);
  });

  it("no acepta un endpoint que no sea https", async () => {
    await syncPushSubscription({ endpoint: "http://malo/x", p256dh: "k", auth: "a" });
    expect(await subs()).toEqual([]);
  });

  it("el service worker rota la suscripción: entra la nueva, sale la vieja", async () => {
    await p.as(A).from("push_subscriptions").insert({ endpoint: "https://push.prueba/vieja", user_id: uid, p256dh: "k", auth: "a" });
    const r = await resubscribe(new Request("https://taskflow.prueba/api/push/subscription", {
      method: "POST",
      headers: { origin: "https://taskflow.prueba", "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.prueba/nueva", keys: { p256dh: "k2", auth: "a2" }, oldEndpoint: "https://push.prueba/vieja" }),
    }));
    expect(r.status).toBe(200);
    expect(await subs()).toEqual(["https://push.prueba/nueva"]);
  });

  it("desde otro sitio, 403", async () => {
    const r = await resubscribe(new Request("https://taskflow.prueba/api/push/subscription", {
      method: "POST",
      headers: { origin: "https://malo.example", "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.prueba/x", keys: { p256dh: "k", auth: "a" } }),
    }));
    expect(r.status).toBe(403);
    expect(await subs()).toEqual([]);
  });

  it("sin sesión, 401", async () => {
    state.ctx = null;
    const r = await resubscribe(new Request("https://taskflow.prueba/api/push/subscription", {
      method: "POST",
      body: JSON.stringify({ endpoint: "https://push.prueba/x", keys: { p256dh: "k", auth: "a" } }),
    }));
    expect(r.status).toBe(401);
  });
});

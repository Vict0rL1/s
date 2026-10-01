import { describe, expect, it } from "vitest";
import { type HealthInput, type StateRow, ago, computeHealth, nextCanvasSync, nextClockTick } from "@/lib/health";

const NOW = Date.parse("2026-10-01T18:30:00Z");
const H = 3600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const row = (o: Partial<StateRow>): StateRow => ({
  source: "x", last_synced_at: null, last_success_at: null, last_error: null,
  last_error_at: null, last_error_code: null, items_synced: 0, ...o,
});

const base = (o: Partial<HealthInput> = {}): HealthInput => ({
  now: NOW,
  states: {
    cron: row({ last_synced_at: iso(0.3 * H), last_success_at: iso(0.3 * H) }),
    canvas: row({ last_synced_at: iso(H), last_success_at: iso(H) }),
    push: row({ last_synced_at: iso(10 * H), last_success_at: iso(10 * H) }),
    telegram: row({ last_synced_at: iso(10 * H), last_success_at: iso(10 * H) }),
  },
  canvasConfigured: true,
  pushConfigured: true,
  pushDevices: 2,
  telegramConfigured: true,
  telegramLinked: true,
  aiConfigured: true,
  ...o,
});

const item = (h: ReturnType<typeof computeHealth>, k: string) => h.items.find((i) => i.key === k)!;

describe("computeHealth", () => {
  it("todo bien: sin alertas", () => {
    const h = computeHealth(base());
    expect(h.overall).toBe("ok");
    expect(h.alerts).toEqual([]);
  });

  it("el reloj que nunca llegó se nota", () => {
    const h = computeHealth(base({ states: { ...base().states, cron: undefined } }));
    expect(item(h, "cron").level).toBe("warn");
    expect(h.alerts[0].key).toBe("cron");
  });

  it("reloj atrasado (3 h) es aviso; parado (2 días) es error", () => {
    const tarde = computeHealth(base({ states: { ...base().states, cron: row({ last_synced_at: iso(3 * H) }) } }));
    expect(item(tarde, "cron").level).toBe("warn");
    const parado = computeHealth(base({ states: { ...base().states, cron: row({ last_synced_at: iso(48 * H) }) } }));
    expect(item(parado, "cron")).toMatchObject({ level: "error" });
    expect(item(parado, "cron").summary).toMatch(/hace 2 días/);
    expect(parado.overall).toBe("error");
  });

  it("token de Canvas vencido: aviso al principio, error si ya pasó medio día", () => {
    const st = (successAgo: number) => ({
      ...base().states,
      canvas: row({
        last_synced_at: iso(0.5 * H), last_success_at: iso(successAgo), last_error_at: iso(0.5 * H),
        last_error: "Canvas rechazó el token (401): venció", last_error_code: "CANVAS_TOKEN_EXPIRED",
      }),
    });
    expect(item(computeHealth(base({ states: st(2 * H) })), "canvas").level).toBe("warn");
    const malo = computeHealth(base({ states: st(30 * H) }));
    expect(item(malo, "canvas").level).toBe("error");
    expect(item(malo, "canvas").summary).toMatch(/token/);
  });

  it("un error ya resuelto no cuenta", () => {
    const h = computeHealth(base({
      states: { ...base().states, canvas: row({ last_synced_at: iso(H), last_success_at: iso(H), last_error_at: iso(5 * H), last_error: "x" }) },
    }));
    expect(item(h, "canvas").level).toBe("ok");
  });

  it("sin errores pero sin sync en un día (el reloj está parado) también se nota en Canvas", () => {
    const h = computeHealth(base({ states: { ...base().states, canvas: row({ last_synced_at: iso(20 * H), last_success_at: iso(20 * H) }) } }));
    expect(item(h, "canvas").level).toBe("warn");
  });

  it("navegadores dados de baja: se avisa aunque ya no haya suscripción", () => {
    const h = computeHealth(base({
      pushDevices: 0,
      states: { ...base().states, push: row({ last_error_at: iso(H), last_error_code: "PUSH_SUBSCRIPTION_GONE", last_error: "x" }) },
    }));
    expect(item(h, "push").level).toBe("warn");
    // Sin ese antecedente, no tener dispositivos es una elección: apagado, sin alerta.
    expect(item(computeHealth(base({ pushDevices: 0, states: { ...base().states, push: undefined } })), "push").level).toBe("off");
  });

  it("bot bloqueado: se explica, aunque el chat ya esté desconectado", () => {
    const h = computeHealth(base({
      telegramLinked: false,
      states: {
        ...base().states,
        telegram: row({ last_error_at: iso(H), last_error_code: "TELEGRAM_BOT_BLOCKED", last_error: "Bloqueaste al bot en Telegram" }),
      },
    }));
    expect(item(h, "telegram")).toMatchObject({ level: "warn", summary: "Bloqueaste al bot en Telegram" });
  });

  it("Claude fallando sale en el detalle pero no en el aviso permanente", () => {
    const h = computeHealth(base({ states: { ...base().states, ai: row({ last_error_at: iso(H), last_error: "timeout" }) } }));
    expect(item(h, "ai").level).toBe("warn");
    expect(h.alerts.some((a) => a.key === "ai")).toBe(false);
  });

  it("sin nada configurado, el reloj no hace falta y no alarma", () => {
    const h = computeHealth(base({ canvasConfigured: false, pushConfigured: false, telegramConfigured: false, states: {} }));
    expect(h.alerts).toEqual([]);
  });
});

describe("horas", () => {
  it("el reloj corre en el minuto 7 de cada hora", () => {
    expect(new Date(nextClockTick(Date.parse("2026-10-01T18:30:00Z"))).toISOString()).toBe("2026-10-01T19:07:00.000Z");
    expect(new Date(nextClockTick(Date.parse("2026-10-01T18:05:00Z"))).toISOString()).toBe("2026-10-01T18:07:00.000Z");
    expect(new Date(nextClockTick(Date.parse("2026-10-01T23:30:00Z"))).toISOString()).toBe("2026-10-02T00:07:00.000Z");
  });

  it("el próximo sync de Canvas: 3 h después del último bueno, en la siguiente vuelta del reloj", () => {
    expect(new Date(nextCanvasSync("2026-10-01T17:07:00Z", NOW)).toISOString()).toBe("2026-10-01T20:07:00.000Z");
    // Si ya tocaba, en la próxima vuelta.
    expect(new Date(nextCanvasSync("2026-10-01T10:00:00Z", NOW)).toISOString()).toBe("2026-10-01T19:07:00.000Z");
    expect(new Date(nextCanvasSync(null, NOW)).toISOString()).toBe("2026-10-01T19:07:00.000Z");
  });

  it("ago", () => {
    expect(ago(iso(30_000), NOW)).toBe("hace un momento");
    expect(ago(iso(25 * 60_000), NOW)).toBe("hace 25 min");
    expect(ago(iso(5 * H), NOW)).toBe("hace 5 h");
    expect(ago(iso(72 * H), NOW)).toBe("hace 3 días");
    expect(ago(null, NOW)).toBe("nunca");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, redact, safeMessage } from "@/lib/log";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("redact", () => {
  it("tacha el valor de cada variable secreta", () => {
    vi.stubEnv("CANVAS_TOKEN", "7~CanvasTokenDePrueba1234567890");
    vi.stubEnv("CRON_SECRET", "cron-secreto-de-prueba-123");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiJ9.service.role");
    const t = redact(
      "fallo con 7~CanvasTokenDePrueba1234567890 y cron-secreto-de-prueba-123 y eyJhbGciOiJIUzI1NiJ9.service.role",
    );
    expect(t).not.toContain("CanvasTokenDePrueba");
    expect(t).not.toContain("cron-secreto");
    expect(t).not.toContain("service.role");
    expect(t).toContain("[redactado]");
  });

  it("tacha lo que tiene forma de token aunque no haya variable", () => {
    expect(redact("POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage"))
      .toBe("POST https://api.telegram.org/[redactado]/sendMessage");
    expect(redact("key sk-ant-api03-abcdefghijklmnop rechazada")).toBe("key [redactado] rechazada");
    expect(redact("Authorization: Bearer abc.def.ghi-123456")).toBe("Authorization: [redactado]");
  });

  it("no toca un texto normal", () => {
    expect(redact("Canvas respondió 503 en /api/v1/planner/items")).toBe(
      "Canvas respondió 503 en /api/v1/planner/items",
    );
  });
});

describe("logEvent", () => {
  it("escribe una línea JSON con los campos pedidos y sin secretos", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:token-de-telegram-de-prueba");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent({
      event: "digest.telegram",
      result: "error",
      userId: "u1",
      integration: "telegram",
      errorCode: "TELEGRAM_FAILED",
      message: "falló https://x/bot123456:token-de-telegram-de-prueba/sendMessage",
    });
    expect(err).toHaveBeenCalledOnce();
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line).toMatchObject({
      event: "digest.telegram",
      result: "error",
      userId: "u1",
      integration: "telegram",
      errorCode: "TELEGRAM_FAILED",
    });
    expect(typeof line.ts).toBe("string");
    expect(JSON.stringify(line)).not.toContain("token-de-telegram-de-prueba");
  });

  it("los eventos que salen bien van a console.log", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent({ event: "cron.run", result: "ok" });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("safeMessage", () => {
  it("recorta y limpia el mensaje de un error", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-secreto-largo-de-prueba");
    expect(safeMessage(new Error("auth sk-ant-api03-secreto-largo-de-prueba"), "x")).toBe("auth [redactado]");
    expect(safeMessage(null, "por defecto")).toBe("por defecto");
    expect(safeMessage(new Error("a".repeat(500)), "x")).toHaveLength(300);
  });
});

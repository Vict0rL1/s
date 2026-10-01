import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { aiErrorInfo, costOf } from "@/lib/ai";
import { planDay, type PlanInput } from "@/lib/planner";
import { breakDown } from "@/lib/breakdown";
import type { Task } from "@/lib/types";

/* ------------------------------------------------------- Claude de mentira */

type Reply = {
  stop_reason?: string;
  parsed_output?: unknown;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

function fakeClient(reply: Reply | Error) {
  const parse = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return {
      stop_reason: "end_turn",
      model: "claude-opus-5-5",
      usage: { input_tokens: 2000, output_tokens: 1000 },
      ...reply,
    };
  });
  return { client: { beta: { messages: { parse } } } as never, parse };
}

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", user_id: "u", title: "Problem set 4", area: "SFU", due_date: "2026-09-30", due_time: null,
  est_minutes: 60, priority: 2, done: false, done_at: null, body: null, source: "manual",
  external_id: null, external_url: null, focus_day: null, user_edited_at: null, deleted_at: null,
  kind: null, course: null, weight_pct: null, difficulty: null,
  tracked_sec: 0, track_sessions: 0, track_started_at: null,
  created_at: "", updated_at: "", ...over,
});

const INPUT: PlanInput = {
  profile: { id: "u", areas: [], day_start: 8, day_end: 18, timezone: "America/Vancouver", created_at: "" },
  today: "2026-09-30",
  now: 8 * 60,
  tasks: [task(), task({ id: "t2", title: "Leer cap 4" })],
  // Clase de 10 a 12: lo único ocupado.
  events: [{ id: "e", title: "ECON 342", day: "2026-09-30", start: 600, end: 720, source: "ics", courseRef: null }],
  blocks: [],
};

const bloque = (inicio: string, fin: string, taskId: string | null = "t1") =>
  ({ inicio, fin, titulo: "trabajar", tipo: "tarea" as const, taskId });

/* ------------------------------------------------------------------ tests */

describe("planDay", () => {
  it("pide con margen de tokens, fallback y esfuerzo explícito", async () => {
    const { client, parse } = fakeClient({ parsed_output: { bloques: [bloque("08:00", "09:00")], nota: "" } });
    await planDay(INPUT, client);
    const params = (parse.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      output_config: { effort: "medium" },
    });
  });

  it("descarta lo que pisa un compromiso o se sale de un hueco, y lo encimado", async () => {
    const { client } = fakeClient({
      parsed_output: {
        bloques: [
          bloque("08:00", "09:00"),
          bloque("08:30", "09:30"), // se encima con el anterior
          bloque("10:30", "11:00"), // en plena clase
          bloque("09:30", "10:30"), // cruza el inicio de la clase
          bloque("25:00", "26:00"), // hora inventada
          bloque("13:00", "14:00", "t2"),
        ],
        nota: "x",
      },
    });
    const plan = await planDay(INPUT, client);
    expect(plan.blocks.map((b) => [b.start, b.end])).toEqual([[480, 540], [780, 840]]);
  });

  it("una tarea que no existe se queda sin enlace en vez de romper", async () => {
    const { client } = fakeClient({ parsed_output: { bloques: [bloque("08:00", "09:00", "id-inventado")], nota: "" } });
    const plan = await planDay(INPUT, client);
    expect(plan.blocks[0].taskId).toBeNull();
  });

  it("si nada de lo propuesto cabe, lo dice", async () => {
    const { client } = fakeClient({ parsed_output: { bloques: [bloque("10:00", "11:00")], nota: "" } });
    await expect(planDay(INPUT, client)).rejects.toThrow(/no cabía/);
  });

  it("respuesta cortada por max_tokens → ANTHROPIC_TRUNCATED", async () => {
    const { client } = fakeClient({ stop_reason: "max_tokens", parsed_output: null });
    const e = await planDay(INPUT, client).catch((x) => x);
    expect(aiErrorInfo(e).code).toBe("ANTHROPIC_TRUNCATED");
  });

  it("rechazo → ANTHROPIC_REFUSAL", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", parsed_output: null });
    expect(aiErrorInfo(await planDay(INPUT, client).catch((x) => x)).code).toBe("ANTHROPIC_REFUSAL");
  });

  it("JSON roto (el SDK no lo pudo leer) → ANTHROPIC_INVALID_RESPONSE", async () => {
    const { client } = fakeClient(new Anthropic.AnthropicError("Failed to parse structured output: SyntaxError"));
    const info = aiErrorInfo(await planDay(INPUT, client).catch((x) => x));
    expect(info.code).toBe("ANTHROPIC_INVALID_RESPONSE");
    expect(info.message).not.toMatch(/SyntaxError/); // nada de jerga al usuario
  });

  it("sin parsed_output → ANTHROPIC_INVALID_RESPONSE", async () => {
    const { client } = fakeClient({ parsed_output: null });
    expect(aiErrorInfo(await planDay(INPUT, client).catch((x) => x)).code).toBe("ANTHROPIC_INVALID_RESPONSE");
  });

  it("timeout → ANTHROPIC_TIMEOUT, con un mensaje que dice qué hacer", async () => {
    const { client } = fakeClient(new Anthropic.APIConnectionTimeoutError());
    const info = aiErrorInfo(await planDay(INPUT, client).catch((x) => x));
    expect(info).toMatchObject({ code: "ANTHROPIC_TIMEOUT" });
    expect(info.message).toMatch(/Intenta otra vez/);
  });

  it("sin huecos no llama a Claude (y no es un fallo de la integración)", async () => {
    const { client, parse } = fakeClient({ parsed_output: { bloques: [], nota: "" } });
    const lleno = { ...INPUT, events: [{ ...INPUT.events[0], start: 480, end: 1080 }] };
    const e = await planDay(lleno, client).catch((x) => x);
    expect(parse).not.toHaveBeenCalled();
    expect(aiErrorInfo(e).code).toBeUndefined();
  });

  it("el costo sale del modelo que respondió (puede ser el de respaldo)", async () => {
    const { client } = fakeClient({
      model: "claude-opus-5",
      parsed_output: { bloques: [bloque("08:00", "09:00")], nota: "" },
    });
    const plan = await planDay(INPUT, client);
    expect(plan.costUsd).toBeCloseTo(costOf("claude-opus-5", { input_tokens: 2000, output_tokens: 1000 }));
    expect(plan.costUsd).toBeCloseTo(0.01 + 0.025);
  });
});

describe("breakDown", () => {
  const grande = task({ id: "p", title: "Proyecto final", due_date: "2026-10-10", est_minutes: 600 });

  it("recorta fechas fuera de la ventana: nunca después del día anterior al vencimiento, nunca en el pasado", async () => {
    const { client } = fakeClient({
      parsed_output: {
        pasos: [
          { titulo: "elegir tema", fecha: "2026-09-01", minutos: 30 },
          { titulo: "escribir", fecha: "2026-10-10", minutos: 240 },
          { titulo: "revisar", fecha: "no-es-fecha", minutos: 60 },
        ],
        nota: "",
      },
    });
    const r = await breakDown(grande, "2026-09-30", client);
    expect(r.steps.map((s) => s.date)).toEqual(["2026-09-30", "2026-10-09", "2026-10-09"]);
  });

  it("sin margen (vence hoy) no llama a Claude", async () => {
    const { client, parse } = fakeClient({ parsed_output: { pasos: [], nota: "" } });
    await expect(breakDown({ ...grande, due_date: "2026-09-30" }, "2026-09-30", client)).rejects.toThrow();
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("aiErrorInfo", () => {
  it("traduce los errores de la API a códigos estables", () => {
    const h = new Headers();
    expect(aiErrorInfo(new Anthropic.AuthenticationError(401, {}, "x", h)).code).toBe("ANTHROPIC_AUTH");
    expect(aiErrorInfo(new Anthropic.RateLimitError(429, {}, "x", h)).code).toBe("ANTHROPIC_RATE_LIMITED");
    expect(aiErrorInfo(new Anthropic.InternalServerError(529, {}, "x", h)).code).toBe("ANTHROPIC_OVERLOADED");
    expect(aiErrorInfo(new Anthropic.APIConnectionError({ message: "x" })).code).toBe("ANTHROPIC_FAILED");
  });
});

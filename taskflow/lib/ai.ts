import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, PLANNER_MODEL } from "./env.server";
import { type ErrorCode, IntegrationError, safeMessage } from "./log";

/**
 * Lo común a todo lo que le pregunta algo a Claude: el cliente, los límites de
 * tiempo, el precio y qué decir cuando algo sale mal.
 *
 * Claude en esta app sólo PROPONE. Nada de lo que devuelve se escribe en la
 * base sin pasar antes por una validación determinista y por el "Aceptar" del
 * usuario.
 */

/**
 * Lo mínimo que se usa del SDK. Las pruebas pasan uno de mentira con la misma
 * forma, para poder simular un timeout o un JSON roto sin gastar dinero.
 */
export type AiClient = { beta: { messages: { parse: Anthropic["beta"]["messages"]["parse"] } } };

/**
 * Cuánto se le espera a una respuesta. El SDK trae 10 minutos y dos
 * reintentos: con eso la función de Vercel moría antes y el navegador veía un
 * "no se pudo hablar con el servidor" sin ninguna pista. Con un solo intento
 * de 50 s, el error llega a tiempo de mostrarse bien. Si falla, el botón se
 * vuelve a pulsar: es una petición que el usuario está mirando.
 */
export const AI_TIMEOUT_MS = 50_000;

export function aiClient(): AiClient {
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: AI_TIMEOUT_MS, maxRetries: 0 });
}

export const aiModel = () => PLANNER_MODEL;

/**
 * Con el pensamiento adaptativo, lo que el modelo piensa cuenta contra este
 * tope. Con 4000, una respuesta podía cortarse a mitad del JSON.
 */
export const AI_MAX_TOKENS = 16_000;

/**
 * Si el modelo rechaza la petición por política, la API la repite en otro
 * modelo dentro de la misma llamada. Para planear un día es casi imposible que
 * pase, pero sin esto un rechazo sería un error sin salida.
 */
export const AI_FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

/**
 * Precios de la API por millón de tokens, para poder decirle al usuario lo que
 * costó en vez de que se entere en la factura.
 */
export const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** Costo aproximado de una respuesta. El modelo que respondió puede no ser el pedido (fallback). */
export function costOf(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const p = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK[aiModel()] ?? PRICE_PER_MTOK["claude-opus-5-5"];
  return (usage.input_tokens / 1e6) * p.in + (usage.output_tokens / 1e6) * p.out;
}

/** Revisa cómo terminó la respuesta antes de confiar en ella. */
export function checkStop(stopReason: string | null | undefined): void {
  if (stopReason === "refusal") {
    throw new IntegrationError("ANTHROPIC_REFUSAL", "Claude no quiso responder a esto.");
  }
  if (stopReason === "max_tokens") {
    throw new IntegrationError("ANTHROPIC_TRUNCATED", "La respuesta se cortó antes de terminar. Intenta otra vez.");
  }
}

/**
 * Qué pasó, en palabras de quien va a leerlo, con un código estable. Los
 * mensajes de la API traen jerga y a veces el nombre del modelo; al usuario le
 * sirve saber qué hacer.
 *
 * `code` es `undefined` cuando no es un fallo de la API sino una condición del
 * día ("no te queda ningún hueco"): eso no es una integración rota.
 */
export function aiErrorInfo(e: unknown): { code?: ErrorCode; message: string } {
  if (e instanceof IntegrationError) return { code: e.code, message: e.message };
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return { code: "ANTHROPIC_TIMEOUT", message: "Claude tardó demasiado en responder. Intenta otra vez en un momento." };
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return { code: "ANTHROPIC_AUTH", message: "La ANTHROPIC_API_KEY no es válida. Revísala en console.anthropic.com." };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { code: "ANTHROPIC_RATE_LIMITED", message: "Demasiadas peticiones seguidas. Espera un momento y vuelve a intentar." };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { code: "ANTHROPIC_FAILED", message: "No se pudo hablar con la API de Claude." };
  }
  if (e instanceof Anthropic.APIError) {
    if (e.status === 529) {
      return { code: "ANTHROPIC_OVERLOADED", message: "Claude está saturado ahora mismo. Intenta en un minuto." };
    }
    if (e.status === 400) {
      return { code: "ANTHROPIC_FAILED", message: "La API rechazó la petición. Si cambiaste PLANNER_MODEL, revisa el nombre." };
    }
    return { code: "ANTHROPIC_FAILED", message: `La API de Claude respondió con un error (${e.status}).` };
  }
  // El SDK lanza esto cuando el texto no es el JSON pedido (roto o incompleto).
  if (e instanceof Anthropic.AnthropicError) {
    return { code: "ANTHROPIC_INVALID_RESPONSE", message: "La respuesta de Claude llegó con un formato inesperado. Intenta otra vez." };
  }
  return { message: safeMessage(e, "No se pudo completar la petición.") };
}

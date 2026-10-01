import "server-only";

/**
 * Registro estructurado: una línea JSON por evento, para poder filtrar en los
 * logs de Vercel por `event`, `integration` o `errorCode` en vez de leer
 * frases sueltas.
 *
 * Dos reglas:
 *
 *  1. **Nunca un secreto.** Antes de escribir, cada texto pasa por `redact`,
 *     que tacha los valores de las variables secretas y los patrones que tienen
 *     forma de token. Es un cinturón: el código ya evita meterlos en mensajes,
 *     pero un error de una librería puede traer una URL con el token dentro.
 *  2. **Nada de contenido privado entero.** Se registran ids y conteos, no el
 *     texto de las tareas ni de las notas.
 */

export type ErrorCode =
  // Canvas
  | "CANVAS_NOT_CONFIGURED"
  | "CANVAS_TOKEN_EXPIRED"
  | "CANVAS_FORBIDDEN"
  | "CANVAS_RATE_LIMITED"
  | "CANVAS_UNAVAILABLE"
  | "CANVAS_TIMEOUT"
  | "CANVAS_NETWORK"
  | "CANVAS_BAD_RESPONSE"
  | "CANVAS_DB_FAILED"
  // Web Push
  | "PUSH_SUBSCRIPTION_GONE"
  | "PUSH_VAPID_REJECTED"
  | "PUSH_TIMEOUT"
  | "PUSH_FAILED"
  // Telegram
  | "TELEGRAM_BOT_BLOCKED"
  | "TELEGRAM_CHAT_GONE"
  | "TELEGRAM_RATE_LIMITED"
  | "TELEGRAM_TIMEOUT"
  | "TELEGRAM_TOKEN_INVALID"
  | "TELEGRAM_FAILED"
  // Reloj
  | "CRON_AUTH_FAILED"
  | "CRON_CONFIG_MISSING"
  | "CRON_DB_FAILED"
  // Claude
  | "ANTHROPIC_NOT_CONFIGURED"
  | "ANTHROPIC_TIMEOUT"
  | "ANTHROPIC_AUTH"
  | "ANTHROPIC_RATE_LIMITED"
  | "ANTHROPIC_OVERLOADED"
  | "ANTHROPIC_INVALID_RESPONSE"
  | "ANTHROPIC_TRUNCATED"
  | "ANTHROPIC_REFUSAL"
  | "ANTHROPIC_FAILED"
  // Google Calendar
  | "GCAL_NOT_CONFIGURED"
  | "GCAL_NOT_LINKED"
  | "GCAL_REVOKED"
  | "GCAL_CLIENT_INVALID"
  | "GCAL_FORBIDDEN"
  | "GCAL_RATE_LIMITED"
  | "GCAL_UNAVAILABLE"
  | "GCAL_TIMEOUT"
  | "GCAL_NETWORK"
  | "GCAL_BAD_RESPONSE"
  | "GCAL_DB_FAILED";

export type Integration = "canvas" | "push" | "telegram" | "cron" | "ai" | "ics" | "gcal" | "app";

export type LogEvent = {
  event: string;
  result: "ok" | "error" | "skipped";
  userId?: string | null;
  integration?: Integration;
  errorCode?: ErrorCode;
  message?: string;
  /** Conteos, duraciones, ids. Nunca texto escrito por el usuario. */
  [extra: string]: unknown;
};

/** Un error con código estable, para que la UI y los logs no dependan del texto. */
export class IntegrationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** ¿Tiene sentido volver a intentarlo en un rato? */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export const errorCodeOf = (e: unknown): ErrorCode | undefined =>
  e instanceof IntegrationError ? e.code : undefined;

/* --------------------------------------------------------------- redacción */

const SECRET_VARS = [
  "CANVAS_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "VAPID_PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_CLIENT_SECRET",
] as const;

/** Cosas con forma de credencial aunque no coincidan con ninguna variable. */
const PATTERNS: RegExp[] = [
  /bot\d{5,}:[A-Za-z0-9_-]{20,}/g, // token de Telegram dentro de una URL
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // key de Anthropic
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // cabecera Authorization copiada en un error
  /ya29\.[A-Za-z0-9._-]{10,}/g, // access token de Google
  /1\/\/[A-Za-z0-9._-]{20,}/g, // refresh token de Google
];

const TACHADO = "[redactado]";

export function redact(text: string): string {
  let out = String(text);
  for (const name of SECRET_VARS) {
    const value = process.env[name];
    // Un valor muy corto taparía letras sueltas por todo el texto; ningún
    // secreto real mide menos de 8.
    if (value && value.length >= 8) out = out.split(value).join(TACHADO);
  }
  for (const re of PATTERNS) out = out.replace(re, TACHADO);
  return out;
}

function clean(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v);
  if (depth > 3 || v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, depth + 1)]));
}

export function logEvent(e: LogEvent): void {
  const line = JSON.stringify(clean({ ts: new Date().toISOString(), ...e }));
  if (e.result === "error") console.error(line);
  else console.log(line);
}

/** El mensaje de un error cualquiera, ya sin secretos. Para guardar o mostrar. */
export function safeMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : fallback;
  return redact(raw || fallback).slice(0, 300);
}

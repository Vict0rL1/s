import "server-only";

import { TELEGRAM_API_BASE, TELEGRAM_BOT_TOKEN, telegramWebhookSecret } from "./env.server";
import type { ErrorCode } from "./log";
import type { Digest } from "./push";

/**
 * Telegram como segundo canal de avisos.
 *
 * Existe porque el push del navegador tiene dos agujeros: en iPhone sólo
 * funciona si la app está en la pantalla de inicio, y basta con que el
 * navegador tenga los avisos silenciados para que no llegue nada. Telegram
 * llega aunque la app no esté abierta en ningún lado.
 *
 * Todo pasa por `api.telegram.org` con el token del bot. El token nunca sale
 * del servidor ni aparece en un mensaje de error: la URL que lo lleva no se
 * registra en ningún sitio.
 */

export class TelegramError extends Error {
  constructor(
    message: string,
    /** El `error_code` de Telegram: 403 = te bloquearon, 400 = chat no existe, etc. */
    readonly code: number,
  ) {
    super(message);
  }
}

type TgResponse<T> = { ok: boolean; result?: T; error_code?: number; description?: string };

async function tg<T>(method: string, body: Record<string, unknown>): Promise<T> {
  if (!TELEGRAM_BOT_TOKEN) throw new TelegramError("Falta TELEGRAM_BOT_TOKEN", 0);

  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Sin el error original: su mensaje puede traer la URL, y la URL lleva el token.
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new TelegramError(`Telegram no respondió en 10 s (${method})`, -1);
    }
    throw new TelegramError(`No se pudo hablar con Telegram (${method})`, 0);
  }

  const data = (await res.json().catch(() => ({}))) as TgResponse<T>;
  if (!data.ok) {
    throw new TelegramError(data.description || `Telegram respondió ${res.status}`, data.error_code ?? res.status);
  }
  return data.result as T;
}

/**
 * Qué significa un fallo de Telegram, con el código que va al log y a Ajustes.
 * `dead` es que el chat ya no sirve y hay que soltarlo.
 */
export function classifyTelegramError(e: unknown): { code: ErrorCode; dead: boolean; message: string } {
  if (!(e instanceof TelegramError)) {
    return { code: "TELEGRAM_FAILED", dead: false, message: "Falló el envío a Telegram" };
  }
  if (e.code === 403) {
    return { code: "TELEGRAM_BOT_BLOCKED", dead: true, message: "Bloqueaste al bot en Telegram, así que se desconectó. Para volver, conéctalo otra vez desde Ajustes." };
  }
  if (e.code === 400 && /chat not found|user not found|chat_id is empty/i.test(e.message)) {
    return { code: "TELEGRAM_CHAT_GONE", dead: true, message: "Ese chat de Telegram ya no existe, así que se desconectó." };
  }
  if (e.code === 429) return { code: "TELEGRAM_RATE_LIMITED", dead: false, message: "Telegram pidió esperar (demasiados mensajes)." };
  if (e.code === 401 || e.code === 404) {
    return { code: "TELEGRAM_TOKEN_INVALID", dead: false, message: "Telegram no reconoce el token del bot. Revisa TELEGRAM_BOT_TOKEN." };
  }
  if (e.code === -1) return { code: "TELEGRAM_TIMEOUT", dead: false, message: e.message };
  return { code: "TELEGRAM_FAILED", dead: false, message: e.message || "Falló el envío a Telegram" };
}

/* ------------------------------------------------------------ mensajes */

/** El modo HTML de Telegram sólo exige escapar estos tres. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * El aviso, en el formato de Telegram.
 *
 * Los títulos de las tareas los escribe el usuario, así que van escapados: una
 * tarea llamada "leer <cap. 3>" rompería el mensaje entero si no.
 *
 * El botón "Abrir TaskFlow" sólo se pone si la app vive en HTTPS: Telegram
 * rechaza el mensaje completo si un botón apunta a `http://localhost`, y un
 * aviso sin botón es mejor que ningún aviso.
 */
export function formatDigest(digest: Digest, origin: string) {
  const lineas = [`<b>${escapeHtml(digest.title)}</b>`];
  if (digest.body) lineas.push(escapeHtml(digest.body));

  const url = origin.replace(/\/+$/, "") + digest.url;
  return {
    text: lineas.join("\n"),
    parse_mode: "HTML" as const,
    link_preview_options: { is_disabled: true },
    ...(url.startsWith("https://")
      ? { reply_markup: { inline_keyboard: [[{ text: "Abrir TaskFlow", url }]] } }
      : {}),
  };
}

export async function sendDigestTelegram(chatId: number, digest: Digest, origin: string) {
  await tg("sendMessage", { chat_id: chatId, ...formatDigest(digest, origin) });
}

/* ------------------------------------------------------------- conexión */

/**
 * El código de `/start <código>`, o `null` si el mensaje no trae uno.
 * Acepta también `/start@NombreDelBot <código>`, que es como llega desde un grupo.
 */
export function parseStart(text: string): string | null {
  const m = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(text.trim());
  if (!m) return null;
  return m[1] ?? "";
}

let usuario: string | null = null;

/** El @usuario del bot, para armar el enlace t.me/<bot>?start=<código>. */
export async function botUsername(): Promise<string> {
  if (usuario) return usuario;
  const me = await tg<{ username?: string }>("getMe", {});
  if (!me.username) throw new TelegramError("El bot no tiene nombre de usuario", 0);
  usuario = me.username;
  return usuario;
}

/**
 * Registra el webhook apuntando a esta instalación.
 *
 * Se llama cada vez que alguien pulsa "Conectar", no una sola vez al
 * desplegar: así no hay que acordarse de correr un script, y si cambió el
 * dominio o se revocó el token, el siguiente "Conectar" lo arregla solo.
 */
export async function ensureWebhook(origin: string) {
  await tg("setWebhook", {
    url: origin.replace(/\/+$/, "") + "/api/telegram",
    secret_token: telegramWebhookSecret(),
    allowed_updates: ["message"],
  });
}

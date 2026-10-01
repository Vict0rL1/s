import "server-only";

import { createHmac } from "node:crypto";

/**
 * Variables que NUNCA pueden llegar al navegador.
 *
 * Viven aparte de `lib/env.ts` a propósito: ese módulo lo importa
 * `lib/supabase/client.ts`, que es un componente cliente, así que entra al
 * bundle del navegador. `server-only` convierte en error de build cualquier
 * import de este archivo desde el cliente, en vez de dejarlo pasar callado.
 */

export const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL;
export const CANVAS_TOKEN = process.env.CANVAS_TOKEN;

export const canvasConfigured = () => Boolean(CANVAS_BASE_URL && CANVAS_TOKEN);

export function requireCanvasEnv(): { baseUrl: string; token: string } {
  if (!CANVAS_BASE_URL || !CANVAS_TOKEN) {
    throw new Error(
      "Faltan CANVAS_BASE_URL y/o CANVAS_TOKEN. Saca el token de Canvas -> Account -> " +
        "Settings -> + New Access Token y ponlo en .env.local; al repo no va nunca.",
    );
  }
  return { baseUrl: CANVAS_BASE_URL.replace(/\/+$/, ""), token: CANVAS_TOKEN };
}

/* ------------------------------------------------------------ service role */

/** Salta la RLS. Sólo para el cron, nunca para una petición del usuario. */
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function requireServiceRoleKey(): string {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Falta SUPABASE_SERVICE_ROLE_KEY. Está en Supabase -> Project Settings -> API, " +
        "como service_role / secret key. Va en las variables del servidor; al repo no, y al navegador menos.",
    );
  }
  return SUPABASE_SERVICE_ROLE_KEY;
}

/* -------------------------------------------------------------------- cron */

export const CRON_SECRET = process.env.CRON_SECRET;

export const cronConfigured = () => Boolean(CRON_SECRET);

/* --------------------------------------------------------------- Web Push */

/** La mitad privada del par VAPID. Firma los envíos; nunca sale del servidor. */
export const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

/** Contacto que el servicio de push usa si algo va mal. `mailto:` o una URL. */
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:nadie@example.com";

export const pushSendConfigured = () =>
  Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

/* ------------------------------------------------- planificador con Claude */

/** La key de la API de Anthropic. Sólo en el servidor: si llega al navegador,
    cualquiera que abra las herramientas de desarrollo puede gastar tu saldo. */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/** Se puede cambiar por uno más barato sin tocar código. */
export const PLANNER_MODEL = process.env.PLANNER_MODEL || "claude-opus-5-5";

export const plannerConfigured = () => Boolean(ANTHROPIC_API_KEY);

export function requireAnthropicKey(): string {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "Falta ANTHROPIC_API_KEY. Se saca de console.anthropic.com -> API keys y va en " +
        ".env.local y en Vercel. Al repo no va nunca.",
    );
  }
  return ANTHROPIC_API_KEY;
}

/* ---------------------------------------------------------------- Telegram */

/** El token que da @BotFather. Quien lo tiene manda mensajes como el bot. */
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/**
 * Sólo para pruebas: apunta a un servidor de mentira en vez de a Telegram. En
 * producción no se define y se usa la API de verdad.
 */
export const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");

export const telegramConfigured = () => Boolean(TELEGRAM_BOT_TOKEN);

/**
 * El secreto que Telegram repite en cada llamada al webhook, para que la ruta
 * sepa que es Telegram y no cualquiera con la URL.
 *
 * Sale del token por HMAC en vez de ser otra variable de entorno: una variable
 * menos que Victor tenga que crear, y sin el token no se puede adivinar. Si el
 * token se revoca, el secreto cambia con él; por eso "Conectar" vuelve a
 * registrar el webhook cada vez.
 */
export function telegramWebhookSecret(): string {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
  return createHmac("sha256", TELEGRAM_BOT_TOKEN).update("taskflow-telegram-webhook").digest("hex");
}

/* --------------------------------------------------------- Google Calendar */

/**
 * El cliente OAuth de Google Cloud Console. El ID no es secreto (viaja en la
 * URL de autorización); el secreto sí: canjea los códigos y los refresh
 * tokens, y de él sale la llave que cifra esos tokens en la base.
 */
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

export const gcalConfigured = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

export function requireGoogleEnv(): { clientId: string; clientSecret: string } {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "Faltan GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET. Salen de Google Cloud Console -> " +
        "Credenciales -> ID de cliente de OAuth (aplicación web). Van en las variables del servidor; al repo no.",
    );
  }
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
}

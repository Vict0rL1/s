import "server-only";

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
export const PLANNER_MODEL = process.env.PLANNER_MODEL || "claude-opus-5";

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

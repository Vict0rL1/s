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

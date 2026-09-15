/**
 * Variables públicas (`NEXT_PUBLIC_*`), con un mensaje decente cuando faltan.
 *
 * Este módulo llega al bundle del navegador — lo importa `supabase/client.ts`.
 * Cualquier secreto de servidor va en `lib/env.server.ts`, que está protegido
 * con `server-only`.
 *
 * `NEXT_PUBLIC_*` tiene que leerse con el nombre completo y literal:
 * Next las sustituye en tiempo de build, `process.env[nombre]` no funciona.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** ¿Están puestas las variables de Supabase? Si no, la app muestra el instructivo. */
export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export function requireSupabaseEnv(): { url: string; anonKey: string } {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y/o NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copia .env.example a .env.local y llénalas desde Supabase (Project Settings -> API).",
    );
  }
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
}

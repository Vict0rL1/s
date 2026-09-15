import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireSupabaseEnv } from "../env";

/**
 * Cliente de Supabase para Server Components, Server Actions y route handlers.
 *
 * Se crea uno por request — nunca se comparte entre requests, porque lleva
 * pegada la sesión del usuario.
 */
export async function createClient() {
  // El orden importa: leer las cookies primero marca la ruta como dinámica.
  // Al revés, un build sin variables de entorno intenta prerenderizar y truena.
  const cookieStore = await cookies();
  const { url, anonKey } = requireSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Un Server Component no puede escribir cookies. No pasa nada: el
          // middleware ya refrescó la sesión antes de llegar aquí.
        }
      },
    },
  });
}

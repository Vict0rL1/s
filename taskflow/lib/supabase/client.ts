"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseEnv } from "../env";

/**
 * Cliente de Supabase para el navegador. Sólo usa la anon key, que es pública:
 * lo que protege los datos es la RLS del esquema, no esconder esta llave.
 */
export function createClient() {
  const { url, anonKey } = requireSupabaseEnv();
  return createBrowserClient(url, anonKey);
}

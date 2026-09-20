import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "../env";
import { requireServiceRoleKey } from "../env.server";

/**
 * Cliente con la service role. **Salta la RLS por completo.**
 *
 * Sólo existe para el cron, que corre sin sesión y por lo tanto sin
 * `auth.uid()`. Todo lo que se haga con este cliente tiene que filtrar por
 * `user_id` a mano: Postgres ya no lo va a hacer por ti.
 *
 * `server-only` convierte en error de build cualquier import desde el cliente.
 */
export function createAdminClient() {
  const { url } = requireSupabaseEnv();
  const key = requireServiceRoleKey();

  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

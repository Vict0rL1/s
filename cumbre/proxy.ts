import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Corre antes de cada request: refresca el token de Supabase y manda al login
 * si no hay sesión.
 *
 * Next 16 renombró esta convención de `middleware.ts` a `proxy.ts`; los docs de
 * Supabase todavía la llaman middleware, de ahí el nombre del archivo en `lib/`.
 */
export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Todo menos los estáticos de Next y los archivos de imagen — ahí no hay
     * sesión que refrescar y sólo costaría latencia.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

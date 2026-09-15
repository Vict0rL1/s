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
     * Todo menos los estáticos de Next, las imágenes y el manifest — ahí no hay
     * sesión que refrescar y sólo costaría latencia.
     *
     * El manifest tiene que quedar fuera sí o sí: el navegador lo pide sin
     * cookies, así que detrás del login recibiría el HTML del redirect y
     * "Agregar a pantalla de inicio" no leería ni el nombre ni el ícono.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../env";

/** Rutas que se ven sin sesión. */
const PUBLIC = ["/login", "/auth"];

/**
 * Refresca el token en cada request y manda al login si no hay sesión.
 *
 * `getAll` y `setAll` tienen que estar los dos: si el middleware no puede
 * escribir de vuelta las cookies del refresh, la sesión se cae sola cada rato.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Sin variables de entorno no hay a quién preguntarle: todo al login, que en
  // ese caso muestra el instructivo de configuración en vez de un stack trace.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    if (request.nextUrl.pathname === "/login" || request.nextUrl.pathname.startsWith("/api/")) {
      return response;
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // No metas lógica entre createServerClient y getUser: es lo que refresca el
  // token, y saltárselo provoca cierres de sesión aleatorios.
  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Una API nunca se redirige al login: un cliente que espera JSON recibiría el
  // HTML de una página. Cada route handler hace su propia comprobación y
  // responde 401 — y `/api/sync` ni siquiera usa sesión, se autentica con
  // CRON_SECRET, así que redirigirlo dejaba el cron sin correr jamás.
  if (path.startsWith("/api/")) return response;

  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(p + "/"));

  if (!data.user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (data.user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/hoy";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

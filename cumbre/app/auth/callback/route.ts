import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Sólo rutas internas: evita que `?next=` mande a un dominio ajeno. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/hoy";
  return raw;
}

/**
 * Vuelta de Google. Supabase Auth usa PKCE: llega un `code` de un solo uso que
 * se canjea aquí, del lado del servidor, por la sesión en cookies.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));

  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(oauthError)}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent("No llegó el código de Google")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  // En Vercel el origin interno no es el dominio público: hay que mirar el
  // host reenviado o el redirect saldría a una URL que el usuario no reconoce.
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (process.env.NODE_ENV !== "development" && forwardedHost) {
    return NextResponse.redirect(`https://${forwardedHost}${next}`);
  }
  return NextResponse.redirect(`${origin}${next}`);
}

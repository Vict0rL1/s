"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Login con Google.
 *
 * Fase 1: sólo identidad, sin scopes de Calendar. En la fase 3 se le agregan
 * `scopes: "https://www.googleapis.com/auth/calendar.readonly"` y
 * `queryParams: { access_type: "offline", prompt: "consent" }` para recibir
 * `provider_refresh_token` en la sesión.
 */
export function GoogleButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setLoading(true);
    setError("");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback?next=/hoy` },
      });
      if (error) throw error;
      // signInWithOAuth redirige el navegador; si volvemos aquí, algo falló.
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo abrir el login de Google");
      setLoading(false);
    }
  }

  return (
    <>
      {error ? <div className="err">{error}</div> : null}
      <button className="btn line" onClick={signIn} disabled={loading}>
        {loading ? "Abriendo Google…" : "Entrar con Google"}
      </button>
    </>
  );
}

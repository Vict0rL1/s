"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Login con Google.
 *
 * Sólo identidad, sin scopes de Calendar. Google Calendar se conecta aparte
 * (`/api/gcal/connect`), con su propio permiso de sólo lectura: así funciona
 * aunque entres con correo, y el reloj puede renovarlo sin una sesión abierta.
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

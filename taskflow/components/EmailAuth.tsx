"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Supabase rechaza menos de 6 por defecto; avisamos antes de ir al servidor. */
const MIN_PASSWORD = 6;

/**
 * Entrar con correo y contraseña.
 *
 * Existe para no depender de Google Cloud Console sólo para probar la app: el
 * proveedor de correo de Supabase viene activado de fábrica. El login de Google
 * sigue ahí y sigue siendo el que hace falta en la fase 3, porque es el que
 * entrega el token de Calendar.
 */
export function EmailAuth() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"in" | "up" | null>(null);

  async function run(mode: "in" | "up") {
    setError("");
    setNotice("");

    if (!email.trim()) return setError("Falta el correo");
    if (password.length < MIN_PASSWORD) {
      return setError(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`);
    }

    setBusy(mode);
    try {
      const supabase = createClient();

      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        // Con "Confirm email" activado no hay sesión todavía: hay que ir al correo.
        if (!data.session) {
          setNotice("Te mandamos un correo para confirmar la cuenta. Ábrelo y vuelve aquí.");
          setBusy(null);
          return;
        }
      }

      // La sesión ya está en las cookies; refrescar hace que el servidor la vea.
      router.refresh();
      router.push("/hoy");
    } catch (e) {
      setError(traducir(e));
      setBusy(null);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run("in");
      }}
    >
      {error ? <div className="err">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="field">
        <label htmlFor="email">Correo</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy !== null}
        />
      </div>

      <div className="field">
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={MIN_PASSWORD}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy !== null}
        />
      </div>

      <div className="row">
        <button className="btn" type="submit" disabled={busy !== null} style={{ flex: 1 }}>
          {busy === "in" ? "Entrando…" : "Entrar"}
        </button>
        <button
          className="btn line"
          type="button"
          onClick={() => void run("up")}
          disabled={busy !== null}
          style={{ flex: 1 }}
        >
          {busy === "up" ? "Creando…" : "Crear cuenta"}
        </button>
      </div>
    </form>
  );
}

/** Los mensajes de Supabase vienen en inglés; los que salen seguido, al español. */
function traducir(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.toLowerCase();

  if (m.includes("invalid login credentials")) return "Correo o contraseña incorrectos";
  if (m.includes("user already registered")) return "Ese correo ya tiene cuenta — usa «Entrar»";
  if (m.includes("email not confirmed")) return "Falta confirmar el correo. Revisa tu bandeja.";
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) {
    return "El registro está cerrado en este proyecto de Supabase";
  }
  if (m.includes("password should be")) return `La contraseña necesita al menos ${MIN_PASSWORD} caracteres`;
  if (m.includes("rate limit") || m.includes("too many")) return "Demasiados intentos — espera un momento";
  // El navegador da "Failed to fetch" / "Load failed" cuando no alcanza el servidor.
  // Es justo lo que sale si NEXT_PUBLIC_SUPABASE_URL está mal escrita.
  if (m.includes("failed to fetch") || m.includes("load failed") || m.includes("networkerror")) {
    return "No se pudo conectar con Supabase. Revisa tu conexión y que NEXT_PUBLIC_SUPABASE_URL esté bien.";
  }
  return raw;
}

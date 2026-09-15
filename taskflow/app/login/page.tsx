import { EmailAuth } from "@/components/EmailAuth";
import { GoogleButton } from "@/components/GoogleButton";
import { isConfigured } from "@/lib/env";

export const metadata = { title: "Entrar · TaskFlow" };

type Props = { searchParams: Promise<{ error?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  const { error } = await searchParams;
  const configured = isConfigured();

  return (
    <div className="authwrap">
      <div className="authcard">
        <div className="brand">
          <b>TaskFlow</b>
          <span>agenda · tareas · rutinas</span>
        </div>

        {error ? <div className="err">{error}</div> : null}

        {configured ? (
          <>
            <h1>Entra con tu cuenta</h1>
            <p>Una sola cuenta, la tuya. Los datos quedan en tu proyecto de Supabase.</p>
            <EmailAuth />
            <div className="sep">
              <span>o</span>
            </div>
            <GoogleButton />
          </>
        ) : (
          <>
            <h1>Falta configurar Supabase</h1>
            <p>La app está lista, pero todavía no sabe a qué base conectarse.</p>
            <div className="authnote">
              <p style={{ margin: "0 0 8px" }}>
                1. Copia <code>.env.example</code> a <code>.env.local</code>.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                2. Llena <code>NEXT_PUBLIC_SUPABASE_URL</code> y{" "}
                <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> desde el dashboard de Supabase
                (Project Settings → API).
              </p>
              <p style={{ margin: "0 0 8px" }}>
                3. Pega <code>supabase/schema.sql</code> en el SQL Editor y córrelo.
              </p>
              <p style={{ margin: 0 }}>
                4. En Authentication → Providers, activa Google y pon la URL de callback{" "}
                <code>/auth/callback</code> de esta app en las Redirect URLs.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

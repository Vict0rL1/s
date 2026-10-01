/**
 * Un proyecto de Supabase entero en memoria: supabase-js de verdad, hablando
 * con el PostgREST de mentira de `tools/demo/fake-supabase.mjs` encima de un
 * Postgres de verdad. Sirve para probar el código de la app tal cual corre,
 * con la RLS, los `ON CONFLICT` y las claves únicas de verdad.
 */
import { createClient } from "@supabase/supabase-js";
import { createFakeSupabase } from "../../tools/demo/fake-supabase.mjs";
import type { Ctx } from "@/lib/data";
import type { Profile } from "@/lib/types";

const URL_ = "http://supabase.prueba";
const SERVICE = "llave-de-servicio-de-prueba";

export async function fakeProject(emails: string[] = ["a@ejemplo.com", "b@ejemplo.com"]) {
  const fake = await createFakeSupabase({
    serviceKey: SERVICE,
    users: emails.map((email) => ({ email, password: "x" })),
  });
  const opts = (headers: Record<string, string> = {}) => ({
    global: { fetch: fake.fetch as typeof fetch, headers },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /** La service role: salta la RLS, como el reloj. */
  const admin = createClient(URL_, SERVICE, opts());

  /** Un cliente con la sesión de ese usuario: RLS encendida, como las páginas. */
  const as = (email: string) =>
    createClient(URL_, "anon-de-prueba", opts({ Authorization: `Bearer ${fake.tokenFor(fake.userId(email))}` }));

  const id = (email: string) => fake.userId(email) as string;

  return { fake, admin, as, id };
}

export function ctxFor(
  supabase: unknown,
  userId: string,
  today = "2026-09-30",
  tz = "America/Vancouver",
  profile: Partial<Profile> = {},
): Ctx {
  return {
    supabase: supabase as Ctx["supabase"],
    userId,
    tz,
    today,
    profile: {
      id: userId,
      areas: ["SFU", "FINSA", "Badminton", "Proyectos", "Personal"],
      day_start: 7,
      day_end: 23,
      timezone: tz,
      created_at: "2026-09-01T00:00:00Z",
      ...profile,
    },
  };
}

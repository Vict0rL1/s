import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logActivity } from "@/lib/activity";
import { getApiCtx } from "@/lib/data";
import { gcalConfigured, requireGoogleEnv } from "@/lib/env.server";
import { GcalError, exchangeCode, sealToken } from "@/lib/gcal";
import { runGcalSync } from "@/lib/gcal-sync";
import { errorCodeOf, logEvent, safeMessage } from "@/lib/log";
import { publicOrigin } from "@/lib/origin";
import { recordRun } from "@/lib/sync-state";
import { STATE_COOKIE, STATE_PATH, sameState } from "../state";

/**
 * La vuelta de Google. Comprueba que la pidió este navegador, canjea el
 * código por el refresh token, lo guarda cifrado y hace la primera lectura.
 * Siempre termina en Estado del sistema, que dice cómo salió.
 */
export async function GET(req: Request) {
  const origin = publicOrigin(req);
  const back = (resultado: string) => {
    const r = NextResponse.redirect(`${origin}/ajustes/estado?gcal=${resultado}#st-gcal`);
    r.cookies.set(STATE_COOKIE, "", { path: STATE_PATH, maxAge: 0 });
    return r;
  };

  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.redirect(`${origin}/login`);

  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const guardado = (await cookies()).get(STATE_COOKIE)?.value ?? "";
  if (!sameState(state, guardado)) return back("estado-invalido");

  const oauthError = url.searchParams.get("error");
  if (oauthError) return back(oauthError === "access_denied" ? "cancelado" : "error");
  const code = url.searchParams.get("code");
  if (!code) return back("error");
  if (!gcalConfigured()) return back("sin-config");

  const env = requireGoogleEnv();
  try {
    const refresh = await exchangeCode(code, `${origin}/api/gcal/callback`, env);
    const { error } = await ctx.supabase.from("gcal_links").upsert(
      { user_id: ctx.userId, refresh_token: sealToken(refresh, env.clientSecret), calendars: [], linked_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) throw new GcalError("GCAL_DB_FAILED", "No se pudo guardar la conexión: " + error.message);
  } catch (e) {
    const message = safeMessage(e, "No se pudo conectar Google Calendar");
    const errorCode = errorCodeOf(e);
    await recordRun(ctx.supabase, ctx.userId, "gcal", { ok: false, error: message, code: errorCode });
    logEvent({ event: "gcal.link", result: "error", userId: ctx.userId, integration: "gcal", errorCode, message });
    return back("error");
  }

  await logActivity(ctx, { actor: "user", kind: "gcal.linked", summary: "Conectaste Google Calendar (sólo lectura)" });
  logEvent({ event: "gcal.link", result: "ok", userId: ctx.userId, integration: "gcal" });
  const r = await runGcalSync(ctx, "manual");
  return back(r.ok ? "ok" : "error");
}

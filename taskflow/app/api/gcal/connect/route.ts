import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getApiCtx } from "@/lib/data";
import { gcalConfigured, requireGoogleEnv } from "@/lib/env.server";
import { authUrl } from "@/lib/gcal";
import { publicOrigin } from "@/lib/origin";
import { STATE_COOKIE, STATE_PATH } from "../state";

/**
 * "Conectar Google Calendar": manda el navegador a la pantalla de permiso de
 * Google, pidiendo sólo lectura del calendario.
 */
export async function GET(req: Request) {
  const origin = publicOrigin(req);
  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.redirect(`${origin}/login`);
  if (!gcalConfigured()) return NextResponse.redirect(`${origin}/ajustes/estado?gcal=sin-config#st-gcal`);

  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(
    authUrl({ clientId: requireGoogleEnv().clientId, redirectUri: `${origin}/api/gcal/callback`, state }),
  );
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax",
    path: STATE_PATH,
    maxAge: 600,
  });
  return res;
}

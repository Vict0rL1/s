import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { addDays, dayOfMonth, daysBetween, monthOf, wallTimeToInstant, yearOf } from "./date";
import { type ErrorCode, IntegrationError } from "./log";

/**
 * Google Calendar, sólo lectura.
 *
 * - El permiso es `calendar.readonly`: aunque el código quisiera escribir,
 *   Google lo rechazaría. Y el código sólo hace GET a la API de Calendar.
 * - El refresh token se guarda cifrado y sólo se descifra en el servidor.
 * - Los eventos entran a `events` con `source = 'gcal'` y una clave estable
 *   por calendario y evento, así que sincronizar dos veces deja lo mismo.
 */

export const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

/** Días hacia atrás y hacia adelante que se leen. */
export const GCAL_PAST_DAYS = 7;
export const GCAL_FUTURE_DAYS = 120;
/** Un calendario con más que esto no es una agenda personal; se corta y no se borra nada. */
const MAX_PAGES = 10;
/** Los calendarios visibles en Google; más de diez ya es ruido (cumpleaños, feriados de otros países…). */
export const MAX_CALENDARS = 10;
/** Un evento de varios días completos se pinta en cada día, hasta dos semanas. */
const MAX_ALLDAY_SPAN = 14;

export class GcalError extends IntegrationError {
  constructor(
    code: ErrorCode,
    message: string,
    retryable = false,
    readonly status?: number,
    readonly waitMs?: number,
  ) {
    super(code, message, retryable);
    this.name = "GcalError";
  }
}

/* ----------------------------------------------------------------- cifrado */

const llave = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "taskflow-gcal", "refresh-token-v1", 32));
const b64 = (b: Buffer) => b.toString("base64url");

/** Cifra el refresh token antes de guardarlo. AES-256-GCM: si alguien lo altera, no se descifra. */
export function sealToken(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", llave(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", b64(iv), b64(c.getAuthTag()), b64(ct)].join(".");
}

/** null si no se puede (otro secreto, texto alterado, formato viejo): hay que reconectar. */
export function openToken(sealed: string, secret: string): string | null {
  const [v, iv, tag, ct] = String(sealed).split(".");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", llave(secret), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- OAuth */

/**
 * A dónde mandar el navegador para pedir permiso. `access_type=offline` y
 * `prompt=consent` para que Google entregue un refresh token cada vez, y no
 * sólo la primera: sin él, el reloj no puede leer el calendario.
 */
export function authUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: GCAL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: o.state,
  });
  return `${AUTH_URL}?${p}`;
}

type Env = { clientId: string; clientSecret: string };

async function postForm(url: string, body: Record<string, string>, timeoutMs: number): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw netError(e);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function netError(e: unknown): GcalError {
  const name = (e as { name?: string })?.name;
  return name === "TimeoutError" || name === "AbortError"
    ? new GcalError("GCAL_TIMEOUT", "Google no respondió a tiempo", true)
    : new GcalError("GCAL_NETWORK", "No se pudo hablar con Google", true);
}

/** Los errores del endpoint de tokens: el permiso retirado no se arregla reintentando. */
function tokenError(status: number, json: Record<string, unknown>): GcalError {
  const err = String(json.error ?? "");
  if (err === "invalid_grant") {
    return new GcalError("GCAL_REVOKED", "Google ya no acepta el permiso guardado: vuelve a conectar Google Calendar", false, status);
  }
  if (err === "invalid_client" || err === "unauthorized_client") {
    return new GcalError("GCAL_CLIENT_INVALID", "Google rechazó GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET", false, status);
  }
  if (status === 429) return new GcalError("GCAL_RATE_LIMITED", "Google pidió esperar un poco", true, status);
  if (status >= 500) return new GcalError("GCAL_UNAVAILABLE", `Google respondió ${status}`, true, status);
  return new GcalError("GCAL_BAD_RESPONSE", `Google respondió ${status} al pedir el permiso`, false, status);
}

/** Canjea el código de la vuelta de Google por el refresh token. */
export async function exchangeCode(code: string, redirectUri: string, env: Env): Promise<string> {
  const { status, json } = await postForm(
    TOKEN_URL,
    { code, client_id: env.clientId, client_secret: env.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" },
    15_000,
  );
  if (status !== 200) throw tokenError(status, json);
  // Con el consentimiento por partes, se puede desmarcar el calendario.
  const scopes = String(json.scope ?? "").split(/\s+/);
  if (!scopes.includes(GCAL_SCOPE)) {
    throw new GcalError("GCAL_FORBIDDEN", "No diste permiso para ver el calendario; sin eso no hay nada que leer");
  }
  const refresh = json.refresh_token;
  if (typeof refresh !== "string" || !refresh) {
    throw new GcalError("GCAL_BAD_RESPONSE", "Google no entregó un permiso permanente; vuelve a conectar");
  }
  return refresh;
}

/** Un access token fresco (dura una hora; se pide uno por corrida). */
export async function refreshAccess(refreshToken: string, env: Env): Promise<string> {
  const { status, json } = await postForm(
    TOKEN_URL,
    { refresh_token: refreshToken, client_id: env.clientId, client_secret: env.clientSecret, grant_type: "refresh_token" },
    15_000,
  );
  if (status !== 200) throw tokenError(status, json);
  if (typeof json.access_token !== "string") throw new GcalError("GCAL_BAD_RESPONSE", "Google no entregó un token de acceso");
  return json.access_token;
}

/** Al desconectar, también se le avisa a Google. Si falla, da igual: el token ya no se guarda. */
export async function revokeToken(refreshToken: string): Promise<void> {
  await postForm(REVOKE_URL, { token: refreshToken }, 8_000).catch(() => undefined);
}

/* ----------------------------------------------------------------- lectura */

export type GetOptions = { timeoutMs?: number; retries?: number; backoffMs?: number };
const DEFAULTS: Required<GetOptions> = { timeoutMs: 15_000, retries: 1, backoffMs: 1_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gcalGetOnce(url: string, token: string, timeoutMs: number): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw netError(e);
  }
  if (res.ok) {
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") throw new GcalError("GCAL_BAD_RESPONSE", "Google devolvió algo que no es JSON");
    return json as Record<string, unknown>;
  }

  const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[] } };
  const reason = body.error?.errors?.[0]?.reason ?? "";
  const retryAfter = Number(res.headers.get("retry-after"));
  const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : undefined;

  if (res.status === 401) throw new GcalError("GCAL_REVOKED", "Google rechazó el acceso: vuelve a conectar Google Calendar", false, 401);
  if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(reason))) {
    throw new GcalError("GCAL_RATE_LIMITED", "Google pidió esperar un poco", true, res.status, wait);
  }
  if (res.status === 403) throw new GcalError("GCAL_FORBIDDEN", "Google no deja leer ese calendario", false, 403);
  if (res.status === 404) throw new GcalError("GCAL_FORBIDDEN", "Ese calendario ya no existe", false, 404);
  if (res.status >= 500) throw new GcalError("GCAL_UNAVAILABLE", `Google respondió ${res.status}`, true, res.status, wait);
  throw new GcalError("GCAL_BAD_RESPONSE", `Google respondió ${res.status}`, false, res.status);
}

/** GET con reintento corto para lo que puede ser pasajero (red, 429, 5xx). */
export async function gcalGet(url: string, token: string, opts: GetOptions = {}): Promise<Record<string, unknown>> {
  const o = { ...DEFAULTS, ...opts };
  for (let intento = 0; ; intento++) {
    try {
      return await gcalGetOnce(url, token, o.timeoutMs);
    } catch (e) {
      const err = e as GcalError;
      if (!err.retryable || intento >= o.retries) throw err;
      await sleep(err.waitMs ?? o.backoffMs);
    }
  }
}

export type GcalCalendar = { id: string; name: string };

/**
 * Los calendarios que tienes visibles en Google (los marcados en la columna
 * de la izquierda). El principal primero.
 */
export async function listCalendars(token: string, opts: GetOptions = {}): Promise<GcalCalendar[]> {
  const out: (GcalCalendar & { primary: boolean })[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const p = new URLSearchParams({ minAccessRole: "reader", maxResults: "250" });
    if (pageToken) p.set("pageToken", pageToken);
    const json = await gcalGet(`${API}/users/me/calendarList?${p}`, token, opts);
    for (const c of (Array.isArray(json.items) ? json.items : []) as Record<string, unknown>[]) {
      if (typeof c.id !== "string" || c.selected !== true || c.deleted === true || c.hidden === true) continue;
      const name = String(c.summaryOverride ?? c.summary ?? c.id).trim().slice(0, 60) || "Google";
      out.push({ id: c.id, name, primary: c.primary === true });
    }
    pageToken = typeof json.nextPageToken === "string" ? json.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .slice(0, MAX_CALENDARS)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * Los eventos de un calendario en la ventana, con las repeticiones ya
 * expandidas por Google (`singleEvents`). `complete` es falso si se cortó por
 * el tope de páginas: entonces nadie puede concluir que algo "ya no está".
 */
export async function listEvents(
  token: string,
  calendarId: string,
  window: { timeMin: string; timeMax: string },
  opts: GetOptions = {},
): Promise<{ items: unknown[]; complete: boolean }> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      maxResults: "2500",
      showDeleted: "false",
    });
    if (pageToken) p.set("pageToken", pageToken);
    const json = await gcalGet(`${API}/calendars/${encodeURIComponent(calendarId)}/events?${p}`, token, opts);
    if (Array.isArray(json.items)) items.push(...json.items);
    pageToken = typeof json.nextPageToken === "string" ? json.nextPageToken : undefined;
    if (!pageToken) return { items, complete: true };
  }
  return { items, complete: false };
}

/* ------------------------------------------------------------------ ventana */

export type GcalWindow = { timeMin: string; timeMax: string; fromDay: string; toDay: string };

/** De una semana atrás a cuatro meses adelante, contados en tu zona. */
export function gcalWindow(today: string, tz: string): GcalWindow {
  const fromDay = addDays(today, -GCAL_PAST_DAYS);
  const toDay = addDays(today, GCAL_FUTURE_DAYS);
  const end = addDays(toDay, 1);
  const at = (d: string) => new Date(wallTimeToInstant(yearOf(d), monthOf(d) + 1, dayOfMonth(d), 0, 0, tz)).toISOString();
  return { timeMin: at(fromDay), timeMax: at(end), fromDay, toDay };
}

/* ------------------------------------------------------------------- mapeo */

export type GcalEventRow = {
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  all_day_date: string | null;
  location: string | null;
  course_ref: string;
  source: "gcal";
  external_id: string;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Un evento de Google → filas de `events`. Vacío si no va: cancelado,
 * rechazado por ti, o roto. Un evento de varios días completos sale una vez
 * por día, como se ve en Google.
 */
export function mapEvent(ev: unknown, cal: GcalCalendar): GcalEventRow[] {
  if (!ev || typeof ev !== "object") return [];
  const e = ev as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id || e.status === "cancelled") return [];
  const yo = (Array.isArray(e.attendees) ? e.attendees : []).find((a) => (a as { self?: boolean })?.self) as
    | { responseStatus?: string }
    | undefined;
  if (yo?.responseStatus === "declined") return [];

  const base = {
    title: String(e.summary ?? "").trim().slice(0, 200) || "(sin título)",
    location: typeof e.location === "string" && e.location.trim() ? e.location.trim().slice(0, 200) : null,
    course_ref: cal.name,
    source: "gcal" as const,
  };
  const id = `gcal:${cal.id}:${e.id}`;
  const start = (e.start ?? {}) as { dateTime?: string; date?: string };
  const end = (e.end ?? {}) as { dateTime?: string; date?: string };

  if (start.dateTime) {
    const s = iso(start.dateTime);
    if (!s) return [];
    const f = iso(end.dateTime);
    return [{ ...base, starts_at: s, ends_at: f && f >= s ? f : null, all_day_date: null, external_id: id }];
  }

  if (start.date && YMD.test(start.date)) {
    // En Google el fin de un evento de día completo es exclusivo.
    const fin = end.date && YMD.test(end.date) ? end.date : addDays(start.date, 1);
    const dias = Math.min(MAX_ALLDAY_SPAN, Math.max(1, daysBetween(start.date, fin)));
    return Array.from({ length: dias }, (_, i) => {
      const day = addDays(start.date!, i);
      return { ...base, starts_at: null, ends_at: null, all_day_date: day, external_id: dias > 1 ? `${id}:${day}` : id };
    });
  }
  return [];
}

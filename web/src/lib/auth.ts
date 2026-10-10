// La sesión desde la pantalla: saber si hay puerta, entrar, salir y enterarse de un 401.
//
// Las llamadas a la API están repartidas por decenas de componentes (`fetch('/api/…')`).
// En vez de tocar cada una, `instalarDetector401` envuelve `window.fetch` una sola vez: si
// una respuesta de `/api/` viene con 401 y la puerta activa, emite `auth:required` y la app
// enseña la pantalla de entrada. La cookie va sola en cada petición (mismo origen), así que
// no hay token que guardar ni cabecera que añadir.

export interface EstadoAuth {
  auth: boolean;
  dentro: boolean;
  totp: boolean;
  sesiones: boolean;
  sesionId?: number | null;
  usuario?: string;
  /** No se pudo preguntar (sin red en un arranque en frío): se entra a lo guardado. */
  sinRed?: boolean;
}

/** La caché de la API del service worker (public/sw.js): se vacía al salir. */
export const CACHE_API = 'predictor-api-v1';

export interface SesionVista {
  id: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  actual: boolean;
}

export const EVENTO_AUTH = 'auth:required';

export async function estadoAuth(): Promise<EstadoAuth> {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) return { auth: false, dentro: true, totp: false, sesiones: false };
    return (await r.json()) as EstadoAuth;
  } catch {
    // Sin red (arranque en frío sin conexión): se enseña lo guardado en vez de una pantalla en
    // blanco. No abre nada: el servidor sigue pidiendo sesión, y al salir la caché se vacía.
    return { auth: false, dentro: true, totp: false, sesiones: false, sinRed: true };
  }
}

export async function entrar(password: string, codigo?: string): Promise<{ ok: true } | { ok: false; error: string; totp?: boolean; espera?: number }> {
  const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, codigo }) });
  if (r.ok) return { ok: true };
  const j = (await r.json().catch(() => ({}))) as { error?: string; totp?: boolean };
  return { ok: false, error: j.error ?? `Error ${r.status}`, totp: j.totp, espera: r.status === 429 ? Number(r.headers.get('retry-after')) || undefined : undefined };
}

/** Vacía la caché de la API del service worker: lo de esta sesión no se sirve en la siguiente (D6). */
async function vaciarCacheApi(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_API);
    if (typeof navigator !== 'undefined') navigator.serviceWorker?.controller?.postMessage({ tipo: 'vaciar-api' });
  } catch {
    // Sin Cache API (contexto no seguro): no había nada guardado.
  }
}

export async function salir(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  await vaciarCacheApi();
}

export async function sesiones(): Promise<{ actual: number | null; sesiones: SesionVista[] }> {
  const r = await fetch('/api/auth/sessions');
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as { actual: number | null; sesiones: SesionVista[] };
}

export async function revocar(id: number): Promise<{ ok: boolean; eraLaActual: boolean }> {
  const r = await fetch(`/api/auth/sessions/${id}/revoke`, { method: 'POST' });
  const j = (await r.json()) as { ok: boolean; eraLaActual: boolean };
  // Cerrar la sesión ACTUAL desde la lista es salir: también vacía la caché (G4, lote G).
  if (j.eraLaActual) await vaciarCacheApi();
  return j;
}

let instalado = false;
export function instalarDetector401(): void {
  if (instalado || typeof window === 'undefined') return;
  instalado = true;
  const original = window.fetch.bind(window);
  window.fetch = async (entrada, init) => {
    const res = await original(entrada, init);
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
      window.dispatchEvent(new CustomEvent(EVENTO_AUTH));
    }
    return res;
  };
}

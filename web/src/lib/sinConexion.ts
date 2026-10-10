// Sin conexión (Fase 5.26): cuándo fue la última respuesta buena de la API (para el banner
// «Sin conexión: datos de HH:MM») y el registro del service worker.
import { useEffect, useState } from 'react';

const CLAVE = 'predictor.ultimaRed';
const EVENTO_CACHE = 'predictor:desde-cache';
let instalada = false;

/** Anota la hora de cada respuesta buena de /api/ (en el navegador; nada sale de él). */
export function instalarMarcaDeRed(): void {
  if (instalada || typeof window === 'undefined') return;
  instalada = true;
  const original = window.fetch.bind(window);
  window.fetch = async (entrada, init) => {
    const res = await original(entrada, init);
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    if (url.includes('/api/')) {
      // Lo que sirve el service worker de su caché lleva X-Desde-Cache (public/sw.js): no es
      // una respuesta de la red y no mueve la hora; enciende el banner aunque el navegador
      // crea que hay conexión (el servidor caído, por ejemplo).
      const deCache = res.headers.get('X-Desde-Cache') === '1';
      if (deCache) window.dispatchEvent(new CustomEvent(EVENTO_CACHE, { detail: true }));
      else if (res.ok && navigator.onLine) {
        window.dispatchEvent(new CustomEvent(EVENTO_CACHE, { detail: false }));
        try {
          localStorage.setItem(CLAVE, new Date().toISOString());
        } catch {
          // Sin almacenamiento: el banner dirá «sin hora».
        }
      }
    }
    return res;
  };
}

export function ultimaRed(): string | null {
  try {
    return localStorage.getItem(CLAVE);
  } catch {
    return null;
  }
}

export function useEnLinea(): boolean {
  const [enLinea, setEnLinea] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setEnLinea(true);
    const off = () => setEnLinea(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return enLinea;
}

/** ¿La última respuesta de la API vino de la caché del service worker? */
export function useDesdeCache(): boolean {
  const [desdeCache, setDesdeCache] = useState(false);
  useEffect(() => {
    const f = (e: Event) => setDesdeCache((e as CustomEvent<boolean>).detail === true);
    window.addEventListener(EVENTO_CACHE, f);
    return () => window.removeEventListener(EVENTO_CACHE, f);
  }, []);
  return desdeCache;
}

interface DepsSw {
  serviceWorker?: Pick<ServiceWorkerContainer, 'register' | 'getRegistrations'> | { register: () => Promise<unknown>; getRegistrations: () => Promise<{ unregister: () => Promise<boolean> }[]> };
  pedir?: (url: string) => Promise<Response>;
}

/**
 * Registra el service worker si el interruptor está encendido, y DESREGISTRA el que hubiera si
 * está apagado (D6: apagarlo no quitaba el ya instalado, que seguía sirviendo lo guardado).
 * Nunca lanza.
 */
export async function registrarServiceWorker(deps: DepsSw = {}): Promise<void> {
  try {
    const sw = deps.serviceWorker ?? (typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined);
    if (!sw) return;
    const pedir = deps.pedir ?? ((u: string) => fetch(u));
    const r = await pedir('/api/features');
    if (!r.ok) return;
    const j = (await r.json()) as { features: Record<string, { activa: boolean }> };
    if (j.features['interfaz.sinConexion']?.activa === false) {
      for (const reg of await sw.getRegistrations()) await reg.unregister();
      return;
    }
    await sw.register('/sw.js');
  } catch {
    // Sin service worker la app funciona igual, solo que no sin conexión.
  }
}

// La cookie de sesión, leída y escrita a mano.
//
// Un parser de cookies son diez líneas; una dependencia para eso es otra cosa que
// actualizar en una máquina expuesta a internet. Los atributos son los que importan:
//   HttpOnly   el JavaScript de la página no puede leerla (un XSS no se la lleva)
//   SameSite   Strict: otro sitio no puede hacer peticiones con ella (CSRF)
//   Secure     solo por HTTPS; se pone cuando la petición llegó cifrada o en producción
//   Path=/     toda la app

import type { FastifyReply, FastifyRequest } from 'fastify';

export const COOKIE_SESION = 'sp_session';

export function leerCookies(cabecera: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cabecera) return out;
  for (const parte of cabecera.split(';')) {
    const i = parte.indexOf('=');
    if (i <= 0) continue;
    const k = parte.slice(0, i).trim();
    const v = parte.slice(i + 1).trim();
    if (!k || k in out) continue;
    // Una cookie que no se deja descifrar (`%E0%A4%A`) se ignora: antes `decodeURIComponent`
    // lanzaba dentro del hook de la puerta y la respuesta era un 500 (lote B, B6).
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      // Indescifrable: como si no viniera.
    }
  }
  return out;
}

export function tokenDeSesion(req: FastifyRequest): string | null {
  return leerCookies(req.headers.cookie)[COOKIE_SESION] ?? null;
}

/** ¿Llegó por HTTPS? Directo o detrás del proxy de Fly (que pone `x-forwarded-proto`). */
export function esHttps(req: FastifyRequest): boolean {
  const xf = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(xf) ? xf[0] : xf;
  return req.protocol === 'https' || (proto ?? '').split(',')[0].trim() === 'https';
}

export function ponerCookieSesion(req: FastifyRequest, reply: FastifyReply, token: string, maxAgeS: number, forzarSecure: boolean): void {
  const partes = [`${COOKIE_SESION}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeS}`];
  if (forzarSecure || esHttps(req)) partes.push('Secure');
  reply.header('set-cookie', partes.join('; '));
}

export function borrarCookieSesion(reply: FastifyReply): void {
  reply.header('set-cookie', `${COOKIE_SESION}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

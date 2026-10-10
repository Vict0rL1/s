// Cabeceras de seguridad, en un hook `onSend`. Lo mismo que hace helmet, sin la dependencia.
//
// La CSP está escrita para ESTA app: la pantalla es un bundle de Vite servido desde el
// mismo origen, con estilos en línea (los `style={{…}}` de React) y logos de equipo que
// vienen de otros dominios (`img-src https:`), y `blob:` en imágenes porque «Mi selección →
// PNG» dibuja el SVG de la tarjeta en un <img> con `URL.createObjectURL` (D9 de la revisión
// del 8 de octubre: sin él, la descarga fallaba en producción). No carga scripts de fuera, así que
// `script-src 'self'` basta y es lo que de verdad protege: un XSS que consiga inyectar HTML
// no puede traer código de otro sitio ni ejecutar uno en línea.
//
// HSTS solo en producción: en el portátil la app va por HTTP y una cabecera HSTS dejaría
// `localhost` roto en el navegador durante un año.

import type { FastifyInstance } from 'fastify';

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

export const CABECERAS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-dns-prefetch-control': 'off',
};

export const HSTS = 'max-age=15552000; includeSubDomains';

export function registerSecurityHeaders(app: FastifyInstance, opts: { hsts: boolean }): void {
  app.addHook('onSend', async (_req, reply) => {
    for (const [k, v] of Object.entries(CABECERAS)) if (!reply.hasHeader(k)) reply.header(k, v);
    if (opts.hsts && !reply.hasHeader('strict-transport-security')) reply.header('strict-transport-security', HSTS);
  });
}

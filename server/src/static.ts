// Servir la app construida, que en producción no la sirve nadie más.
//
// ===========================================================================
// EN DESARROLLO ESTO NO EXISTE, Y ES FÁCIL NO DARSE CUENTA
// ===========================================================================
// Con `npm run dev` hay DOS servidores: Vite sirve la web y hace de proxy de `/api` hacia
// Fastify. En producción solo hay uno, así que sin esto el despliegue respondería
// perfectamente a `/api/...` y devolvería un 404 en `/` — una app «desplegada con éxito»
// que no se puede abrir.
//
// ===========================================================================
// POR QUÉ @fastify/static Y NO CUARENTA LÍNEAS PROPIAS
// ===========================================================================
// Leer un fichero y devolverlo son cuatro líneas; hacerlo BIEN, servido a internet, no.
// Hay que normalizar la ruta para que `GET /../../etc/passwd` no salga de la carpeta,
// acertar el `Content-Type` de cada extensión, responder a `Range` para que el navegador
// pueda reanudar, y mandar `ETag` para no reenviar dos megas de JavaScript en cada visita.
// Un fallo en el primero de esos cuatro entrega ficheros del servidor.

import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { ROOT } from './config.ts';

/** Dónde deja Vite la app construida. */
export const WEB_DIST = process.env.WEB_DIST?.trim() || path.join(ROOT, 'web', 'dist');

/**
 * ¿Hay algo que servir?
 *
 * Se comprueba el `index.html` y no la carpeta: `web/dist` puede existir y estar vacía
 * —una build interrumpida, un `rm` a medias— y entonces el servidor arrancaría anunciando
 * que sirve la app para devolver 404 en todo.
 */
export function webBuildExists(dist: string = WEB_DIST): boolean {
  return existsSync(path.join(dist, 'index.html'));
}

export async function registerStatic(app: FastifyInstance, dist: string = WEB_DIST): Promise<void> {
  await app.register(fastifyStatic, {
    root: dist,
    // Los assets con hash en el nombre (index-A1b2C3.js) no cambian nunca: si cambia el
    // contenido, cambia el nombre. Se pueden cachear para siempre sin riesgo de servir
    // una versión vieja, y eso convierte la segunda visita en instantánea.
    maxAge: '1y',
    // Los .br y .gz que deja scripts/comprimir-dist.mjs al construir (Fase 7.1): se sirven según
    // Accept-Encoding sin comprimir nada en cada petición.
    preCompressed: true,
    // Recibe un `FastifyReply`, no el `ServerResponse` de Node, así que la cabecera se
    // pone con `.header()`. (Escrito primero con `setHeader` y cazado por el typecheck;
    // el `.d.ts` del plugin y su código coinciden en que es un reply.)
    setHeaders(reply, filePath) {
      // El index NO: es el único fichero cuyo nombre es fijo y cuyo contenido cambia en
      // cada despliegue. Cacheado un año, quien ya haya entrado seguiría pidiendo los
      // assets de la versión vieja —que ya no están— y vería una página en blanco
      // después de cada despliegue.
      if (/index\.html(\.(br|gz))?$/.test(filePath)) {
        reply.header('cache-control', 'no-cache');
      }
    },
  });

  // ---------------------------------------------------------------------------
  // EL RESPALDO PARA LAS RUTAS DEL NAVEGADOR
  // ---------------------------------------------------------------------------
  // La app es una SPA: `/apuestas` no es un fichero, lo resuelve React en el cliente. Al
  // pulsar un enlace dentro funciona, pero al RECARGAR esa dirección el navegador la pide
  // al servidor, que no tiene ningún `/apuestas` y devolvería 404. Por eso cualquier ruta
  // desconocida devuelve el index y deja que el cliente decida.
  //
  // Con una excepción que importa: `/api/...` NO. Un endpoint mal escrito tiene que
  // contestar 404, no el HTML de la app. Devolver la página ante `/api/typo` convierte un
  // error de programación en un `JSON.parse` fallando en otro sitio, con un mensaje que
  // no menciona la URL equivocada.
  //
  // Y otra, igual de importante (D7): `/assets/` y `/flags/`. Tras un despliegue, una pestaña
  // abierta pide `index-<hash viejo>.js`, que ya no existe; si se le devuelve el index, el
  // navegador recibe HTML como módulo, la carga diferida falla con un error confuso y el
  // service worker podría guardarlo. Un 404 limpio lo recoge el ErrorBoundary, que recarga.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: `Ruta no encontrada: ${req.url}` });
    }
    if (req.url.startsWith('/assets/') || req.url.startsWith('/flags/')) {
      return reply.code(404).type('text/plain; charset=utf-8').send('No encontrado');
    }
    return reply.type('text/html').sendFile('index.html');
  });
}

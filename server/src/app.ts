// La aplicación Fastify, construida en un sitio.
//
// Antes todo esto vivía dentro de `main()` en index.ts, mezclado con los temporizadores y
// el `listen`. Separarlo tiene un motivo concreto: poder construir la app en un test y
// pedirle rutas con `app.inject`, sin puerto ni red. Sin eso, la puerta de la contraseña,
// las cabeceras o el límite de cuerpo no se podían probar, y una medida de seguridad sin
// test es una que puede dejar de funcionar sin que nadie lo note.
//
// index.ts sigue siendo el arranque: llama a `buildApp`, escucha y lanza los ciclos.

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { registerRoutes } from './routes/api.ts';
import { registerBasketballRoutes } from './routes/basketball.ts';
import { registerFootballRoutes } from './routes/football.ts';
import { registerBaseballRoutes } from './routes/baseball.ts';
import { registerNflRoutes } from './routes/nfl.ts';
import { registerBetRoutes } from './routes/bets.ts';
import { registerLatencyRoutes } from './routes/latency.ts';
import { registerStakingRoutes } from './routes/staking.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerAuth, authRuntimeDesdeEntorno, type AuthRuntime } from './auth.ts';
import { registerStatic, webBuildExists, WEB_DIST } from './static.ts';
import { recordLatency } from './latency/record.ts';
import { registerSecurityHeaders } from './security/headers.ts';
import { origenesPermitidos, politicaCors } from './security/cors.ts';
import { registerErrorHandler } from './security/errors.ts';
import { estadoFeatures, featureEncendida } from './features.ts';

import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { registerOperacionRoutes } from './routes/operacion.ts';
import { registerAnaliticaRoutes } from './routes/analitica.ts';
import { registerAjustesRoutes } from './routes/ajustes.ts';
import { registerEstrategiasRoutes } from './routes/estrategias.ts';
import { registrarCompresionYEtag } from './http/compresion.ts';
import { registerInformesRoutes } from './routes/informes.ts';
import { registerLineasArchivoRoutes } from './routes/lineasArchivo.ts';
import { registerNhlRoutes } from './routes/nhl.ts';
import { registerUfcRoutes } from './routes/ufc.ts';
import { conLectorDeAnulaciones } from './features.ts';
import { incrementar, grupoDeRuta } from './observability/metrics.ts';
import { registroArrancado } from './scheduler/registry.ts';
import { getDb, getMeta, MIGRACIONES } from './db.ts';
import { estadoPorVersion } from './db/migrations.ts';
import { LAYOUT } from './db/layout.ts';
import { ESQUEMA_HEALTH, ESQUEMA_READY, ESQUEMA_FEATURES } from './api/schemas.ts';

export interface AppOptions {
  /** La puerta: configuración y limitador. Por defecto, del entorno. */
  auth?: AuthRuntime;
  /** Servir web/dist si existe (producción). Los tests lo dejan apagado. */
  servirWeb?: boolean;
  /** La carpeta de la web construida (por defecto, WEB_DIST). Los tests de la puerta pasan una de mentira. */
  webDist?: string;
  /** Logger de Fastify (apagado en tests). */
  logger?: boolean;
  entorno?: NodeJS.ProcessEnv;
  /** Para los tests: ver cada ruta que se registra (y comprobar que todas están detrás de la puerta). */
  onRoute?: (r: { method: string | string[]; url: string }) => void;
}

/** 256 KB: cabe cualquier formulario de la app; no cabe un intento de llenar la memoria. */
export const BODY_LIMIT_POR_DEFECTO = 256 * 1024;

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const entorno = opts.entorno ?? process.env;
  const auth = opts.auth ?? authRuntimeDesdeEntorno(entorno);
  const bodyLimit = Number(entorno.BODY_LIMIT_BYTES) > 0 ? Number(entorno.BODY_LIMIT_BYTES) : BODY_LIMIT_POR_DEFECTO;

  const app = Fastify({
    // pino, el de Fastify: una línea JSON por evento con `reqId`; nivel por LOG_LEVEL; nunca
    // se escriben la cabecera de autorización ni las cookies.
    logger: opts.logger === false ? false : { level: entorno.LOG_LEVEL?.trim() || 'info', transport: undefined, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    bodyLimit,
    // Cada petición lleva un id (UUID) que vuelve en las respuestas de error y en el log.
    // Se respeta el que traiga un proxy en `x-request-id` para poder seguir la traza.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: auth.config.produccion,
  });

  // ===========================================================================
  // ETAPA «SERVIDOR»: petición → respuesta
  // ===========================================================================
  // Se mide con los ganchos de Fastify y no con un cronómetro dentro de cada ruta,
  // porque así cubre TODA la petición —parseo, ruta, serialización— y no se puede
  // olvidar en una ruta nueva. Solo se guardan las de predicción: medir el endpoint de
  // latencia dentro de la propia latencia añade ruido y no informa de nada.
  if (opts.onRoute) app.addHook('onRoute', (r) => opts.onRoute!({ method: r.method, url: r.url }));
  // Compresión y ETag/304 (Fase 7.1): antes de registrar ninguna ruta, para que valga para todas.
  registrarCompresionYEtag(app);

  app.addHook('onRequest', async (req) => {
    (req as { __t0?: bigint }).__t0 = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req, reply) => {
    const t0 = (req as { __t0?: bigint }).__t0;
    if (!t0) return;
    const url = req.url;
    // Métricas: cada petición por grupo de ruta y código; las de predicción, además por deporte.
    try {
      const grupo = grupoDeRuta(req.routeOptions?.url, url);
      incrementar('http_peticiones_total', { grupo, status: reply.statusCode }, 'peticiones HTTP por grupo de ruta y código');
    } catch {
      // Medir no puede tumbar una respuesta.
    }
    if (!/\/api\/(football|basketball|baseball|nfl|matches)/.test(url)) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const sport = url.includes('/football')
      ? 'football'
      : url.includes('/basketball')
        ? 'basketball'
        : url.includes('/baseball')
          ? 'baseball'
          : url.includes('/nfl')
            ? 'nfl'
            : 'tennis';
    try {
      if (reply.statusCode < 400) incrementar('predicciones_servidas_total', { sport }, 'respuestas de rutas de predicción por deporte');
      recordLatency({ stage: 'servidor', ms, sport });
    } catch {
      // Medir no puede tumbar una respuesta que ya se ha enviado.
    }
  });

  // La contraseña, antes que NADA. Un hook registrado después de las rutas sigue
  // corriendo antes que ellas —Fastify ordena por ciclo de vida, no por orden de
  // registro—, pero ponerlo aquí hace que al leer el fichero se vea que está puesto, y
  // que nadie añada una ruta «arriba» creyendo que la esquiva.
  // Las anulaciones de interruptores hechas desde Ajustes (Fase 5.7) se leen de la base.
  try {
    conLectorDeAnulaciones(getMeta);
  } catch {
    // Sin base todavía: los interruptores valen lo que diga el fichero.
  }
  registerAuth(app, auth);

  if (featureEncendida('seguridad.cabeceras')) registerSecurityHeaders(app, { hsts: auth.config.produccion });
  registerErrorHandler(app, { guardar: featureEncendida('seguridad.errorLog') });

  // Cerrado salvo lista explícita (ver security/cors.ts).
  await app.register(cors, { origin: politicaCors(origenesPermitidos(entorno)), credentials: true });

  // La especificación OpenAPI de TODAS las rutas (se registra antes que ellas para verlas) y
  // el visor en /docs, detrás de la contraseña como todo. /openapi.json para herramientas.
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Sports Predictor API', description: 'Predicciones, mercado, banco de papel y operación de los cinco deportes. Copia en español.', version: '0.1.0' },
      tags: [{ name: 'operación', description: 'Salud, métricas, trabajos, política, notificaciones, exportaciones' }],
    },
  });
  if (featureEncendida('api.docs')) {
    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: false } });
  }
  app.get('/openapi.json', { schema: { tags: ['operación'], summary: 'La especificación OpenAPI' } }, async () => app.swagger());

  await app.register(registerAuthRoutes(auth), { prefix: '/api/auth' });
  app.get('/api/features', { schema: { tags: ['operación'], summary: 'Interruptores de funciones', response: { 200: ESQUEMA_FEATURES } } }, async () => ({ features: estadoFeatures(entorno) }));
  await app.register(registerOperacionRoutes);
  await app.register(registerAnaliticaRoutes);
  await app.register(registerAjustesRoutes);
  await app.register(registerEstrategiasRoutes);
  await app.register(registerInformesRoutes);
  await app.register(registerLineasArchivoRoutes);
  await app.register(registerUfcRoutes, { prefix: '/api/ufc' });

  await app.register(registerRoutes, { prefix: '/api' });
  // Basketball lives in its own namespace: no endpoint can return both sports.
  await app.register(registerBasketballRoutes, { prefix: '/api/basketball' });
  await app.register(registerFootballRoutes, { prefix: '/api/football' });
  await app.register(registerLatencyRoutes, { prefix: '/api/latency' });
  await app.register(registerStakingRoutes, { prefix: '/api/staking' });
  await app.register(registerBaseballRoutes, { prefix: '/api/baseball' });
  await app.register(registerNflRoutes, { prefix: '/api/nfl' });
  await app.register(registerNhlRoutes, { prefix: '/api/nhl' });
  // The bet log is not a sixth sport: it records what the person staked, not what
  // any model claimed, so it gets its own namespace rather than living under one.
  await app.register(registerBetRoutes, { prefix: '/api/bets' });

  // Fly comprueba que la máquina vive pidiendo esto. Va sin contraseña a propósito (ver
  // auth.ts) y no toca la base: solo dice que el proceso responde.
  app.get('/healthz', { schema: { tags: ['operación'], summary: 'Vive (sin contraseña)', response: { 200: ESQUEMA_HEALTH } } }, async () => ({ ok: true }));
  app.get('/health', { schema: { tags: ['operación'], summary: 'Vive (alias de /healthz, sin contraseña)', response: { 200: ESQUEMA_HEALTH } } }, async () => ({ ok: true }));
  // ¿Está listo para servir? Migraciones al día en los dos ficheros y el registro de trabajos
  // en marcha. 503 si no: un balanceador o un despliegue no debe mandarle tráfico todavía.
  app.get('/ready', { schema: { tags: ['operación'], summary: 'Listo (sin contraseña): migraciones y trabajos', response: { 200: ESQUEMA_READY, 503: ESQUEMA_READY } } }, async (_req, reply) => {
    const detalle: string[] = [];
    let migraciones = 'ok';
    try {
      const db = getDb();
      for (const [schema, nombre] of LAYOUT === 'split' ? ([['main', 'history'], ['ledger', 'ledger']] as const) : ([['main', 'tennis.db']] as const)) {
        const e = estadoPorVersion(db, schema);
        for (const m of MIGRACIONES) {
          if (LAYOUT === 'split' && m.destino !== 'ambos' && m.destino !== (nombre === 'history' ? 'history' : 'ledger')) continue;
          if (e.get(m.version)?.estado !== 'ok') detalle.push(`v${m.version} ${m.nombre} en ${nombre}: ${e.get(m.version)?.estado ?? 'pendiente'}`);
        }
      }
    } catch (e) {
      detalle.push(`base: ${(e as Error).message}`);
    }
    if (detalle.length) migraciones = 'pendientes';
    const trabajos = registroArrancado() ? 'en marcha' : 'parados';
    if (!registroArrancado()) detalle.push('el registro de trabajos no ha arrancado');
    const ok = migraciones === 'ok' && trabajos === 'en marcha';
    return reply.code(ok ? 200 : 503).send({ ok, migraciones, trabajos, detalle });
  });

  // La app construida, si la hay. En desarrollo no la hay y la sirve Vite, así que esto
  // no se registra y `/` sigue devolviendo el índice de la API de abajo.
  const webDist = opts.webDist ?? WEB_DIST;
  const hayWeb = opts.servirWeb !== false && webBuildExists(webDist);
  if (hayWeb) {
    await registerStatic(app, webDist);
    app.log.info(`Sirviendo la app construida desde ${webDist}`);
  } else if (opts.servirWeb !== false && auth.config.produccion) {
    // En producción esto NO es un detalle: significa que el despliegue responde a la API
    // y devuelve 404 en la portada. Mejor no arrancar que quedar así.
    throw new Error(
      `No hay app construida en ${webDist}, y NODE_ENV=production.\n\n` +
        'El contenedor tiene que construir el frontend (npm run build) antes de arrancar\n' +
        'el servidor; si no, la URL contesta a /api pero no se puede abrir.',
    );
  }

  // El índice de la API en `/` SOLO cuando no hay app que servir: con las dos cosas
  // registradas gana la ruta explícita y abrir la URL desplegada devolvería un JSON.
  if (!hayWeb)
    app.get('/', async () => ({
      name: 'tennis-predictor API',
      docs:
        'Tenis: /api/health, /api/tours, /api/matches/upcoming, /api/predictions/:id · ' +
        'Baloncesto: /api/basketball/leagues, /api/basketball/games/upcoming · ' +
        'Fútbol: /api/football/leagues, /api/football/fixtures/upcoming, /api/football/power',
    }));

  return app;
}

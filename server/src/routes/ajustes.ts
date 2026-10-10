// Rutas de la interfaz (Fase 5): estado global (la píldora), errores (Diagnóstico),
// interruptores desde Ajustes, ajustes de la persona y seguimiento.

import type { FastifyInstance } from 'fastify';
import { env } from '../config.ts';
import { getDb, setMeta } from '../db.ts';
import { getQuota, planTotal } from '../oddsQuota.ts';
import { versionsFor } from '../versions.ts';
import { fechaDeDatos } from '../prematch/snapshots.ts';
import { ejecuciones } from '../ingest/runs.ts';
import { ultimaCopia } from '../db/backup.ts';
import { contarErrores, leerErrores } from '../security/errors.ts';
import { estado as estadoTrabajos } from '../scheduler/registry.ts';
import { leerFeatures, fijarAnulacion, estadoFeatures, CLAVE_ANULACIONES, featureEncendida, soloArranque } from '../features.ts';
import { leerAjustes, guardarAjustes, idiomaDeAcceptLanguage } from '../ajustes/index.ts';
import { listarSeguidos, seguir, dejarDeSeguir, validarSeguido } from '../watchlist/index.ts';
import { SPORT_IDS, type SportId } from '../sports.ts';
import { ESQUEMA_ERROR, ESQUEMA_ESTADO, ESQUEMA_ERRORES, ESQUEMA_FEATURE, ESQUEMA_AJUSTES, ESQUEMA_WATCHLIST, ESQUEMA_SEGUIDO } from '../api/schemas.ts';

const TABLA_PROXIMOS: Record<SportId, string> = { tennis: 'upcoming_matches', football: 'fb_upcoming', basketball: 'bb_upcoming', baseball: 'bsb_upcoming', nfl: 'naf_upcoming', nhl: 'nhl_upcoming', ufc: 'ufc_upcoming' };

/** El estado que resume la píldora: una sola petición, nada que se repita por pestaña. */
export function estadoGlobal(ahora = new Date()) {
  const db = getDb();
  const q = getQuota();
  const deportes = SPORT_IDS.map((sport) => {
    let datosHasta: string | null = null;
    try {
      datosHasta = fechaDeDatos(versionsFor(sport).data_version);
    } catch {
      datosHasta = null;
    }
    let proximos = 0;
    let ultimaCuota: string | null = null;
    try {
      const t = TABLA_PROXIMOS[sport];
      proximos = (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE source <> 'fixture'`).get() as { n: number }).n;
      ultimaCuota = ((db.prepare(`SELECT MAX(updated_at) AS u FROM ${t} WHERE source <> 'fixture'`).get() as { u: string | null }).u) ?? null;
    } catch {
      proximos = 0;
    }
    return { sport, datosHasta, proximos, ultimaCuota };
  });
  const resultados = ejecuciones({ source: 'results:ciclo', limite: 1 })[0] ?? null;
  const desde24h = new Date(ahora.getTime() - 24 * 3_600_000).toISOString();
  let errores24h = 0;
  try {
    errores24h = contarErrores(desde24h);
  } catch {
    errores24h = 0;
  }
  let trabajosConError = 0;
  try {
    trabajosConError = estadoTrabajos().filter((t) => t.lastStatus === 'error').length;
  } catch {
    trabajosConError = 0;
  }
  return {
    generado: ahora.toISOString(),
    cuotas: { modo: env.oddsApiKey ? ('real' as const) : ('demo' as const), clave: !!env.oddsApiKey, restantes: q.remaining, plan: planTotal(), ultimaConsulta: q.checkedAt, error: q.lastError },
    deportes,
    resultados: { ultima: resultados?.finished_at ?? resultados?.started_at ?? null, estado: resultados?.status ?? null },
    copia: { ultima: ultimaCopia()?.cuando ?? null },
    errores24h,
    trabajosConError,
  };
}

export async function registerAjustesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/estado', { schema: { tags: ['interfaz'], summary: 'Estado global para la píldora: cuotas, frescura por deporte, resultados, copia y errores', response: { 200: ESQUEMA_ESTADO } } }, async () => estadoGlobal());

  app.get<{ Querystring: { limite?: string } }>('/api/errores', { schema: { tags: ['interfaz'], summary: 'Últimos errores del servidor (error_log), sin pila ni agente', querystring: { type: 'object', properties: { limite: { type: 'string' } } }, response: { 200: ESQUEMA_ERRORES, 404: ESQUEMA_ERROR } } }, async (req, reply) => {
    if (!featureEncendida('interfaz.diagnostico')) return reply.code(404).send({ error: 'apagado (features.json: interfaz.diagnostico)' });
    const errores = leerErrores(Math.min(200, Number(req.query.limite) || 50)).map(({ stack: _s, ...e }) => e);
    return { errores, total24h: contarErrores(new Date(Date.now() - 24 * 3_600_000).toISOString()) };
  });

  app.patch<{ Params: { nombre: string }; Body: { on?: boolean | null } }>(
    '/api/features/:nombre',
    { schema: { tags: ['interfaz'], summary: 'Anular un interruptor desde Ajustes (on: true/false; null quita la anulación). Los de arranque (auth.*, seguridad.*) se rechazan con 403', body: { type: 'object', properties: { on: { type: ['boolean', 'null'] } }, required: ['on'] }, response: { 200: ESQUEMA_FEATURE, 403: ESQUEMA_ERROR, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      if (!featureEncendida('interfaz.ajustes')) return reply.code(404).send({ error: 'apagado (features.json: interfaz.ajustes)' });
      if (!(req.params.nombre in leerFeatures())) return reply.code(404).send({ error: 'interruptor desconocido' });
      if (soloArranque(req.params.nombre)) return reply.code(403).send({ error: `${req.params.nombre} solo se cambia al arrancar (config/features.json): la puerta y las cabeceras de seguridad no se apagan desde la API` });
      fijarAnulacion(req.params.nombre, req.body.on ?? null, (json) => setMeta(CLAVE_ANULACIONES, json));
      return estadoFeatures()[req.params.nombre];
    },
  );

  app.get('/api/ajustes', { schema: { tags: ['interfaz'], summary: 'Ajustes de la persona (tema, idioma, deportes visibles, banco personal)', response: { 200: ESQUEMA_AJUSTES } } }, async (req) => ({
    ajustes: leerAjustes(),
    idiomaNavegador: idiomaDeAcceptLanguage(req.headers['accept-language']),
  }));
  app.put<{ Body: Record<string, unknown> }>('/api/ajustes', { schema: { tags: ['interfaz'], summary: 'Cambiar ajustes (solo claves conocidas y válidas)', body: { type: 'object', additionalProperties: true }, response: { 200: ESQUEMA_AJUSTES, 400: ESQUEMA_ERROR, 404: ESQUEMA_ERROR } } }, async (req, reply) => {
    if (!featureEncendida('interfaz.ajustes')) return reply.code(404).send({ error: 'apagado (features.json: interfaz.ajustes)' });
    try {
      return { ajustes: guardarAjustes(req.body ?? {}), idiomaNavegador: idiomaDeAcceptLanguage(req.headers['accept-language']) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/watchlist', { schema: { tags: ['interfaz'], summary: 'Equipos, jugadores y partidos seguidos', response: { 200: ESQUEMA_WATCHLIST } } }, async () => ({ seguidos: listarSeguidos() }));
  app.post<{ Body: unknown }>('/api/watchlist', { schema: { tags: ['interfaz'], summary: 'Seguir un equipo, jugador o partido', body: { type: 'object', additionalProperties: true }, response: { 200: ESQUEMA_SEGUIDO, 400: ESQUEMA_ERROR, 404: ESQUEMA_ERROR } } }, async (req, reply) => {
    if (!featureEncendida('interfaz.seguimiento')) return reply.code(404).send({ error: 'apagado (features.json: interfaz.seguimiento)' });
    try {
      return seguir(validarSeguido(req.body));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/watchlist/:id', { schema: { tags: ['interfaz'], summary: 'Dejar de seguir', response: { 200: { type: 'object', properties: { borrado: { type: 'boolean' } }, required: ['borrado'] }, 404: ESQUEMA_ERROR } } }, async (req, reply) => {
    const ok = dejarDeSeguir(Number(req.params.id));
    if (!ok) return reply.code(404).send({ error: 'no se seguía' });
    return { borrado: true };
  });
}

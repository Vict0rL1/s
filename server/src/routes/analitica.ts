// Rutas de analítica (Fase 4): fiabilidad, segmentos, monitorización y simulaciones.
// Nada de aquí cambia una probabilidad publicada: se lee, se enseña y se guarda para graficar.

import type { FastifyInstance } from 'fastify';
import { fiabilidad } from '../evaluation/reliability.ts';
import { segmentos } from '../evaluation/segmentos.ts';
import { monitorizacion } from '../monitoring/series.ts';
import { simulacionDelDia } from '../simulation/season.ts';
import { torneoTenis } from '../simulation/torneo.ts';
import { combinada, validarPatas } from '../picks/parlay.ts';
import { inteligenciaMercado } from '../odds/intel.ts';
import { historiaElo } from '../elo/historia.ts';
import { tarjetaSvg } from '../picks/tarjeta.ts';
import { buscar } from '../buscar/index.ts';
import { getDb } from '../db.ts';
import { FUENTES, probSql, empateSql } from '../today.ts';
import { isSportId, SPORT_IDS, type SportId } from '../sports.ts';
import { featureEncendida } from '../features.ts';
import { ESQUEMA_ERROR, ESQUEMA_FIABILIDAD, ESQUEMA_SEGMENTOS, ESQUEMA_MONITORIZACION, ESQUEMA_SIMULACION, ESQUEMA_TORNEO, ESQUEMA_COMBINADA, ESQUEMA_INTEL, ESQUEMA_HISTORIA_ELO, ESQUEMA_HISTORIAL_SIMULACION, ESQUEMA_RESULTADO, ESQUEMA_BUSQUEDA, ESQUEMA_CUOTAS_POR_CASA } from '../api/schemas.ts';

const DEPORTE = { type: 'object', properties: { sport: { type: 'string', enum: [...SPORT_IDS] } }, required: ['sport'] } as const;

export async function registerAnaliticaRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { sport: string } }>(
    '/api/evaluation/reliability',
    { schema: { tags: ['analítica'], summary: 'Diagrama de fiabilidad (backtest y vivo, sin mezclar)', querystring: DEPORTE, response: { 200: ESQUEMA_FIABILIDAD, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      if (!featureEncendida('analitica.fiabilidad')) return reply.code(404).send({ error: 'apagado (features.json: analitica.fiabilidad)' });
      if (!isSportId(req.query.sport)) return reply.code(404).send({ error: 'deporte desconocido' });
      return fiabilidad(req.query.sport);
    },
  );
  app.get<{ Querystring: { sport: string } }>(
    '/api/evaluation/segmentos',
    { schema: { tags: ['analítica'], summary: 'Acierto, Brier y CLV por segmento (solo celdas con muestra)', querystring: DEPORTE, response: { 200: ESQUEMA_SEGMENTOS, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      if (!featureEncendida('analitica.segmentos')) return reply.code(404).send({ error: 'apagado (features.json: analitica.segmentos)' });
      if (!isSportId(req.query.sport)) return reply.code(404).send({ error: 'deporte desconocido' });
      return segmentos(req.query.sport);
    },
  );
  app.get<{ Querystring: { sport: string } }>(
    '/api/monitoring',
    { schema: { tags: ['analítica'], summary: 'Ventana móvil de 4 semanas, PSI contra el backtest y deriva', querystring: DEPORTE, response: { 200: ESQUEMA_MONITORIZACION, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      if (!featureEncendida('analitica.monitorizacion')) return reply.code(404).send({ error: 'apagado (features.json: analitica.monitorizacion)' });
      if (!isSportId(req.query.sport)) return reply.code(404).send({ error: 'deporte desconocido' });
      return monitorizacion(req.query.sport);
    },
  );
  app.get<{ Params: { sport: string; league: string } }>(
    '/api/simulation/season/:sport/:league',
    { schema: { tags: ['analítica'], summary: 'Simulación Monte Carlo de la temporada (cacheada por día; no es predicción publicada)', params: { type: 'object', properties: { sport: { type: 'string' }, league: { type: 'string' } }, required: ['sport', 'league'] }, response: { 200: ESQUEMA_SIMULACION, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      if (!featureEncendida('simulacion.temporada')) return reply.code(404).send({ error: 'apagado (features.json: simulacion.temporada)' });
      const s = req.params.sport;
      if (!isSportId(s) || s === 'tennis') return reply.code(404).send({ error: 'deporte sin temporada de liga' });
      // La NHL no tiene simulación: ver DeporteSimulable en simulation/season.ts.
      if (s === 'nhl') return reply.code(404).send({ error: 'la NHL no tiene simulación de temporada (sin calendario completo ni derrotas en la prórroga en el archivo)' });
      if (s === 'ufc') return reply.code(404).send({ error: 'la UFC no tiene temporada ni clasificación de liga que simular' });
      if (!/^[a-z0-9_-]{1,32}$/.test(req.params.league)) return reply.code(404).send({ error: 'liga desconocida' });
      return simulacionDelDia(s, req.params.league);
    },
  );
  app.get('/api/simulation/torneo', { schema: { tags: ['analítica'], summary: 'Cuadro de tenis: no hay fuente, y lo dice', response: { 200: ESQUEMA_TORNEO, 404: ESQUEMA_ERROR } } }, async (_req, reply) => {
    if (!featureEncendida('simulacion.torneo')) return reply.code(404).send({ error: 'apagado (features.json: simulacion.torneo)' });
    return torneoTenis();
  });
  app.post<{ Body: { patas?: unknown } }>(
    '/api/picks/parlay',
    { schema: { tags: ['analítica'], summary: 'Probabilidad conjunta de una selección descontando la correlación medida (aproximación)', body: { type: 'object', properties: { patas: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['patas'] }, response: { 200: ESQUEMA_COMBINADA, 400: ESQUEMA_ERROR, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      if (!featureEncendida('picks.combinadasCorrelacion')) return reply.code(404).send({ error: 'apagado (features.json: picks.combinadasCorrelacion)' });
      try {
        return combinada(validarPatas(req.body.patas));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
  app.get('/api/odds/intel', { schema: { tags: ['analítica'], summary: 'Steam moves, surebets y referencia afilada (aproximación)', response: { 200: ESQUEMA_INTEL, 404: ESQUEMA_ERROR } } }, async (_req, reply) => {
    if (!featureEncendida('mercado.inteligencia')) return reply.code(404).send({ error: 'apagado (features.json: mercado.inteligencia)' });
    return inteligenciaMercado();
  });

  // ---- Fase 5: lo que piden las páginas nuevas ----
  app.get<{ Params: { sport: string; league: string; id: string } }>(
    '/api/elo/historia/:sport/:league/:id',
    { schema: { tags: ['analítica'], summary: 'Elo de un equipo antes de cada partido (reproducción de la liga, cacheada por día)', response: { 200: ESQUEMA_HISTORIA_ELO, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      const s = req.params.sport;
      if (!isSportId(s) || s === 'tennis') return reply.code(404).send({ error: 'deporte sin equipos' });
      if (!/^[a-z0-9_-]{1,32}$/.test(req.params.league)) return reply.code(404).send({ error: 'liga desconocida' });
      return historiaElo(s, req.params.league, req.params.id);
    },
  );
  app.get<{ Params: { sport: string; league: string } }>(
    '/api/simulation/season/:sport/:league/historial',
    { schema: { tags: ['analítica'], summary: 'Cómo se movieron las probabilidades de la simulación de temporada, día a día', response: { 200: ESQUEMA_HISTORIAL_SIMULACION, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      const s = req.params.sport;
      if (!isSportId(s) || s === 'tennis') return reply.code(404).send({ error: 'deporte sin temporada de liga' });
      const filas = getDb().prepare('SELECT day, result FROM simulation_runs WHERE sport = ? AND league = ? ORDER BY day').all(s, req.params.league) as { day: string; result: string }[];
      const dias = filas.map((f) => {
        const r = JSON.parse(f.result) as { equipos: { id: string; nombre: string; titulo: number; top: number; descenso: number; puntosEsperados: number }[] };
        return { dia: f.day, equipos: r.equipos.map((e) => ({ id: e.id, nombre: e.nombre, titulo: e.titulo, top: e.top, descenso: e.descenso, puntosEsperados: e.puntosEsperados })) };
      });
      return { sport: s, league: req.params.league, dias };
    },
  );
  app.get<{ Params: { sport: string; key: string } }>(
    '/api/resultado/:sport/:key',
    { schema: { tags: ['analítica'], summary: '¿Acertó? El resultado registrado de un partido con predicción', response: { 200: ESQUEMA_RESULTADO, 404: ESQUEMA_ERROR } } },
    async (req, reply) => {
      const s = req.params.sport;
      if (!isSportId(s)) return reply.code(404).send({ error: 'deporte desconocido' });
      const DEPORTE: Record<SportId, string> = { football: 'Fútbol', basketball: 'Baloncesto', baseball: 'Béisbol', nfl: 'NFL', nhl: 'NHL', ufc: 'UFC', tennis: 'Tenis' };
      const f = FUENTES.find((x) => x.deporte === DEPORTE[s]);
      if (!f) return reply.code(404).send({ error: 'deporte desconocido' });
      const marcador: Record<SportId, [string, string] | null> = { football: ['home_goals', 'away_goals'], basketball: ['home_pts', 'away_pts'], baseball: ['home_runs', 'away_runs'], nfl: ['home_points', 'away_points'], nhl: ['home_goals', 'away_goals'], ufc: ['home_score', 'away_score'], tennis: null };
      const m = marcador[s];
      // La UFC: el «marcador» 1-0 solo dice quién ganó; lo que se enseña es el método (o empate / sin resultado).
      const extra = (m ? `, ${m[0]} AS g1, ${m[1]} AS g2` : ', winner_id AS ganador, p1_id AS p1') + (s === 'ufc' ? ', outcome AS oc, metodo AS met' : '');
      let fila: Record<string, unknown> | undefined;
      try {
        fila = getDb().prepare(`SELECT ${f.casa} AS casa, ${f.fuera} AS fuera, ${probSql(f)} AS p ${f.empate ? `, ${empateSql(f)} AS pe` : ''}, ${f.resuelto} AS resuelto, commence_time AS cuando ${extra} FROM ${f.log} WHERE ${f.clave} = ? ORDER BY rowid DESC LIMIT 1`).get(req.params.key) as Record<string, unknown> | undefined;
      } catch {
        fila = undefined;
      }
      if (!fila) return reply.code(404).send({ error: 'sin predicción registrada para este partido' });
      const resuelto = fila.resuelto != null;
      let resultado: 'casa' | 'empate' | 'fuera' | null = null;
      let marcadorTxt: string | null = null;
      if (resuelto) {
        if (m) {
          const g1 = Number(fila.g1);
          const g2 = Number(fila.g2);
          resultado = g1 > g2 ? 'casa' : g1 === g2 ? 'empate' : 'fuera';
          marcadorTxt = s === 'ufc' ? (fila.oc === 'EMPATE' ? 'empate' : fila.oc === 'NC' ? 'sin resultado' : ((fila.met as string | null) ?? null)) : `${g1}–${g2}`;
        } else resultado = fila.ganador === fila.p1 ? 'casa' : 'fuera';
      }
      const p = Number(fila.p);
      const pe = fila.pe == null ? null : Number(fila.pe);
      const probs = pe == null ? [p, 1 - p] : [p, pe, 1 - p - pe];
      const favorito = probs.indexOf(Math.max(...probs));
      // Con dos resultados, un empate (la NFL; la UFC con empate o sin resultado) no es acierto ni fallo:
      // la apuesta se devuelve. Antes caía en el índice 1, que con dos salidas es el visitante.
      const indice = resultado == null ? null : resultado === 'casa' ? 0 : resultado === 'empate' ? (probs.length === 3 ? 1 : null) : probs.length - 1;
      return {
        sport: s,
        matchKey: req.params.key,
        casa: String(fila.casa),
        fuera: String(fila.fuera),
        cuando: (fila.cuando as string | null) ?? null,
        probabilidades: probs,
        resuelto,
        resultado,
        marcador: marcadorTxt,
        probabilidadDada: indice == null ? null : probs[indice],
        acerto: indice == null ? null : indice === favorito,
      };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { market?: string } }>(
    '/api/odds/casas/:id',
    { schema: { tags: ['analítica'], summary: 'Movimiento de cuotas por casa de un evento (las 8 casas con más observaciones)', response: { 200: ESQUEMA_CUOTAS_POR_CASA } } },
    async (req) => {
      const id = req.params.id.replace(/^odds-/, '');
      const market = req.query.market ?? 'h2h';
      const filas = getDb()
        .prepare('SELECT bookmaker, selection, odds_decimal AS odds, observed_at AS at FROM odds_snapshots WHERE event_id = ? AND market = ? AND withdrawn = 0 AND odds_decimal IS NOT NULL ORDER BY observed_at')
        .all(id, market) as { bookmaker: string; selection: string; odds: number; at: string }[];
      const cuenta = new Map<string, number>();
      for (const f of filas) cuenta.set(f.bookmaker, (cuenta.get(f.bookmaker) ?? 0) + 1);
      const casas = [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
      const series = casas.flatMap((casa) => [...new Set(filas.filter((f) => f.bookmaker === casa).map((f) => f.selection))].map((sel) => ({ casa, seleccion: sel, puntos: filas.filter((f) => f.bookmaker === casa && f.selection === sel).map((f) => ({ at: f.at, cuota: f.odds })) })));
      return { eventId: id, market, casas, series };
    },
  );
  app.get<{ Querystring: { q?: string } }>('/api/buscar', { schema: { tags: ['interfaz'], summary: 'Búsqueda global: equipos, jugadores, partidos y ligas', querystring: { type: 'object', properties: { q: { type: 'string' } } }, response: { 200: ESQUEMA_BUSQUEDA, 404: ESQUEMA_ERROR } } }, async (req, reply) => {
    if (!featureEncendida('interfaz.busqueda')) return reply.code(404).send({ error: 'apagado (features.json: interfaz.busqueda)' });
    return { q: req.query.q ?? '', resultados: buscar((req.query.q ?? '').slice(0, 80)) };
  });
  app.post<{ Body: { patas?: unknown } }>('/api/picks/tarjeta.svg', { schema: { tags: ['analítica'], summary: 'La tarjeta de «Mi selección» como SVG (el navegador la guarda como PNG)', body: { type: 'object', properties: { patas: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['patas'] }, response: { 200: { type: 'string' }, 400: ESQUEMA_ERROR } } }, async (req, reply) => {
    try {
      const patas = validarPatas(req.body.patas);
      return reply.type('image/svg+xml; charset=utf-8').send(tarjetaSvg(patas, combinada(patas)));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}

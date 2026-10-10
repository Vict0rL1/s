// La UFC publicada, bajo /api/ufc. Un espacio propio, como los otros seis deportes: ningún endpoint de
// aquí devuelve un partido de otro deporte.
//
// Se publicó al pasar la misma prueba que los demás (docs/plans/ufc-combinado.md): sobre 7.799 peleas
// puntuables de 2005 a 2025, la logística (Elo + récord + edad, alcance y experiencia) gana a las cuatro
// referencias con el intervalo por debajo de cero, en todo lo puntuable y en 2025 por separado.
// `/backtest` enseña esa evaluación (sin el holdout).

import type { FastifyInstance } from 'fastify';
import { aplicarPublicada } from '../prediction/publicada.ts';
import { cacheado, firmaDe, registrarCalentador } from '../cache/respuestas.ts';
import { versionsFor } from '../versions.ts';
import { env } from '../config.ts';
import { getDb, getMeta } from '../db.ts';
import { buildPrediction, type UfcPrediction } from '../ufc/predict.ts';
import { refrescarCuotas } from '../ufc/proximos.ts';
import { countFighters, countFights, estadoUfc, getFighterInfo, getPowerRanking, getUpcoming, HOLDOUT_UFC, lastOddsUpdate, latestDate, listUpcoming, type UfcUpcomingRow } from '../ufc/repo.ts';
import { fechaUfc, getUfcTrackRecord, logUfcPrediction, resolveUfcPredictions } from '../ufc/trackRecord.ts';
import { CANDIDATOS, MODELO_PUBLICADO, evaluacionPublicada } from '../ufc/combinado.ts';
import { leerFichas, leerPeleas, REFERENCIAS, VALIDACION } from '../ufc/evaluacion.ts';
import { recordSnapshot } from '../prematch/snapshots.ts';
import { deUfc } from '../prematch/adapters.ts';
import { confianzaUfc } from '../trust/adapters.ts';
import { evaluarParaServir } from '../trust/assess.ts';
import { findGameResult, hasStarted } from '../results.ts';
import { readCalibration } from '../staking/calibration.ts';
import { ESQUEMA_ERROR, ESQUEMA_UFC_BACKTEST } from '../api/schemas.ts';

function predictRow(row: UfcUpcomingRow): UfcPrediction | null {
  if (!row.home_id || !row.away_id) return null;
  return buildPrediction({ homeId: row.home_id, awayId: row.away_id, oddsHome: row.odds_home, oddsAway: row.odds_away, fecha: fechaUfc(row.commence_time) });
}

/** Por qué una pelea de la cartelera no tiene número: un luchador sin pelea previa en la UFC o con un nombre que comparten varios. */
function sinPrediccion(row: UfcUpcomingRow): string | null {
  if (row.home_id && row.away_id) return null;
  const faltan = [!row.home_id ? row.home_name : null, !row.away_id ? row.away_name : null].filter(Boolean);
  return `${faltan.join(' y ')}: sin peleas previas en la UFC (debut) o con un nombre que comparten varios luchadores. Sin su Elo ni su ficha no hay número que dar.`;
}

export function describeRow(row: UfcUpcomingRow, withPrediction = true) {
  const prediction = withPrediction ? predictRow(row) : null;
  const snap = prediction ? deUfc(row, prediction) : null;
  // Todas las filas son peleas reales de la casa de apuestas: todas se registran.
  const confianza = prediction ? evaluarParaServir(confianzaUfc(row, prediction), true) : null;
  if (prediction) {
    logUfcPrediction(row, prediction);
    if (snap) recordSnapshot(snap);
    // La cabecera es lo publicado (lo mismo que lee Destacados); el cálculo de ahora, aparte.
    aplicarPublicada('ufc', snap?.matchKey, prediction);
    Object.assign(prediction, { versiones: versionsFor('ufc') });
  }
  return {
    fight: row,
    confianza,
    prePartido: snap ? { sport: 'ufc', matchKey: snap.matchKey } : null,
    outcome: {
      started: hasStarted(row.commence_time),
      result: findGameResult('ufc', { league: 'ufc', homeId: row.home_id, awayId: row.away_id, commenceTime: row.commence_time }),
    },
    prediction,
    sinPrediccion: withPrediction && !prediction ? sinPrediccion(row) : null,
    fighters: {
      home: row.home_id ? getFighterInfo(row.home_id) : null,
      away: row.away_id ? getFighterInfo(row.away_id) : null,
    },
  };
}

/** La firma de la caché: las peleas que vienen y, como el Elo sale del archivo, también el archivo. */
const firma = () => firmaDe('ufc_upcoming', ['SELECT COUNT(*) AS n, MAX(ingested_at) AS i FROM ufc_fights']);

function proximas(withPred: boolean, limit = 40) {
  return cacheado(`ufc:proximas:${withPred}:${limit}`, firma(), () => {
    resolveUfcPredictions();
    return listUpcoming(limit).map((r) => describeRow(r, withPred));
  });
}
registrarCalentador('ufc', () => proximas(true));

let memoBacktest: { firma: string; valor: unknown } | null = null;

/** La evaluación del modelo publicado (la prueba con la que se publicó), en memoria hasta que cambie el archivo. */
export function backtestUfc() {
  const f = getDb().prepare('SELECT COUNT(*) AS n, MAX(ingested_at) AS i, MAX(fecha) AS u FROM ufc_fights').get() as { n: number; i: string | null; u: string | null };
  const clave = `${f.n}|${f.i}`;
  if (memoBacktest?.firma === clave) return memoBacktest.valor;
  const peleas = leerPeleas();
  const r = evaluacionPublicada(peleas, leerFichas());
  const m = r.modelo;
  const clavePorNombre = (nombre: string) => REFERENCIAS.find((x) => x.nombre === nombre)?.clave ?? 'otra';
  const tramo = (t: NonNullable<typeof r.prueba>['todo']) => ({
    n: t.n,
    modelo: t.modelo,
    referencias: t.referencias.map((x) => ({ clave: clavePorNombre(x.nombre), nombre: x.nombre, logLoss: x.ll, mean: x.mean, lo: x.lo, hi: x.hi, p: x.p })),
    contraElo: t.contraElo,
  });
  const e = peleas.length ? estadoUfc() : null;
  const valor = {
    peleas: r.peleas,
    puntuadas: r.puntuadas,
    holdoutExcluido: r.holdoutExcluido,
    sinAtribuir: r.sinAtribuir,
    sinGanador: r.sinGanador,
    ultimo: f.u,
    modelo: m ? { n: m.n, logLoss: m.logLoss, brier: m.brier, accuracy: m.accuracy, ece: m.ece } : null,
    eloSolo: r.eloSolo,
    referencias: r.referencias,
    porAnio: r.porAnio,
    prueba: r.prueba
      ? {
          validacion: VALIDACION,
          eleccion: r.prueba.eleccion.map((x) => ({ candidato: x.candidato, rasgos: [...CANDIDATOS[x.candidato]], llEntrenamiento: x.llEntrenamiento })),
          elegido: r.prueba.elegido,
          todo: tramo(r.prueba.todo),
          enValidacion: tramo(r.prueba.validacion),
          pasa: r.prueba.pasa,
          mejoraAlElo: r.prueba.mejoraAlElo,
        }
      : null,
    pesos: e ? Object.fromEntries(CANDIDATOS[MODELO_PUBLICADO].map((k, i) => [k, e.pesos[i] ?? 0])) : {},
    ajustadaCon: e?.ajustadaCon ?? 0,
    holdoutDesde: HOLDOUT_UFC,
    aviso: r.aviso,
    nota:
      peleas.length === 0
        ? 'sin peleas en ufc_fights: corre npm run update-data:ufc donde la red alcance raw.githubusercontent.com.'
        : 'Walk-forward por año: cada año se predice con una logística ajustada solo con los anteriores. El holdout no se puntúa.',
  };
  memoBacktest = { firma: clave, valor };
  return valor;
}

export async function registerUfcRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meta', async () => ({
    updatedAt: getMeta('ufc:updatedAt'),
    oddsRefreshedAt: lastOddsUpdate(),
    oddsFallbackReason: getMeta('ufc_odds_fallback_reason') || null,
    oddsFallbackDetail: getMeta('ufc_odds_fallback_detail') || null,
    hasOddsKey: !!env.oddsApiKey,
    autoRefreshMinutes: env.autoRefreshMinutes,
    bands: readCalibration()['ufc']?.bands ?? null,
    counts: { fighters: countFighters(), fights: countFights() },
    historyThrough: latestDate(),
    /** De la última actualización de cuotas: peleas de otras organizaciones descartadas y peleas sin identificar. */
    descartadas: Number(getMeta('ufc:descartadas') ?? 0) || 0,
    sinIdentificar: Number(getMeta('ufc:sinIdentificar') ?? 0) || 0,
    model: { candidato: MODELO_PUBLICADO, rasgos: [...CANDIDATOS[MODELO_PUBLICADO]], holdoutDesde: HOLDOUT_UFC },
  }));

  app.get<{ Querystring: { predictions?: string; limit?: string } }>('/fights/upcoming', async (req) =>
    proximas(req.query.predictions !== 'false', Math.min(Math.max(Number(req.query.limit) || 40, 1), 80)),
  );

  app.get<{ Params: { id: string } }>('/fights/:id', async (req, reply) => {
    const row = getUpcoming(req.params.id);
    if (!row) return reply.code(404).send({ error: 'pelea no encontrada' });
    return describeRow(row);
  });

  app.get<{ Params: { id: string } }>('/fighters/:id', async (req, reply) => {
    if (!/^[0-9a-f]{8,32}$/i.test(req.params.id)) return reply.code(404).send({ error: 'luchador no encontrado' });
    const info = getFighterInfo(req.params.id.toLowerCase());
    if (!info) return reply.code(404).send({ error: 'luchador no encontrado' });
    return info;
  });

  app.get<{ Querystring: { limit?: string } }>('/power', async (req) => ({ fighters: getPowerRanking(Math.min(Number(req.query.limit) || 40, 100)) }));

  /** Predicción a la carta: dos ids de ufcstats y, si se quiere, las cuotas del boleto. */
  app.post<{ Body: { a?: string; b?: string; oddsA?: number; oddsB?: number } }>('/predict', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.a || !b.b) return reply.code(400).send({ error: 'hacen falta a y b (ids de ufcstats)' });
    const p = buildPrediction({ homeId: b.a.toLowerCase(), awayId: b.b.toLowerCase(), oddsHome: b.oddsA ?? null, oddsAway: b.oddsB ?? null });
    if (!p) return reply.code(404).send({ error: 'luchador no encontrado' });
    return p;
  });

  app.get('/track-record', async () => {
    resolveUfcPredictions();
    return getUfcTrackRecord();
  });

  app.get('/backtest', { schema: { tags: ['modelos'], summary: 'UFC: evaluación del backtest con la que se publicó (sin el holdout)', response: { 200: ESQUEMA_UFC_BACKTEST, 404: ESQUEMA_ERROR } } }, async () => backtestUfc());

  app.post('/refresh', async (_req, reply) => {
    if (countFights() === 0) return reply.code(409).send({ error: 'No hay archivo de la UFC. Corre `npm run update-data:ufc` primero.' });
    // Manual: alguien ha pulsado el botón (el guardia de ritmo mensual es para el temporizador).
    return { ok: true, stored: await refrescarCuotas(true) };
  });
}

/** Predice las próximas (registro e instantáneas) sin que nadie abra la pestaña: lo llama el ciclo pre-partido. */
export function predecirProximasUfc(): number {
  const rows = listUpcoming(80);
  for (const r of rows) describeRow(r, true);
  return rows.length;
}

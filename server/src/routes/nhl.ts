// La NHL publicada, bajo /api/nhl (seguimiento: NHL y UFC). Un espacio propio, como los otros cinco
// deportes: ningún endpoint de aquí devuelve un partido de otro deporte.
//
// Se publicó al pasar la misma prueba que los demás (docs/NHL.md): sobre 20.214 partidos puntuables
// de 2009-10 a 2024-25, el modelo gana a «siempre el local» y a un Elo básico con el intervalo lejos
// del cero. `/backtest` enseña esa evaluación (sin el holdout).

import type { FastifyInstance } from 'fastify';
import { cacheado, firmaDe, registrarCalentador } from '../cache/respuestas.ts';
import { versionsFor } from '../versions.ts';
import { env } from '../config.ts';
import { getDb, getMeta } from '../db.ts';
import { buildPrediction, type NhlPrediction } from '../nhl/predict.ts';
import { refrescarCuotas } from '../nhl/proximos.ts';
import { countGames, countTeams, getPowerRanking, getTeamInfo, getUpcoming, lastOddsUpdate, latestDate, listTeams, listUpcoming, type NhlUpcomingRow } from '../nhl/repo.ts';
import { getNhlTrackRecord, logNhlPrediction, resolveNhlPredictions } from '../nhl/trackRecord.ts';
import { evaluarNhl } from '../nhl/evaluacion.ts';
import { NHL } from '../nhl/model.ts';
import { recordSnapshot } from '../prematch/snapshots.ts';
import { deNhl } from '../prematch/adapters.ts';
import { confianzaNhl } from '../trust/adapters.ts';
import { evaluarParaServir } from '../trust/assess.ts';
import { findGameResult, hasStarted } from '../results.ts';
import { readCalibration } from '../staking/calibration.ts';
import { ESQUEMA_ERROR, ESQUEMA_NHL_BACKTEST } from '../api/schemas.ts';
import { aplicarPublicada } from '../prediction/publicada.ts';

function predictRow(row: NhlUpcomingRow): NhlPrediction | null {
  if (!row.home_id || !row.away_id) return null;
  return buildPrediction({
    homeId: row.home_id,
    awayId: row.away_id,
    oddsHome: row.odds_home,
    oddsAway: row.odds_away,
    totalLine: row.total_line,
    oddsOver: row.odds_over,
    oddsUnder: row.odds_under,
  });
}

export function describeRow(row: NhlUpcomingRow, withPrediction = true) {
  const prediction = withPrediction ? predictRow(row) : null;
  const snap = prediction ? deNhl(row, prediction) : null;
  // Todas las filas de la NHL son partidos reales (calendario oficial o cuotas): todas se registran.
  const confianza = prediction ? evaluarParaServir(confianzaNhl(row, prediction), true) : null;
  if (prediction) {
    logNhlPrediction(row, prediction);
    if (snap) recordSnapshot(snap);
    // La cabecera es lo publicado (lo mismo que lee Destacados); el cálculo de ahora, aparte.
    aplicarPublicada('nhl', snap?.matchKey, prediction);
    Object.assign(prediction, { versiones: versionsFor('nhl') });
  }
  return {
    game: row,
    confianza,
    prePartido: snap ? { sport: 'nhl', matchKey: snap.matchKey } : null,
    outcome: {
      started: hasStarted(row.commence_time),
      result: findGameResult('nhl', { league: 'nhl', homeId: row.home_id, awayId: row.away_id, commenceTime: row.commence_time }),
    },
    prediction,
    teams: {
      home: row.home_id ? getTeamInfo(row.home_id) : null,
      away: row.away_id ? getTeamInfo(row.away_id) : null,
    },
    /** Si la línea del total la puso una casa o el modelo. */
    linesFromMarket: row.total_line != null,
  };
}

/** La firma de la caché: los próximos y, como el Elo sale del archivo, también el archivo. */
const firma = () => firmaDe('nhl_upcoming', ['SELECT COUNT(*) AS n, MAX(ingested_at) AS i FROM nhl_games']);

function proximos(withPred: boolean, limit = 24) {
  return cacheado(`nhl:proximos:${withPred}:${limit}`, firma(), () => {
    resolveNhlPredictions();
    return listUpcoming(limit).map((r) => describeRow(r, withPred));
  });
}
registrarCalentador('nhl', () => proximos(true));

let memoBacktest: { firma: string; valor: unknown } | null = null;

/** La evaluación del backtest (la prueba con la que se publicó), en memoria hasta que cambie el archivo. */
export function backtestNhl() {
  const f = getDb().prepare('SELECT COUNT(*) AS n, MAX(ingested_at) AS i, MAX(game_date) AS u FROM nhl_games').get() as { n: number; i: string | null; u: string | null };
  const clave = `${f.n}|${f.i}`;
  if (memoBacktest?.firma === clave) return memoBacktest.valor;
  const r = evaluarNhl();
  const m = r.modelo;
  const valor = {
    partidos: r.partidos,
    puntuados: r.puntuados,
    holdoutExcluido: r.holdoutExcluido,
    ultimo: f.u,
    modelo: m ? { n: m.n, logLoss: m.logLoss, brier: m.brier, accuracy: m.accuracy, ece: m.ece } : null,
    referencias: r.referencias,
    porTemporada: r.porTemporada,
    aviso: r.aviso,
    nota: r.nota,
    parametros: { k: NHL.k, campo: NHL.campo, golesLiga: NHL.golesLiga, fuerzaProrroga: NHL.fuerzaProrroga },
  };
  memoBacktest = { firma: clave, valor };
  return valor;
}

export async function registerNhlRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meta', async () => ({
    updatedAt: getMeta('nhl:updatedAt'),
    calendarAt: getMeta('nhl:calendarAt'),
    oddsRefreshedAt: lastOddsUpdate(),
    oddsFallbackReason: getMeta('nhl_odds_fallback_reason') || null,
    oddsFallbackDetail: getMeta('nhl_odds_fallback_detail') || null,
    hasOddsKey: !!env.oddsApiKey,
    autoRefreshMinutes: env.autoRefreshMinutes,
    bands: readCalibration()['nhl']?.bands ?? null,
    counts: { teams: countTeams(), games: countGames() },
    historyThrough: latestDate(),
    league: { homeAdvantageElo: NHL.campo, k: NHL.k, goalsPerGame: NHL.golesLiga },
  }));

  app.get<{ Querystring: { predictions?: string; limit?: string } }>('/games/upcoming', async (req) =>
    proximos(req.query.predictions !== 'false', Math.min(Math.max(Number(req.query.limit) || 24, 1), 64)),
  );

  app.get<{ Params: { id: string } }>('/games/:id', async (req, reply) => {
    const row = getUpcoming(req.params.id);
    if (!row) return reply.code(404).send({ error: 'partido no encontrado' });
    return describeRow(row);
  });

  app.get('/teams', async () => listTeams());

  app.get<{ Params: { id: string } }>('/teams/:id', async (req, reply) => {
    const info = getTeamInfo(req.params.id.toUpperCase());
    if (!info) return reply.code(404).send({ error: 'equipo no encontrado' });
    return info;
  });

  app.get<{ Querystring: { limit?: string } }>('/power', async (req) => ({ teams: getPowerRanking(Math.min(Number(req.query.limit) || 40, 40)) }));

  /** Predicción a la carta: dos equipos y, si se quiere, las cuotas y la línea del boleto. */
  app.post<{ Body: { home?: string; away?: string; oddsHome?: number; oddsAway?: number; totalLine?: number } }>('/predict', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.home || !b.away) return reply.code(400).send({ error: 'hacen falta home y away (abreviaturas: TOR, BOS…)' });
    const p = buildPrediction({ homeId: b.home.toUpperCase(), awayId: b.away.toUpperCase(), oddsHome: b.oddsHome ?? null, oddsAway: b.oddsAway ?? null, totalLine: b.totalLine ?? null });
    if (!p) return reply.code(404).send({ error: 'equipo no encontrado' });
    return p;
  });

  app.get('/track-record', async () => {
    resolveNhlPredictions();
    return getNhlTrackRecord();
  });

  app.get('/backtest', { schema: { tags: ['modelos'], summary: 'NHL: evaluación del backtest con la que se publicó (sin el holdout)', response: { 200: ESQUEMA_NHL_BACKTEST, 404: ESQUEMA_ERROR } } }, async () => backtestNhl());

  app.post('/refresh', async (_req, reply) => {
    if (countGames() === 0) return reply.code(409).send({ error: 'No hay datos de la NHL. Corre `npm run update-data:nhl` primero.' });
    // Manual: alguien ha pulsado el botón (el guardia de ritmo mensual es para el temporizador).
    return { ok: true, stored: await refrescarCuotas(true) };
  });
}

/** Predice los próximos (registro e instantáneas) sin que nadie abra la pestaña: lo llama el ciclo pre-partido. */
export function predecirProximosNhl(): number {
  const rows = listUpcoming(64);
  for (const r of rows) describeRow(r, true);
  return rows.length;
}

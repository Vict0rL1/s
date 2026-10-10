// All REST endpoints. Kept in one place for readability; each handler is thin
// and delegates to repo (DB reads) and model (predict).

import { featureEncendida } from '../features.ts';
import { aplicarPublicada } from '../prediction/publicada.ts';
import { validacionEnVivo } from '../evaluation/validation.ts';
import { evaluacionEnVivo } from '../evaluation/live.ts';
import { rendimientoEnVivo } from '../evaluation/betting.ts';
import { calidadSeleccion } from '../trust/evaluation.ts';
import { resumenMercado, durabilidad } from '../odds/edgeAnalysis.ts';
import { getDb } from '../db.ts';
import { versionsFor } from '../versions.ts';
import type { FastifyInstance } from 'fastify';
import { env, toursConfig, tournamentsConfig } from '../config.ts';
import {
  getQuota,
  lastCycleCredits,
  planTotal,
  quotaReserve,
  recommendedRefreshMinutes,
} from '../oddsQuota.ts';
import { getMeta } from '../db.ts';
import {
  countRows,
  getEloRanking,
  getProfile,
  officialRankingCoherence,
  getH2HMeetings,
  getPlayerInfo,
  getUpcomingById,
  getUpcomingTournaments,
  listUpcoming,
  searchPlayers,
} from '../repo.ts';
import { computeH2H } from '../model/h2h.ts';
import { impliedProbabilities, type MarketProbabilities } from '../model/market.ts';
import { buildPrediction, type Prediction } from '../model/predict.ts';
import { refreshOdds } from '../ingest/odds.ts';
import { ejecuciones, ultimasEjecuciones } from '../ingest/runs.ts';
import { ESQUEMA_DATOS_ESTADO, ESQUEMA_INGESTION_RUNS } from '../api/schemas.ts';
import { copiasLocales, ultimaCopia } from '../db/backup.ts';
import { LAYOUT, ficherosDe } from '../db/layout.ts';
import { configS3 } from '../db/s3.ts';
import { ejecutar } from '../ask/router.ts';
import { responderAgente } from '../ask/agent.ts';
import { enrutarConModelo } from '../ask/llm.ts';
import { place, settle, resumen, bancoActual } from '../paper/bankroll.ts';
import { colocarEstrategias, liquidarEstrategias } from '../estrategias/index.ts';
import { cacheado, firmaDe, registrarCalentador } from '../cache/respuestas.ts';
import { riesgoCartera } from '../staking/risk.ts';
import { lineaTemporal } from '../audit/timeline.ts';
import { reproducir } from '../audit/reproduce.ts';
import { alertas } from '../alerts/engine.ts';
import { confianzaDelSistema } from '../evaluation/system.ts';
import { informeSombras } from '../shadow/evaluation.ts';
import { leerEnsembles } from '../shadow/ensemble.ts';
import { readRegistry, distinctExperiments, interpretarExperimento } from '../experiments/registry.ts';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import { partidosDeHoy, historialReciente, VENTANAS } from '../today.ts';
import { mejoresPartidos, HORIZONTES } from '../picks/top.ts';
import { evaluate } from '../live/engine.ts';
import { matchupServe } from '../live/serve.ts';
import { describe as describeState, advancePoint, validate as validarMarcador, type LiveState } from '../live/state.ts';
import { predictFromPoints } from '../points/predict.ts';
import { modelForServing } from '../points/repo.ts';
import type { Surface as PointsSurface } from '../points/fit.ts';
import { readCalibration } from '../staking/calibration.ts';
import { getTrackRecord, logPrediction } from '../trackRecord.ts';
import { recordSnapshot, horizontes, cambios, finalPrePartido, instantaneas } from '../prematch/snapshots.ts';
import { evaluacionPorHorizonte } from '../prematch/evaluation.ts';
import { isSportId } from '../sports.ts';
import { deTenis } from '../prematch/adapters.ts';
import { confianzaTenis } from '../trust/adapters.ts';
import { evaluarParaServir } from '../trust/assess.ts';
import type { TourId, UpcomingRow } from '../types.ts';
import { closingLine, history, latestLine, openingLine, selectionsOf } from '../odds/snapshots.ts';

/** Attach a full prediction to an upcoming-match row (null if players unknown). */
function predictRow(row: UpcomingRow): Prediction | null {
  if (row.p1_id == null || row.p2_id == null) return null;
  // Men's Grand Slam singles are best-of-5; everything else best-of-3.
  const category = tournamentsConfig.tournaments.find((t) => t.id === row.tournament_id)?.category;
  const bestOf = category === 'grand_slam' && row.tour === 'atp' ? 5 : 3;
  return buildPrediction(
    row.tour,
    row.p1_id,
    row.p2_id,
    row.surface,
    { odds1: row.p1_odds, odds2: row.p2_odds },
    bestOf,
    row.tournament_name || undefined,
  );
}

/**
 * The market's own probabilities, for matches the model can't predict (a player
 * missing from the history). The odds are real data we already hold, so showing
 * them beats showing nothing — clearly labelled as the market, not the model.
 */
function marketOnly(row: UpcomingRow): MarketProbabilities | null {
  if (row.p1_odds == null || row.p2_odds == null) return null;
  return impliedProbabilities(row.p1_odds, row.p2_odds);
}

/** Shape returned for every upcoming match. */
function describeRow(row: UpcomingRow, withPrediction = true) {
  const prediction = withPrediction ? predictRow(row) : null;
  // Record what we're about to show, so it can be scored once the real result
  // lands (see trackRecord.ts). Only for LIVE fixtures: demo fixtures are
  // synthetic matches that will never be played, and scoring the app against
  // invented results would make the track record meaningless.
  const snap = prediction ? deTenis(row, prediction) : null;
  // ¿Cuánto fiarse de este número? (trust/). Se registra solo si el partido es real.
  const confianza = prediction ? evaluarParaServir(confianzaTenis(row, prediction), row.source === 'live') : null;
  if (prediction && row.source === 'live') {
    logPrediction(row, prediction);
    // Y la instantánea pre-partido, si cambió algo (ver prematch/snapshots.ts).
    if (snap) recordSnapshot(snap);
    // La cabecera es lo publicado (lo mismo que lee Destacados); el cálculo de ahora, aparte.
    aplicarPublicada('tennis', snap?.matchKey, prediction);
  }
  // Qué versión exacta produjo el número que se enseña (ver versions.ts).
  if (prediction) Object.assign(prediction, { versiones: versionsFor('tennis') });
  const played = findTennisResult(row.tour, row.p1_id, row.p2_id, row.commence_time);
  return {
    match: row,
    confianza,
    // Para pedir sus instantáneas pre-partido: /api/prematch/:sport/:key.
    prePartido: snap && row.source === 'live' ? { sport: 'tennis', matchKey: snap.matchKey } : null,
    /**
     * WHO WON, once it has been played and the archive has it.
     *
     * Tennis has no home side, so the archive records a winner rather than two
     * scores — hence a `winnerId` and the set score, not a pair of numbers.
     * `started` without a `result` means it is being played or the score has not
     * been ingested yet, which are different from "never happened".
     */
    outcome: {
      started: hasStarted(row.commence_time),
      result: played
        ? {
            winnerId: played.winnerId,
            winnerName: played.winnerId === row.p1_id ? row.p1_name : row.p2_name,
            score: played.score,
            playedOn: played.playedOn,
          }
        : null,
    },
    prediction,
    // Only when the model has nothing to say, so clients never have two sources.
    marketOnly: prediction ? null : marketOnly(row),
    // Player facts (official ranking, country, age…) that don't need a complete
    // match history — so unrated players are still described rather than blank.
    players: {
      p1: getPlayerInfo(row.tour, row.p1_id ?? row.p1_name),
      p2: getPlayerInfo(row.tour, row.p2_id ?? row.p2_name),
    },
  };
}


/** La lista de próximos de tenis, cacheada mientras no cambien sus datos (Fase 7.2). */
function proximosTenis(tour: string | undefined, tournament: string | undefined, withPred: boolean) {
  return cacheado(`tennis:proximos:${tour ?? ''}:${tournament ?? ''}:${withPred}`, firmaDe('upcoming_matches'), () =>
    listUpcoming({ tour, tournament }).map((row) => describeRow(row, withPred)),
  );
}
registrarCalentador('tennis', () => proximosTenis(undefined, undefined, true));

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Las ingestas: la última por fuente y el historial (filtrable por fuente). Para el
  // diagnóstico de la Fase 5 y para contestar «¿cuándo se bajaron resultados y qué pasó?».
  app.get<{ Querystring: { source?: string; limite?: string } }>('/ingestion-runs', { schema: { tags: ['operación'], summary: 'Ingestas: última por fuente e historial', response: { 200: ESQUEMA_INGESTION_RUNS } } }, async (req) => ({
    ultimas: ultimasEjecuciones(),
    historial: ejecuciones({ source: req.query.source?.slice(0, 60) || undefined, limite: Math.max(1, Math.min(500, Number(req.query.limite) || 100)) }),
  }));

  // El estado del almacenamiento: disposición, tamaño de cada fichero, última copia y
  // cuántas hay. Solo lectura; la copia la lanza el servidor o `npm run backup`.
  app.get('/datos/estado', { schema: { tags: ['operación'], summary: 'Ficheros de la base, copias y retención', response: { 200: ESQUEMA_DATOS_ESTADO } } }, async () => {
    const f = ficherosDe();
    const mb = (ruta: string | null) => (ruta && fs.existsSync(ruta) ? Math.round((fs.statSync(ruta).size / 1048576) * 10) / 10 : null);
    const copia = ultimaCopia();
    return {
      layout: LAYOUT,
      history: { ruta: f.history, mb: mb(f.history) },
      ledger: f.ledger ? { ruta: f.ledger, mb: mb(f.ledger) } : null,
      backup: copia ? { ...copia, existe: !!copia.fichero && fs.existsSync(copia.fichero), copiasLocales: copiasLocales().length, s3: !!configS3() } : { cuando: null, copiasLocales: copiasLocales().length, s3: !!configS3() },
      retencion: { ultima: getMeta('retention:last_at'), borradas: Number(getMeta('retention:last_removed')) || 0 },
    };
  });

  /**
   * How much of The Odds API's monthly allowance is left.
   *
   * One endpoint rather than a field on all five /meta responses, because the
   * quota is a property of the API KEY, not of a sport. Shown in the footer on
   * every tab: the free plan running out silently is what caused all of this, and
   * a number on screen is the cheapest possible fix for that.
   */
  app.get('/odds-quota', async () => {
    const q = getQuota();
    const plan = planTotal();
    return {
      ...q,
      hasKey: !!env.oddsApiKey,
      reserve: quotaReserve(),
      // The plan size, learned from the response headers rather than configured.
      plan,
      creditsPerCycle: lastCycleCredits(),
      // What the app has worked out it can afford, next to what it is doing.
      autoRefreshMinutes: env.autoRefreshMinutes,
      recommendedRefreshMinutes: recommendedRefreshMinutes(),
      regions: env.oddsRegions,
    };
  });

  // --- meta / health ---
  app.get('/health', async () => ({ ok: true }));

  app.get('/meta', async () => ({
    dataSource: getMeta('data_source') ?? 'unknown',
    seededAt: getMeta('seeded_at'),
    updatedAt: getMeta('updated_at'),
    oddsSource: getMeta('odds_source'),
    // POR QUÉ son de demostración, no solo que lo son. Sin esto la pantalla tenía que
    // suponer la causa, y suponía la equivocada dos de cada tres veces.
    oddsFallbackReason: getMeta('odds_fallback_reason') || null,
    oddsFallbackDetail: getMeta('odds_fallback_detail') || null,
    // Si está apagado, una pestaña vacía NO es un fallo: es lo que se pidió.
    demoFixtures: env.demoFixtures,
    // El acierto REAL por banda de confianza, del backtest de este deporte. Es lo que
    // permite que un filtro «solo los claros» diga cuánto acierta en vez de insinuarlo.
    bands: readCalibration()['tennis']?.bands ?? null,
    oddsRefreshedAt: getMeta('odds_refreshed_at'),
    autoRefreshMinutes: env.autoRefreshMinutes,
    hasOddsKey: !!env.oddsApiKey,
    // Newest match in the history (YYYYMMDD). If this is old, Elo is stale and
    // predictions are unreliable — the UI surfaces this.
    historyThrough: getMeta('history_through'),
    counts: {
      players: countRows('players'),
      matches: countRows('matches'),
      ratings: countRows('player_ratings'),
      upcoming: countRows('upcoming_matches'),
    },
    /**
     * The same counts split by circuit, because the totals hide the case that
     * matters: the WTA tab has zero players, zero matches and zero fixtures while
     * the header proudly reads "61.682 partidos · 2218 jugadores". Without this the
     * UI cannot tell "this circuit has no source" from "nothing is scheduled today",
     * and it printed the same dead-end line for both.
     */
    byTour: Object.fromEntries(
      (getDb()
        .prepare(
          `SELECT t.tour,
                  (SELECT COUNT(*) FROM matches m WHERE m.tour = t.tour) AS matches,
                  (SELECT COUNT(*) FROM player_ratings r WHERE r.tour = t.tour) AS ratings
             FROM (SELECT 'atp' AS tour UNION ALL SELECT 'wta') t`,
        )
        .all() as unknown as { tour: string; matches: number; ratings: number }[]).map((r) => [
        r.tour,
        { matches: r.matches, ratings: r.ratings },
      ]),
    ),
  }));

  // --- the app's own measured accuracy on real, already-played matches ---
  /**
   * La clasificación por Elo del circuito.
   *
   * `activeDays` por defecto son 730: un Elo se congela en el último partido, y sin
   * filtro la lista contesta «quién llegó más alto» a la pregunta «quién es mejor
   * ahora». Con `activeDays=0` se pide la histórica a propósito.
   */
  app.get<{
    Querystring: { tour?: string; limit?: string; minMatches?: string; activeDays?: string };
  }>('/power', async (req) => {
    const tour = (req.query.tour ?? 'atp') as TourId;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const minMatches = req.query.minMatches != null ? Number(req.query.minMatches) : 20;
    const raw = req.query.activeDays;
    // `0` significa «sin filtro» y no «hoy mismo»: un umbral de cero días dejaría la
    // lista vacía, que no es lo que pide nadie escribiendo un cero.
    const activeDays = raw == null ? 730 : Number(raw) > 0 ? Number(raw) : null;
    const players = getEloRanking(tour, { limit, minMatches, activeDays });
    return {
      tour,
      minMatches,
      activeDays,
      players,
      // Cuántos hay en total con ese mínimo de partidos, para que se vea qué parte de
      // la lista se está mirando y cuántos quedaron fuera por inactividad.
      rated: getEloRanking(tour, { limit: 500, minMatches, activeDays: null }).length,
      // El ranking oficial NO es una foto de un día: cada jugador trae el suyo con su
      // fecha. Se dice aquí para que el panel pueda advertirlo en vez de enseñar tres
      // «#5» seguidos como si fuera un fallo de la app.
      officialRanking: officialRankingCoherence(tour),
    };
  });

  /**
   * El motor en vivo. POST porque el marcador es un objeto con seis campos, y meterlo
   * en una query string lo haría ilegible y difícil de validar.
   *
   * Los `prior` se pueden pasar a mano o dejar que salgan de los ids de los jugadores;
   * lo segundo es lo normal y lo primero permite probar el motor sin base.
   */
  /**
   * Todos los mercados de un partido, del modelo jerárquico de puntos.
   *
   * Un solo endpoint para partido, set, hándicap y total: son la misma distribución
   * mirada de cuatro formas. Endpoints separados invitarían a que alguien calculara uno
   * de ellos por otro camino, que es justo lo que este modelo existe para impedir.
   */
  app.get<{
    Querystring: {
      tour?: string;
      p1?: string;
      p2?: string;
      surface?: string;
      bestOf?: string;
      tourney?: string;
      date?: string;
    };
  }>('/points', async (req, reply) => {
    const tour = (req.query.tour ?? 'atp') as TourId;
    const id1 = Number(req.query.p1);
    const id2 = Number(req.query.p2);
    if (!Number.isFinite(id1) || !Number.isFinite(id2)) {
      return reply.code(400).send({ error: 'hacen falta los ids `p1` y `p2`' });
    }
    const surfaceRaw = (req.query.surface ?? 'Hard').toLowerCase();
    const surface: PointsSurface =
      surfaceRaw.startsWith('cl') || surfaceRaw.startsWith('tie')
        ? 'Clay'
        : surfaceRaw.startsWith('gr') || surfaceRaw.startsWith('hie')
          ? 'Grass'
          : 'Hard';

    const model = modelForServing(tour);
    if (!model) {
      return reply.code(503).send({
        error:
          'El modelo de puntos no está ajustado y no se ha podido ajustar ahora. ' +
          'Corre `npm run update-data` para traer datos de saque.',
      });
    }

    const p = predictFromPoints(
      model,
      id1,
      id2,
      surface,
      Number(req.query.bestOf) || 3,
      req.query.tourney,
      req.query.date,
    );
    // Sin datos de alguno, todos los mercados salen del jugador medio. Se rechaza en vez
    // de servir cuatro mercados coherentes entre sí y ajenos a este partido.
    if (p.unknown.p1 || p.unknown.p2) {
      return reply.code(404).send({
        error:
          `Sin datos de puntos para ${[p.unknown.p1 ? `p1=${id1}` : null, p.unknown.p2 ? `p2=${id2}` : null]
            .filter(Boolean)
            .join(' y ')}. Todos los mercados saldrían del jugador medio.`,
      });
    }

    return {
      ...p,
      model: {
        fittedAt: model.fittedAt,
        ageDays: Math.round(model.ageDays),
        observations: model.meta.observations,
        players: model.meta.players,
        // Un modelo viejo sirve números creíbles para jugadores que no conoce. Se dice.
        stale: model.ageDays > 30,
      },
    };
  });

  // Tenis en vivo punto a punto (Fase 8.4): el marcador avanza con la regla del servidor, la misma
  // que usa el motor, para que la pantalla no tenga su propia copia de cómo se cuenta un tiebreak.
  app.post<{ Body: { state?: LiveState; winner?: number } }>('/live/avanzar', async (req, reply) => {
    if (!featureEncendida('tenis.enVivo')) return reply.code(404).send({ error: 'apagado (features.json: tenis.enVivo)' });
    const b = req.body ?? {};
    if (!b.state || (b.winner !== 1 && b.winner !== 2)) return reply.code(400).send({ error: 'pasa `state` (el marcador) y `winner` (1 o 2)' });
    const invalido = validarMarcador(b.state);
    if (invalido.length) return reply.code(400).send({ error: invalido.map((i) => i.reason).join(' · ') });
    const r = advancePoint(b.state, b.winner);
    return 'done' in r ? { terminado: true, ganador: r.done, state: null } : { terminado: false, ganador: null, state: r };
  });

  app.post<{
    Body: {
      state: LiveState;
      tour?: string;
      p1?: number;
      p2?: number;
      surface?: string | null;
      prior?: [number, number];
      tally?: [{ won: number; played: number }, { won: number; played: number }];
      odds?: [number, number] | null;
      lastGame?: { winner: 1 | 2; wasBreak: boolean };
      kappa?: number;
    };
  }>('/live', async (req, reply) => {
    const b = req.body ?? ({} as never);
    if (!b.state) return reply.code(400).send({ error: 'falta `state` con el marcador' });

    let prior = b.prior;
    let derived: ReturnType<typeof matchupServe> | null = null;
    if (!prior) {
      if (b.p1 == null || b.p2 == null) {
        return reply
          .code(400)
          .send({ error: 'pasa `prior` o los ids `p1` y `p2` para derivarlo del histórico' });
      }
      derived = matchupServe((b.tour ?? 'atp') as TourId, Number(b.p1), Number(b.p2), b.surface);
      // Sin datos del jugador, `matchupServe` devuelve la media del circuito — que es un
      // número perfectamente creíble y no dice nada de nadie. Se rechaza en vez de
      // servir una probabilidad de partido construida sobre dos medias.
      if (derived.detail.unknown1 || derived.detail.unknown2) {
        const who = [
          derived.detail.unknown1 ? `p1=${b.p1}` : null,
          derived.detail.unknown2 ? `p2=${b.p2}` : null,
        ].filter(Boolean);
        return reply.code(404).send({
          error:
            `Sin datos de saque para ${who.join(' y ')}. Sin ellos el modelo usaría la ` +
            'media del circuito para los dos y devolvería una probabilidad que no habla ' +
            'de este partido. Comprueba los ids o pasa `prior` a mano.',
        });
      }
      prior = [derived.p1, derived.p2];
    }

    const result = evaluate({
      state: b.state,
      prior,
      tally: b.tally,
      odds: b.odds,
      lastGame: b.lastGame,
      kappa: b.kappa,
    });
    // El marcador inválido devuelve 400 CON el detalle, no una probabilidad. Un 8-2 en
    // juegos produce un número perfectamente creíble si se deja pasar.
    if (result.invalid.length > 0) {
      return reply.code(400).send({ error: 'marcador imposible', invalid: result.invalid });
    }
    return { ...result, derived, describe: describeState(b.state) };
  });

  app.get<{ Querystring: { tour?: string } }>('/track-record', async (req) => {
    return getTrackRecord(req.query.tour);
  });

  // --- manual odds refresh (button in the UI / on demand) ---
  app.post('/refresh', async (_req, reply) => {
    if (countRows('players') === 0) {
      return reply
        .code(409)
        .send({ error: 'No hay datos. Corre `npm run seed` o `npm run update-data` primero.' });
    }
    // `true` = refresco MANUAL: alguien ha pulsado el botón. Sin esa marca, el guardia
    // de ritmo mensual —que existe para frenar el TIMER de fondo— frenaba también lo
    // que una persona acababa de pedir, y encima lo reportaba como «no hay partidos».
    const result = await refreshOdds(true);
    return { ok: true, ...result };
  });

  // --- las instantáneas pre-partido de un partido: T-24h, T-6h, T-1h, final y cambios ---
  // La clave es la del registro de predicciones (lleva «|»: va codificada en la URL).
  app.get<{ Params: { sport: string; key: string } }>('/prematch/:sport/:key', async (req, reply) => {
    const { sport, key } = req.params;
    if (!isSportId(sport)) return reply.code(400).send({ error: 'deporte desconocido' });
    const filas = instantaneas(sport, key);
    const commence = filas[filas.length - 1]?.commence_time ?? null;
    return {
      sport,
      matchKey: key,
      commence,
      instantaneas: filas.length,
      // Los nombres de los resultados, de la última instantánea: con los horizontes aún pendientes
      // no hay otra fila de donde sacarlos (G1b).
      outcomes: filas[filas.length - 1]?.outcomes ?? [],
      horizontes: commence ? horizontes(sport, key, commence) : [],
      cambios: cambios(sport, key),
      final: finalPrePartido(sport, key),
    };
  });
  // ¿Mejora el modelo cerca del partido? Emparejado sobre los mismos partidos.
  app.get('/prematch/evaluacion', async () => ({ origen: 'live', deportes: evaluacionPorHorizonte() }));

  // --- el mercado alrededor de las ventajas: duración, slippage y mejor línea ---
  app.get('/market/analysis', async () => {
    const senales = getDb()
      .prepare(
        `SELECT id, sport, selection, provider_event_id AS ev, provider_selection AS sel, model_probability_calibrated AS p,
                commence_time, created_at, decision, edge
           FROM edge_signals WHERE provider_event_id IS NOT NULL AND commence_time IS NOT NULL AND edge > 0
          ORDER BY id DESC LIMIT 40`,
      )
      .all() as { id: number; sport: string; selection: string; ev: string; sel: string; p: number; commence_time: string; created_at: string; decision: string; edge: number }[];
    return {
      ...resumenMercado(),
      durabilidad: senales.map((s) => ({ ...s, ...durabilidad(s.ev, s.sel, s.p, s.commence_time) })),
    };
  });

  // --- qué se juega hoy, en los cinco deportes ---
  app.get('/today', async () => partidosDeHoy());

  // --- y el cierre del círculo: qué dijo el modelo y qué pasó ---
  // --- evaluación EN VIVO, con la capa común de métricas (fase 6) ---
  // Solo registros de predicciones reales: ningún número de backtest entra aquí.
  app.get('/evaluation', async () => ({
    origen: 'live',
    deportes: evaluacionEnVivo(),
    validacion: validacionEnVivo(),
    rendimiento: rendimientoEnVivo(),
    // ¿Sirve abstenerse? Apostables contra abstenidas, y cobertura contra rendimiento.
    seleccion: calidadSeleccion(),
  }));

  // --- las versiones vigentes de los cinco modelos (fase 5) ---
  app.get('/versions', async () => ({
    tenis: versionsFor('tennis'),
    futbol: versionsFor('football'),
    baloncesto: versionsFor('basketball'),
    beisbol: versionsFor('baseball'),
    nfl: versionsFor('nfl'),
    nhl: versionsFor('nhl'),
    ufc: versionsFor('ufc'),
  }));

  // --- la evolución del mercado de un evento (snapshots de la fase 2) ---
  // El id es el del proveedor. La NFL lo guarda con prefijo `odds-` en su tabla, así que
  // se acepta también así.
  app.get<{ Params: { id: string }; Querystring: { market?: string } }>('/odds/history/:id', async (req) => {
    const id = req.params.id.replace(/^odds-/, '');
    const market = req.query.market ?? 'h2h';
    const obs = getDb()
      .prepare('SELECT commence_time AS c, MIN(observed_at) AS primera, MAX(observed_at) AS ultima, COUNT(*) AS n FROM odds_event_observations WHERE event_id = ?')
      .get(id) as { c: string | null; primera: string | null; ultima: string | null; n: number };
    const selecciones = selectionsOf(id, market).map((sel) => ({
      seleccion: sel,
      evolucion: history(id, market, sel),
      apertura: openingLine(id, market, sel),
      ultima: latestLine(id, market, sel),
      cierre: obs.c && Date.parse(obs.c) <= Date.now() ? closingLine(id, market, sel, obs.c) : null,
    }));
    return {
      eventId: id,
      market,
      inicio: obs.c,
      observaciones: obs.n,
      primeraObservacion: obs.primera,
      ultimaObservacion: obs.ultima,
      selecciones,
    };
  });

  // --- los partidos que vienen, de todos los deportes, por confianza y probabilidad ---
  app.get<{ Querystring: { horas?: string } }>('/top-picks', async (req) => {
    const pedido = Number(req.query.horas);
    const horas = (HORIZONTES as readonly number[]).includes(pedido) ? pedido : HORIZONTES[1];
    return { horizontes: HORIZONTES, ...mejoresPartidos(new Date(), horas) };
  });

  // --- ¿acertó? Los partidos de los últimos días: registro en vivo + reconstruidos ---
  // `dias` solo admite las ventanas que ofrece la pantalla (7, 14, 30): reconstruir cuesta
  // ~1 s por deporte y se guarda por ventana, así que una ventana arbitraria por petición
  // sería una forma barata de tener el servidor ocupado.
  app.get<{ Querystring: { dias?: string } }>('/recent-results', async (req) => {
    const pedido = Number(req.query.dias);
    const dias = (VENTANAS as readonly number[]).includes(pedido) ? pedido : VENTANAS[0];
    return { ventanas: VENTANAS, ...historialReciente(new Date(), dias) };
  });

  // --- auditoría: línea temporal de un partido, reproducción de un id y alertas ---
  app.get<{ Params: { sport: string; key: string } }>('/timeline/:sport/:key', async (req, reply) => {
    if (!isSportId(req.params.sport)) return reply.code(400).send({ error: 'deporte desconocido' });
    return lineaTemporal(req.params.sport, req.params.key);
  });
  app.get<{ Params: { id: string } }>('/reproduce/:id', async (req) => reproducir(req.params.id));
  app.get<{ Querystring: { limit?: string } }>('/alerts', async (req) => alertas({ limit: Math.min(500, Number(req.query.limit) || 100) }));

  // --- ¿podemos confiar en el modelo? La página de transparencia ---
  app.get('/system-trust', async () => confianzaDelSistema());

  // --- modelos en sombra y ensembles registrados (no apuestan; solo se comparan) ---
  app.get('/shadows', async () => ({ sombras: informeSombras(), ensembles: leerEnsembles() }));

  // --- cuándo y por qué cambió cada modelo (experiments/model_history.json, de git) ---
  app.get('/model-history', async () => {
    try {
      return { historial: JSON.parse(fs.readFileSync(path.join(ROOT, 'experiments', 'model_history.json'), 'utf8')), nota: null };
    } catch {
      return { historial: {}, nota: 'Sin historial guardado: ejecuta npm run model:history.' };
    }
  });

  // --- el registro de experimentos, con los rechazados a la vista ---
  app.get('/experiments', async () => {
    const xs = distinctExperiments(readRegistry().experiments).map((e) => ({ ...interpretarExperimento(e), id: e.id, date: e.date, sport: e.dataset.sport, hypothesis: e.hypothesis }));
    return {
      total: xs.length,
      aceptados: xs.filter((x) => x.candidato === 'aceptado').length,
      rechazados: xs.filter((x) => x.candidato === 'rechazado').sort((a, b) => b.date.localeCompare(a.date)),
      noConcluyentes: xs.filter((x) => x.candidato === 'no concluyente').length,
    };
  });

  // --- riesgo de la cartera abierta: total, por deporte y por grupo de correlación ---
  app.get('/risk', async () => riesgoCartera(bancoActual()));

  // --- el banco de papel del modelo ---
  app.get('/paper', async () => {
    // Se liquida al leer, no solo en el ciclo de refresco: alguien que abre la app tras
    // dos días de no abrirla tiene resultados nuevos esperando, y ver «pendiente» en un
    // partido que se jugó el sábado hace dudar de todo lo demás.
    settle();
    // Sin ciclo pre-partido aquí (costaría segundos por lectura): `place()` solo apuesta
    // con una evaluación de confianza posterior a las cuotas, y esas las deja el ciclo de
    // cada 15 minutos y el que corre tras cada refresco de cuotas.
    const r = place();
    liquidarEstrategias();
    colocarEstrategias();
    return resumen(r.motivo);
  });

  // --- el asistente: pregunta en texto, respuesta desde la base ---
  //
  // POST y no GET porque la pregunta es texto libre del usuario y en una URL acabaría
  // en los logs de acceso de cualquier proxy por el que pase.
  app.post<{ Body: { pregunta?: string } }>('/ask', async (req, reply) => {
    const pregunta = String(req.body?.pregunta ?? '').slice(0, 300);
    if (!pregunta.trim()) return reply.code(400).send({ error: 'Falta la pregunta.' });

    // Las comparaciones van al agente de varios pasos, que encadena cuatro consultas y
    // no necesita ningún modelo. El resto pasa por el enrutador con modelo si hay clave,
    // y si no —o si falla— por el determinista de siempre.
    const ag = responderAgente(pregunta);
    if (ag.pasos.length > 1) {
      return { ...ag, via: 'agente', intencion: { herramienta: 'comparacion', argumentos: [] } };
    }

    const { intencion, via, nota } = await enrutarConModelo(pregunta);
    const r = ejecutar(intencion);
    return { ...r, intencion, via, nota, pasos: [{ herramienta: intencion.herramienta, argumentos: intencion.argumentos, respuesta: r }] };
  });

  // --- tours ---
  app.get('/tours', async () => {
    return toursConfig.tours.map((t) => ({
      id: t.id,
      name: t.name,
      label: t.label,
      players: (
        countRowsWhere('players', 'tour', t.id)
      ),
      matches: countRowsWhere('matches', 'tour', t.id),
    }));
  });

  // --- players (search / list within a tour) ---
  app.get<{ Params: { tour: string }; Querystring: { q?: string; limit?: string; offset?: string } }>(
    '/tours/:tour/players',
    async (req) => {
      const { tour } = req.params;
      const q = req.query.q ?? '';
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      return searchPlayers(tour, q, limit, offset);
    },
  );

  // --- player profile ---
  app.get<{ Params: { tour: string; id: string } }>('/players/:tour/:id', async (req, reply) => {
    const profile = getProfile(req.params.tour, Number(req.params.id));
    if (!profile) return reply.code(404).send({ error: 'player not found' });
    return profile;
  });

  // --- tournaments (config + dynamically discovered live events) ---
  app.get<{ Querystring: { tour?: string } }>('/tournaments', async (req) => {
    const tour = req.query.tour;
    const discovered = getUpcomingTournaments(tour);
    const byId = new Map(discovered.map((d) => [d.tournament_id, d]));

    // Configured tournaments (Slams, Masters 1000, …) enriched with live counts.
    const configured = tournamentsConfig.tournaments
      .filter((t) => !tour || t.tours.includes(tour))
      .map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        surface: t.surface,
        tours: t.tours,
        hasUpcoming: byId.has(t.id),
        upcomingCount: byId.get(t.id)?.count ?? 0,
      }));

    // Any live event NOT in the config (e.g. an ATP 500 currently in season).
    const configuredIds = new Set(tournamentsConfig.tournaments.map((t) => t.id));
    const dynamic = discovered
      .filter((d) => !configuredIds.has(d.tournament_id))
      .map((d) => ({
        id: d.tournament_id,
        name: d.tournament_name,
        category: 'other',
        surface: d.surface,
        tours: [d.tour],
        hasUpcoming: true,
        upcomingCount: d.count,
      }));

    return {
      categories: tournamentsConfig.categories,
      tournaments: [...configured, ...dynamic],
    };
  });

  // --- upcoming matches (optionally with predictions) ---
  app.get<{ Querystring: { tour?: string; tournament?: string; predictions?: string } }>(
    '/matches/upcoming',
    async (req) => proximosTenis(req.query.tour, req.query.tournament, req.query.predictions !== 'false'),
  );

  // --- head-to-head between two players ---
  app.get<{ Querystring: { tour?: string; p1?: string; p2?: string } }>('/h2h', async (req, reply) => {
    const { tour, p1, p2 } = req.query;
    if (!tour || !p1 || !p2) return reply.code(400).send({ error: 'tour, p1 and p2 required' });
    const meetings = getH2HMeetings(tour, Number(p1), Number(p2));
    return computeH2H(meetings, Number(p1), Number(p2));
  });

  // --- prediction for a single upcoming match ---
  app.get<{ Params: { id: string } }>('/predictions/:id', async (req, reply) => {
    const row = getUpcomingById(req.params.id);
    if (!row) return reply.code(404).send({ error: 'match not found' });
    // Same shape as the list endpoints: when the model can't predict, the caller
    // still gets market probabilities and player info instead of a bare error.
    return describeRow(row);
  });

  // --- predictions for all upcoming matches of a tournament (or tour) ---
  app.get<{ Querystring: { tour?: string; tournament?: string } }>('/predictions', async (req) => {
    const rows = listUpcoming({ tour: req.query.tour, tournament: req.query.tournament });
    return rows.map((row) => describeRow(row));
  });

  // --- ad-hoc prediction between any two players ---
  app.post<{
    Body: { tour: string; p1: number; p2: number; surface: string; odds1?: number; odds2?: number };
  }>('/predict', async (req, reply) => {
    const { tour, p1, p2, surface, odds1, odds2 } = req.body ?? ({} as any);
    if (!tour || !p1 || !p2 || !surface) {
      return reply.code(400).send({ error: 'tour, p1, p2 and surface are required' });
    }
    return buildPrediction(tour, Number(p1), Number(p2), surface, {
      odds1: odds1 ?? null,
      odds2: odds2 ?? null,
    });
  });
}

// Small local helper (kept here to avoid widening the repo surface).
import { findTennisResult, hasStarted } from '../results.ts';
function countRowsWhere(table: string, col: string, value: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`)
    .get(value) as unknown as { c: number };
  return row.c;
}

/**
 * Predice TODOS los próximos de este deporte (registro de predicciones e instantánea
 * pre-partido), sin que nadie tenga que abrir la pestaña. Lo llama el servidor cada 15
 * minutos: así T-24h, T-6h y T-1h tienen observación propia aunque nadie mire.
 */
export function predecirProximosTenis(): number {
  const rows = listUpcoming({});
  for (const r of rows) describeRow(r, true);
  return rows.length;
}

// All REST endpoints. Kept in one place for readability; each handler is thin
// and delegates to repo (DB reads) and model (predict).

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
import { evaluate } from '../live/engine.ts';
import { matchupServe } from '../live/serve.ts';
import { describe as describeState, type LiveState } from '../live/state.ts';
import { predictFromPoints } from '../points/predict.ts';
import { modelForServing } from '../points/repo.ts';
import type { Surface as PointsSurface } from '../points/fit.ts';
import { getTrackRecord, logPrediction } from '../trackRecord.ts';
import type { TourId, UpcomingRow } from '../types.ts';

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
  if (prediction && row.source === 'live') logPrediction(row, prediction);
  const played = findTennisResult(row.tour, row.p1_id, row.p2_id, row.commence_time);
  return {
    match: row,
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

export async function registerRoutes(app: FastifyInstance): Promise<void> {
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
    const result = await refreshOdds();
    return { ok: true, ...result };
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
    async (req) => {
      const rows = listUpcoming({ tour: req.query.tour, tournament: req.query.tournament });
      const withPred = req.query.predictions !== 'false';
      return rows.map((row) => describeRow(row, withPred));
    },
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
import { getDb } from '../db.ts';
import { findTennisResult, hasStarted } from '../results.ts';
function countRowsWhere(table: string, col: string, value: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`)
    .get(value) as unknown as { c: number };
  return row.c;
}

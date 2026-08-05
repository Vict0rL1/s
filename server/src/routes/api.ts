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
  getProfile,
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
import { getTrackRecord, logPrediction } from '../trackRecord.ts';
import type { UpcomingRow } from '../types.ts';

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
  return {
    match: row,
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
  }));

  // --- the app's own measured accuracy on real, already-played matches ---
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
function countRowsWhere(table: string, col: string, value: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`)
    .get(value) as unknown as { c: number };
  return row.c;
}

// All REST endpoints. Kept in one place for readability; each handler is thin
// and delegates to repo (DB reads) and model (predict).

import type { FastifyInstance } from 'fastify';
import { toursConfig, tournamentsConfig } from '../config.ts';
import { getMeta } from '../db.ts';
import {
  countRows,
  getProfile,
  getH2HMeetings,
  getUpcomingById,
  listUpcoming,
  searchPlayers,
} from '../repo.ts';
import { computeH2H } from '../model/h2h.ts';
import { buildPrediction, type Prediction } from '../model/predict.ts';
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
  );
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // --- meta / health ---
  app.get('/health', async () => ({ ok: true }));

  app.get('/meta', async () => ({
    dataSource: getMeta('data_source') ?? 'unknown',
    seededAt: getMeta('seeded_at'),
    updatedAt: getMeta('updated_at'),
    oddsSource: getMeta('odds_source'),
    counts: {
      players: countRows('players'),
      matches: countRows('matches'),
      ratings: countRows('player_ratings'),
      upcoming: countRows('upcoming_matches'),
    },
  }));

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

  // --- tournaments (config + which have upcoming matches; optionally per tour) ---
  app.get<{ Querystring: { tour?: string } }>('/tournaments', async (req) => {
    const upcoming = listUpcoming({ tour: req.query.tour });
    const withData = new Set(upcoming.map((u) => u.tournament_id));
    return {
      categories: tournamentsConfig.categories,
      tournaments: tournamentsConfig.tournaments.map((t) => ({
        ...t,
        hasUpcoming: withData.has(t.id),
        upcomingCount: upcoming.filter((u) => u.tournament_id === t.id).length,
      })),
    };
  });

  // --- upcoming matches (optionally with predictions) ---
  app.get<{ Querystring: { tour?: string; tournament?: string; predictions?: string } }>(
    '/matches/upcoming',
    async (req) => {
      const rows = listUpcoming({ tour: req.query.tour, tournament: req.query.tournament });
      const withPred = req.query.predictions !== 'false';
      return rows.map((row) => ({
        match: row,
        prediction: withPred ? predictRow(row) : undefined,
      }));
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
    const prediction = predictRow(row);
    if (!prediction) return reply.code(422).send({ error: 'players could not be resolved for this match' });
    return { match: row, prediction };
  });

  // --- predictions for all upcoming matches of a tournament (or tour) ---
  app.get<{ Querystring: { tour?: string; tournament?: string } }>('/predictions', async (req) => {
    const rows = listUpcoming({ tour: req.query.tour, tournament: req.query.tournament });
    return rows.map((row) => ({ match: row, prediction: predictRow(row) }));
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

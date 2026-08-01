// Football REST endpoints, mounted under /api/football.
//
// A third separate namespace. No endpoint here can return a tennis match or a
// basketball game, which is what keeps the three tabs genuinely independent.

import type { FastifyInstance } from 'fastify';
import { env, footballConfig } from '../config.ts';
import { getMeta } from '../db.ts';
import { buildFootballPrediction, type FbPrediction } from '../football/predict.ts';
import { refreshFootballOdds } from '../football/ingest/odds.ts';
import { impliedFrom1X2 } from '../football/model.ts';
import {
  countMatches,
  countTeams,
  getLeagueLatestDate,
  getLeaguesWithUpcoming,
  getPowerRanking,
  getTeamInfo,
  getUpcomingById,
  listTeams,
  listUpcoming,
} from '../football/repo.ts';
import { getFootballTrackRecord, logFootballPrediction } from '../football/trackRecord.ts';
import type { FbUpcomingRow } from '../football/types.ts';

function predictRow(row: FbUpcomingRow): FbPrediction | null {
  if (!row.home_id || !row.away_id) return null;
  return buildFootballPrediction(row.league, row.home_id, row.away_id, {
    oddsHome: row.odds_home,
    oddsDraw: row.odds_draw,
    oddsAway: row.odds_away,
  });
}

/** Market-only view for leagues with no results feed (e.g. the Champions League). */
function marketOnly(row: FbUpcomingRow) {
  if (!row.odds_home || !row.odds_draw || !row.odds_away) return null;
  const implied = impliedFrom1X2(row.odds_home, row.odds_draw, row.odds_away);
  return implied ? { ...implied, odds: { home: row.odds_home, draw: row.odds_draw, away: row.odds_away } } : null;
}

function describeRow(row: FbUpcomingRow, withPrediction = true) {
  const prediction = withPrediction ? predictRow(row) : null;
  // Only real fixtures enter the track record; demo ones are never played.
  if (prediction && row.source === 'live') logFootballPrediction(row, prediction);
  return {
    fixture: row,
    prediction,
    marketOnly: prediction ? null : marketOnly(row),
    teams: {
      home: row.home_id ? getTeamInfo(row.league, row.home_id) : null,
      away: row.away_id ? getTeamInfo(row.league, row.away_id) : null,
    },
  };
}

export async function registerFootballRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meta', async () => ({
    dataSource: getMeta('fb_data_source') ?? 'unknown',
    updatedAt: getMeta('fb_updated_at'),
    oddsSource: getMeta('fb_odds_source'),
    oddsRefreshedAt: getMeta('fb_odds_refreshed_at'),
    hasOddsKey: !!env.oddsApiKey,
    autoRefreshMinutes: env.autoRefreshMinutes,
    counts: { teams: countTeams(), matches: countMatches() },
    leagues: footballConfig.leagues.map((l) => ({
      id: l.id,
      name: l.name,
      label: l.label,
      country: l.country,
      matches: countMatches(l.id),
      teams: countTeams(l.id),
      historyThrough: getLeagueLatestDate(l.id),
      hasModel: countMatches(l.id) > 0,
      hasResultsSource: !!(l.footballData || l.footballcsv),
    })),
  }));

  app.get('/leagues', async () => {
    const upcoming = new Map(getLeaguesWithUpcoming().map((r) => [r.league, r.count]));
    return footballConfig.leagues.map((l) => ({
      id: l.id,
      name: l.name,
      label: l.label,
      country: l.country,
      tier: l.tier,
      matches: countMatches(l.id),
      teams: countTeams(l.id),
      hasUpcoming: upcoming.has(l.id),
      upcomingCount: upcoming.get(l.id) ?? 0,
      hasModel: countMatches(l.id) > 0,
    }));
  });

  app.get<{ Querystring: { league?: string; predictions?: string } }>(
    '/fixtures/upcoming',
    async (req) => {
      const rows = listUpcoming(req.query.league);
      const withPred = req.query.predictions !== 'false';
      return rows.map((r) => describeRow(r, withPred));
    },
  );

  app.get<{ Params: { id: string } }>('/fixtures/:id', async (req, reply) => {
    const row = getUpcomingById(req.params.id);
    if (!row) return reply.code(404).send({ error: 'fixture not found' });
    return describeRow(row);
  });

  app.get<{ Params: { league: string } }>('/teams/:league', async (req) => listTeams(req.params.league));

  app.get<{ Params: { league: string; id: string } }>('/teams/:league/:id', async (req, reply) => {
    const info = getTeamInfo(req.params.league, req.params.id);
    if (!info) return reply.code(404).send({ error: 'team not found' });
    return info;
  });

  app.get<{ Querystring: { league?: string; limit?: string } }>('/power', async (req) => {
    const league = req.query.league ?? 'epl';
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    return { league, teams: getPowerRanking(league, limit) };
  });

  app.post<{
    Body: {
      league: string; home: string; away: string;
      oddsHome?: number; oddsDraw?: number; oddsAway?: number; neutral?: boolean;
    };
  }>('/predict', async (req, reply) => {
    const { league, home, away, oddsHome, oddsDraw, oddsAway, neutral } = req.body ?? ({} as any);
    if (!league || !home || !away) {
      return reply.code(400).send({ error: 'league, home and away are required' });
    }
    return buildFootballPrediction(
      league, home, away,
      { oddsHome: oddsHome ?? null, oddsDraw: oddsDraw ?? null, oddsAway: oddsAway ?? null },
      { neutral: !!neutral },
    );
  });

  app.get<{ Querystring: { league?: string } }>('/track-record', async (req) =>
    getFootballTrackRecord(req.query.league),
  );

  app.post('/refresh', async (_req, reply) => {
    if (countTeams() === 0) {
      return reply
        .code(409)
        .send({ error: 'No hay datos de fútbol. Corre `npm run update-data:fb` primero.' });
    }
    return { ok: true, ...(await refreshFootballOdds()) };
  });
}

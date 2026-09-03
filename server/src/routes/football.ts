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
import { getSquad, hasSquadData, squadAvailability } from '../football/players.ts';
import { getFootballTrackRecord, logFootballPrediction } from '../football/trackRecord.ts';
import type { FbUpcomingRow } from '../football/types.ts';
import { findGameResult, hasStarted } from '../results.ts';

/** Comma-separated player ids from a query string, e.g. ?outHome=302,417 */
function idList(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function predictRow(
  row: FbUpcomingRow,
  out: { home?: string[]; away?: string[] } = {},
): FbPrediction | null {
  if (!row.home_id || !row.away_id) return null;
  return buildFootballPrediction(
    row.league,
    row.home_id,
    row.away_id,
    { oddsHome: row.odds_home, oddsDraw: row.odds_draw, oddsAway: row.odds_away },
    { outHome: out.home, outAway: out.away },
  );
}

/** Market-only view for leagues with no results feed (e.g. the Champions League). */
function marketOnly(row: FbUpcomingRow) {
  if (!row.odds_home || !row.odds_draw || !row.odds_away) return null;
  const implied = impliedFrom1X2(row.odds_home, row.odds_draw, row.odds_away);
  return implied ? { ...implied, odds: { home: row.odds_home, draw: row.odds_draw, away: row.odds_away } } : null;
}

function describeRow(
  row: FbUpcomingRow,
  withPrediction = true,
  out: { home?: string[]; away?: string[] } = {},
) {
  const prediction = withPrediction ? predictRow(row, out) : null;
  // Only real fixtures enter the track record, and only the model's OWN forecast:
  // a prediction the user reshaped by marking absences is a different question,
  // and scoring the app on it would flatter or punish it for someone else's input.
  const userAdjusted = (out.home?.length ?? 0) + (out.away?.length ?? 0) > 0;
  if (prediction && row.source === 'live' && !userAdjusted) logFootballPrediction(row, prediction);
  return {
    fixture: row,
    /**
     * The FINAL SCORE, once the game has been played and the archive has it.
     *
     * Three states, and the card needs all three: not started, started but no
     * score yet, and finished. Scores arrive with `update-data`, so the middle
     * state is normal for a while after a game ends and must not be dressed up as
     * either of the others.
     */
    outcome: {
      started: hasStarted(row.commence_time),
      result: findGameResult('football', {
        league: row.league,
        homeId: row.home_id,
        awayId: row.away_id,
        commenceTime: row.commence_time,
      }),
    },
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
    squads: {
      season: getMeta('fb_squads_season'),
      updatedAt: getMeta('fb_squads_updated_at'),
      leagues: (getMeta('fb_squads_leagues') ?? '').split(',').filter(Boolean),
    },
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

  // `outHome` / `outAway` are how the user tells the model the one thing it
  // cannot know: who is actually playing. The whole score distribution is rebuilt
  // from them, so every figure on the card moves together.
  app.get<{ Params: { id: string }; Querystring: { outHome?: string; outAway?: string } }>(
    '/fixtures/:id',
    async (req, reply) => {
      const row = getUpcomingById(req.params.id);
      if (!row) return reply.code(404).send({ error: 'fixture not found' });
      return describeRow(row, true, {
        home: idList(req.query.outHome),
        away: idList(req.query.outAway),
      });
    },
  );

  app.get<{ Params: { league: string; id: string } }>('/squad/:league/:id', async (req, reply) => {
    const { league, id } = req.params;
    if (!hasSquadData(league)) {
      return reply.code(404).send({
        error: 'no squad data',
        message:
          'Solo hay datos de plantilla para la Premier League: es la única liga con una fuente ' +
          'abierta de minutos, goles esperados y partes de lesionados.',
      });
    }
    const squad = getSquad(league, id);
    if (squad.length === 0) return reply.code(404).send({ error: 'team not found in squad data' });
    return {
      league,
      teamId: id,
      season: getMeta('fb_squads_season'),
      updatedAt: getMeta('fb_squads_updated_at'),
      players: squad,
      availability: squadAvailability(league, id),
    };
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
      outHome?: string[]; outAway?: string[];
    };
  }>('/predict', async (req, reply) => {
    const { league, home, away, oddsHome, oddsDraw, oddsAway, neutral, outHome, outAway } =
      req.body ?? ({} as any);
    if (!league || !home || !away) {
      return reply.code(400).send({ error: 'league, home and away are required' });
    }
    return buildFootballPrediction(
      league, home, away,
      { oddsHome: oddsHome ?? null, oddsDraw: oddsDraw ?? null, oddsAway: oddsAway ?? null },
      { neutral: !!neutral, outHome, outAway },
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

// American football REST endpoints, mounted under /api/nfl.
//
// A fifth separate namespace. No endpoint here can return a game from another
// sport, which is what keeps the five tabs genuinely independent.

import type { FastifyInstance } from 'fastify';
import { env, nflConfig } from '../config.ts';
import { getMeta } from '../db.ts';
import { buildPrediction, type NafPrediction } from '../nfl/predict.ts';
import { refreshOdds } from '../nfl/ingest/odds.ts';
import {
  countGames,
  countTeams,
  getLeagueLatestDate,
  getLeagueState,
  getPowerRanking,
  getTeamInfo,
  getUpcoming,
  lastOddsUpdate,
  listTeams,
  listUpcoming,
} from '../nfl/repo.ts';
import { getNflTrackRecord, logNflPrediction, resolveNflPredictions } from '../nfl/trackRecord.ts';
import { ELO_PER_POINT } from '../nfl/model.ts';
import type { NafUpcomingRow } from '../nfl/types.ts';

function predictRow(row: NafUpcomingRow): NafPrediction | null {
  if (!row.home_id || !row.away_id) return null;
  return buildPrediction({
    league: row.league,
    homeId: row.home_id,
    awayId: row.away_id,
    neutral: row.neutral === 1,
    oddsHome: row.odds_home,
    oddsAway: row.odds_away,
    spreadLine: row.spread_line,
    totalLine: row.total_line,
    season: row.season,
  });
}

/** Market-only view for leagues with no results archive (NCAA). */
function marketOnly(row: NafUpcomingRow) {
  if (!row.odds_home || !row.odds_away) return null;
  const rawH = 1 / row.odds_home;
  const rawA = 1 / row.odds_away;
  const sum = rawH + rawA;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return {
    home: rawH / sum,
    away: rawA / sum,
    overround: sum,
    odds: { home: row.odds_home, away: row.odds_away },
  };
}

function describeRow(row: NafUpcomingRow, withPrediction = true) {
  const prediction = withPrediction ? predictRow(row) : null;
  // Only real games enter the track record. A schedule row with no price is
  // still a real game — this is the one sport where the fixture list is
  // official even when no bookmaker feed is configured.
  if (prediction && row.source !== 'fixture') logNflPrediction(row, prediction);
  return {
    game: row,
    prediction,
    marketOnly: prediction ? null : marketOnly(row),
    teams: {
      home: row.home_id ? getTeamInfo(row.league, row.home_id) : null,
      away: row.away_id ? getTeamInfo(row.league, row.away_id) : null,
    },
    /** Whether a bookmaker supplied the handicap and total, or the model did. */
    linesFromMarket: row.spread_line != null,
  };
}

export async function registerNflRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meta', async () => {
    const state = getLeagueState('nfl');
    return {
      updatedAt: getMeta('naf:updatedAt'),
      oddsRefreshedAt: lastOddsUpdate('nfl'),
      hasOddsKey: !!env.oddsApiKey,
      autoRefreshMinutes: env.autoRefreshMinutes,
      counts: { teams: countTeams(), games: countGames() },
      // The two league-wide quantities this model tracks instead of assuming.
      // Surfaced because "the home edge is worth 2.1 points right now" is one of
      // the more interesting things the app knows, and it changes year to year.
      league: {
        homeAdvantageElo: Math.round(state.homeAdvantage),
        homeAdvantagePoints: Number((state.homeAdvantage / ELO_PER_POINT).toFixed(2)),
        pointsPerGame: Number(state.leagueTotal.toFixed(1)),
      },
      leagues: nflConfig.leagues.map((l) => ({
        id: l.id,
        name: l.name,
        label: l.label,
        country: l.country,
        games: countGames(l.id),
        teams: countTeams(l.id),
        historyThrough: getLeagueLatestDate(l.id),
        hasModel: countGames(l.id) > 0,
        hasResultsSource: l.nflverse,
      })),
    };
  });

  app.get('/leagues', async () => {
    const counts = new Map<string, number>();
    for (const l of nflConfig.leagues) counts.set(l.id, listUpcoming(l.id, 64).length);
    return nflConfig.leagues.map((l) => ({
      id: l.id,
      name: l.name,
      label: l.label,
      country: l.country,
      games: countGames(l.id),
      teams: countTeams(l.id),
      hasUpcoming: (counts.get(l.id) ?? 0) > 0,
      upcomingCount: counts.get(l.id) ?? 0,
      hasModel: countGames(l.id) > 0,
    }));
  });

  app.get<{ Querystring: { league?: string; predictions?: string } }>(
    '/games/upcoming',
    async (req) => {
      // Resolving first means the track record on screen is never a week stale.
      resolveNflPredictions();
      const rows = listUpcoming(req.query.league ?? 'nfl');
      const withPred = req.query.predictions !== 'false';
      return rows.map((r) => describeRow(r, withPred));
    },
  );

  app.get<{ Params: { id: string } }>('/games/:id', async (req, reply) => {
    const row = getUpcoming(req.params.id);
    if (!row) return reply.code(404).send({ error: 'game not found' });
    return describeRow(row);
  });

  app.get<{ Params: { league: string } }>('/teams/:league', async (req) =>
    listTeams(req.params.league),
  );

  app.get<{ Params: { league: string; id: string } }>('/teams/:league/:id', async (req, reply) => {
    const info = getTeamInfo(req.params.league, req.params.id);
    if (!info) return reply.code(404).send({ error: 'team not found' });
    return info;
  });

  app.get<{ Querystring: { league?: string; limit?: string } }>('/power', async (req) => {
    const league = req.query.league ?? 'nfl';
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    return { league, teams: getPowerRanking(league, limit) };
  });

  /**
   * Ad-hoc prediction.
   *
   * `spreadLine` and `totalLine` are accepted so a reader can price the model
   * against the exact numbers on their own slip — which for this sport is the
   * question people actually have.
   */
  app.post<{
    Body: {
      league: string;
      home: string;
      away: string;
      neutral?: boolean;
      oddsHome?: number;
      oddsAway?: number;
      spreadLine?: number;
      totalLine?: number;
    };
  }>('/predict', async (req, reply) => {
    const body = req.body ?? ({} as Record<string, never>);
    const { league, home, away } = body;
    if (!league || !home || !away) {
      return reply.code(400).send({ error: 'league, home and away are required' });
    }
    const prediction = buildPrediction({
      league,
      homeId: home,
      awayId: away,
      neutral: body.neutral ?? false,
      oddsHome: body.oddsHome ?? null,
      oddsAway: body.oddsAway ?? null,
      spreadLine: body.spreadLine ?? null,
      totalLine: body.totalLine ?? null,
    });
    if (!prediction) return reply.code(404).send({ error: 'team not found in this league' });
    return prediction;
  });

  app.get<{ Querystring: { league?: string } }>('/track-record', async (req) => {
    resolveNflPredictions();
    return getNflTrackRecord(req.query.league);
  });

  app.post('/refresh', async (_req, reply) => {
    if (countTeams() === 0) {
      return reply
        .code(409)
        .send({ error: 'No hay datos de fútbol americano. Corre `npm run update-data:naf` primero.' });
    }
    const stored = await refreshOdds();
    return { ok: true, stored };
  });
}

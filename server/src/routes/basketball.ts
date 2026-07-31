// Basketball REST endpoints, mounted under /api/basketball.
//
// A separate namespace from the tennis routes on purpose: nothing here can return
// a tennis match and nothing there can return a game, so the two sports cannot be
// mixed up by a client — which is the whole point of the separate tab.

import type { FastifyInstance } from 'fastify';
import { basketballConfig, env } from '../config.ts';
import { getMeta } from '../db.ts';
import { buildGamePrediction, type GamePrediction } from '../basketball/predict.ts';
import { refreshBasketballOdds } from '../basketball/ingest/odds.ts';
import {
  countGames,
  countTeams,
  getLeagueLatestDate,
  getLeaguesWithUpcoming,
  getPowerRanking,
  getTeamInfo,
  getUpcomingById,
  listTeams,
  listUpcoming,
} from '../basketball/repo.ts';
import {
  getBasketballTrackRecord,
  logGamePrediction,
} from '../basketball/trackRecord.ts';
import type { UpcomingGameRow } from '../basketball/types.ts';

/** Attach a prediction to an upcoming game (null when a team is unknown). */
function predictRow(row: UpcomingGameRow): GamePrediction | null {
  if (!row.home_id || !row.away_id) return null;
  return buildGamePrediction(
    row.league,
    row.home_id,
    row.away_id,
    { homeOdds: row.home_odds, awayOdds: row.away_odds },
    // Rest is measured to the game's own date, so a team playing tonight after
    // playing yesterday is correctly flagged as a back-to-back.
    { gameDate: row.commence_time ? row.commence_time.slice(0, 10).replace(/-/g, '') : null },
  );
}

/**
 * Market-implied probabilities for games the model can't predict — a league with
 * no results feed (EuroLeague, NBL) still shows real fixtures and real prices,
 * clearly labelled as the market rather than the model.
 */
function marketOnly(row: UpcomingGameRow) {
  if (row.home_odds == null || row.away_odds == null) return null;
  const rawH = 1 / row.home_odds;
  const rawA = 1 / row.away_odds;
  const overround = rawH + rawA;
  return {
    odds1: row.home_odds,
    odds2: row.away_odds,
    implied1: Math.round((rawH / overround) * 100000) / 100000,
    implied2: Math.round((rawA / overround) * 100000) / 100000,
    overround: Math.round(overround * 100000) / 100000,
  };
}

function describeRow(row: UpcomingGameRow, withPrediction = true) {
  const prediction = withPrediction ? predictRow(row) : null;
  // Only real fixtures go into the track record: demo games are never played, so
  // scoring the app against them would be meaningless.
  if (prediction && row.source === 'live') logGamePrediction(row, prediction);
  return {
    game: row,
    prediction,
    marketOnly: prediction ? null : marketOnly(row),
    teams: {
      home: row.home_id ? getTeamInfo(row.league, row.home_id) : null,
      away: row.away_id ? getTeamInfo(row.league, row.away_id) : null,
    },
  };
}

export async function registerBasketballRoutes(app: FastifyInstance): Promise<void> {
  // --- meta: what data is loaded, and how fresh it is ---
  app.get('/meta', async () => {
    const perLeague = basketballConfig.leagues.map((l) => {
      const through = getLeagueLatestDate(l.id);
      return {
        id: l.id,
        name: l.name,
        label: l.label,
        games: countGames(l.id),
        teams: countTeams(l.id),
        historyThrough: through,
        /** False when the league has no results feed: market only, no Elo. */
        hasModel: !!l.espn && countGames(l.id) > 0,
        hasResultsSource: !!l.espn,
      };
    });
    return {
      dataSource: getMeta('bb_data_source') ?? 'unknown',
      updatedAt: getMeta('bb_updated_at'),
      oddsSource: getMeta('bb_odds_source'),
      oddsRefreshedAt: getMeta('bb_odds_refreshed_at'),
      hasOddsKey: !!env.oddsApiKey,
      autoRefreshMinutes: env.autoRefreshMinutes,
      counts: { teams: countTeams(), games: countGames() },
      leagues: perLeague,
    };
  });

  // --- leagues, with which ones actually have games to show right now ---
  app.get('/leagues', async () => {
    const upcoming = new Map(getLeaguesWithUpcoming().map((r) => [r.league, r.count]));
    return basketballConfig.leagues.map((l) => ({
      id: l.id,
      name: l.name,
      label: l.label,
      country: l.country,
      games: countGames(l.id),
      teams: countTeams(l.id),
      hasUpcoming: upcoming.has(l.id),
      upcomingCount: upcoming.get(l.id) ?? 0,
      hasModel: !!l.espn && countGames(l.id) > 0,
    }));
  });

  // --- upcoming games with predictions ---
  app.get<{ Querystring: { league?: string; predictions?: string } }>(
    '/games/upcoming',
    async (req) => {
      const rows = listUpcoming(req.query.league);
      const withPred = req.query.predictions !== 'false';
      return rows.map((r) => describeRow(r, withPred));
    },
  );

  // --- one game ---
  app.get<{ Params: { id: string } }>('/games/:id', async (req, reply) => {
    const row = getUpcomingById(req.params.id);
    if (!row) return reply.code(404).send({ error: 'game not found' });
    return describeRow(row);
  });

  // --- teams ---
  app.get<{ Params: { league: string } }>('/teams/:league', async (req) => {
    return listTeams(req.params.league);
  });

  app.get<{ Params: { league: string; id: string } }>('/teams/:league/:id', async (req, reply) => {
    const info = getTeamInfo(req.params.league, req.params.id);
    if (!info) return reply.code(404).send({ error: 'team not found' });
    return info;
  });

  // --- Elo power ranking (the "all teams" view) ---
  app.get<{ Querystring: { league?: string; limit?: string } }>('/power', async (req) => {
    const league = req.query.league ?? 'nba';
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    return { league, teams: getPowerRanking(league, limit) };
  });

  // --- ad-hoc prediction between any two teams ---
  app.post<{
    Body: {
      league: string;
      home: string;
      away: string;
      homeOdds?: number;
      awayOdds?: number;
      neutral?: boolean;
    };
  }>('/predict', async (req, reply) => {
    const { league, home, away, homeOdds, awayOdds, neutral } = req.body ?? ({} as any);
    if (!league || !home || !away) {
      return reply.code(400).send({ error: 'league, home and away are required' });
    }
    return buildGamePrediction(
      league,
      home,
      away,
      { homeOdds: homeOdds ?? null, awayOdds: awayOdds ?? null },
      { neutral: !!neutral },
    );
  });

  // --- the app's measured accuracy on basketball games already played ---
  app.get<{ Querystring: { league?: string } }>('/track-record', async (req) => {
    return getBasketballTrackRecord(req.query.league);
  });

  // --- manual odds refresh ---
  app.post('/refresh', async (_req, reply) => {
    if (countTeams() === 0) {
      return reply
        .code(409)
        .send({ error: 'No hay datos de baloncesto. Corre `npm run update-data:bb` primero.' });
    }
    const result = await refreshBasketballOdds();
    return { ok: true, ...result };
  });
}

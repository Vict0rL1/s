// Baseball REST endpoints, mounted under /api/baseball.
//
// A fourth separate namespace. No endpoint here can return a football match, a
// basketball game or a tennis match, which is what keeps the four tabs genuinely
// independent of one another.

import type { FastifyInstance } from 'fastify';
import { env, baseballConfig } from '../config.ts';
import { getMeta } from '../db.ts';
import { buildBaseballPrediction, type BsbPrediction } from '../baseball/predict.ts';
import { refreshBaseballOdds } from '../baseball/ingest/odds.ts';
import { impliedFromMoneyline } from '../baseball/model.ts';
import {
  countGames,
  countTeams,
  getLeagueLatestDate,
  getLeaguesWithUpcoming,
  getPitcher,
  getPowerRanking,
  getRotation,
  getTeamInfo,
  getUpcomingById,
  listTeams,
  listUpcoming,
} from '../baseball/repo.ts';
import { getBaseballTrackRecord, logBaseballPrediction } from '../baseball/trackRecord.ts';
import type { BsbUpcomingRow } from '../baseball/types.ts';
import { findGameResult, hasStarted } from '../results.ts';

function predictRow(
  row: BsbUpcomingRow,
  starters: { home?: string | null; away?: string | null } = {},
): BsbPrediction | null {
  if (!row.home_id || !row.away_id) return null;
  return buildBaseballPrediction(
    row.league,
    row.home_id,
    row.away_id,
    { oddsHome: row.odds_home, oddsAway: row.odds_away },
    {
      homeStarter: starters.home ?? row.home_sp,
      awayStarter: starters.away ?? row.away_sp,
    },
  );
}

/** Market-only view for leagues with no results archive (NPB, KBO, NCAA). */
function marketOnly(row: BsbUpcomingRow) {
  if (!row.odds_home || !row.odds_away) return null;
  const implied = impliedFromMoneyline(row.odds_home, row.odds_away);
  return implied ? { ...implied, odds: { home: row.odds_home, away: row.odds_away } } : null;
}

function describeRow(
  row: BsbUpcomingRow,
  withPrediction = true,
  starters: { home?: string | null; away?: string | null } = {},
) {
  const prediction = withPrediction ? predictRow(row, starters) : null;
  // Only real games enter the track record, and only the model's OWN call: a
  // prediction the user reshaped by naming a different starter is a different
  // question, and scoring the app on it would measure someone else's input.
  const userChose = starters.home !== undefined || starters.away !== undefined;
  if (prediction && row.source === 'live' && !userChose) logBaseballPrediction(row, prediction);
  return {
    game: row,
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
      result: findGameResult('baseball', {
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
    /** Whether the starters came from a probables feed or were guessed. */
    startersAnnounced: !!(row.home_sp && row.away_sp),
  };
}

export async function registerBaseballRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meta', async () => ({
    dataSource: getMeta('bsb_data_source') ?? 'unknown',
    updatedAt: getMeta('bsb_updated_at'),
    oddsSource: getMeta('bsb_odds_source'),
    oddsRefreshedAt: getMeta('bsb_odds_refreshed_at'),
    probables: Number(getMeta('bsb_probables') ?? 0),
    hasOddsKey: !!env.oddsApiKey,
    autoRefreshMinutes: env.autoRefreshMinutes,
    counts: { teams: countTeams(), games: countGames() },
    leagues: baseballConfig.leagues.map((l) => ({
      id: l.id,
      name: l.name,
      label: l.label,
      country: l.country,
      games: countGames(l.id),
      teams: countTeams(l.id),
      historyThrough: getLeagueLatestDate(l.id),
      hasModel: countGames(l.id) > 0,
      hasResultsSource: l.retrosheet,
    })),
  }));

  app.get('/leagues', async () => {
    const upcoming = new Map(getLeaguesWithUpcoming().map((r) => [r.league, r.count]));
    return baseballConfig.leagues.map((l) => ({
      id: l.id,
      name: l.name,
      label: l.label,
      country: l.country,
      games: countGames(l.id),
      teams: countTeams(l.id),
      hasUpcoming: upcoming.has(l.id),
      upcomingCount: upcoming.get(l.id) ?? 0,
      hasModel: countGames(l.id) > 0,
    }));
  });

  app.get<{ Querystring: { league?: string; predictions?: string } }>(
    '/games/upcoming',
    async (req) => {
      const rows = listUpcoming(req.query.league);
      const withPred = req.query.predictions !== 'false';
      return rows.map((r) => describeRow(r, withPred));
    },
  );

  // `homeStarter` / `awayStarter` let the user name the starting pitchers when
  // the probables feed has not (or has changed its mind). In baseball that is the
  // single most valuable thing a person can tell the model.
  app.get<{ Params: { id: string }; Querystring: { homeStarter?: string; awayStarter?: string } }>(
    '/games/:id',
    async (req, reply) => {
      const row = getUpcomingById(req.params.id);
      if (!row) return reply.code(404).send({ error: 'game not found' });
      const starters: { home?: string | null; away?: string | null } = {};
      if (req.query.homeStarter !== undefined) starters.home = req.query.homeStarter || null;
      if (req.query.awayStarter !== undefined) starters.away = req.query.awayStarter || null;
      return describeRow(row, true, starters);
    },
  );

  app.get<{ Params: { league: string } }>('/teams/:league', async (req) =>
    listTeams(req.params.league),
  );

  app.get<{ Params: { league: string; id: string } }>('/teams/:league/:id', async (req, reply) => {
    const info = getTeamInfo(req.params.league, req.params.id);
    if (!info) return reply.code(404).send({ error: 'team not found' });
    return info;
  });

  /** A team's rotation — the choices offered when picking a starter by hand. */
  app.get<{ Params: { league: string; id: string } }>(
    '/rotation/:league/:id',
    async (req, reply) => {
      const rotation = getRotation(req.params.league, req.params.id, 12);
      if (rotation.length === 0) {
        return reply.code(404).send({
          error: 'no pitcher data',
          message:
            'Solo hay datos de lanzadores para la MLB: es la única liga con un archivo abierto ' +
            'partido a partido que incluya al abridor.',
        });
      }
      return { league: req.params.league, teamId: req.params.id, pitchers: rotation };
    },
  );

  app.get<{ Params: { league: string; id: string } }>(
    '/pitchers/:league/:id',
    async (req, reply) => {
      const p = getPitcher(req.params.league, req.params.id);
      if (!p) return reply.code(404).send({ error: 'pitcher not found' });
      return p;
    },
  );

  app.get<{ Querystring: { league?: string; limit?: string } }>('/power', async (req) => {
    const league = req.query.league ?? 'mlb';
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    return { league, teams: getPowerRanking(league, limit) };
  });

  app.post<{
    Body: {
      league: string; home: string; away: string;
      oddsHome?: number; oddsAway?: number;
      homeStarter?: string; awayStarter?: string; totalLine?: number;
    };
  }>('/predict', async (req, reply) => {
    const { league, home, away, oddsHome, oddsAway, homeStarter, awayStarter, totalLine } =
      req.body ?? ({} as any);
    if (!league || !home || !away) {
      return reply.code(400).send({ error: 'league, home and away are required' });
    }
    return buildBaseballPrediction(
      league, home, away,
      { oddsHome: oddsHome ?? null, oddsAway: oddsAway ?? null },
      { homeStarter, awayStarter, totalLine },
    );
  });

  app.get<{ Querystring: { league?: string } }>('/track-record', async (req) =>
    getBaseballTrackRecord(req.query.league),
  );

  app.post('/refresh', async (_req, reply) => {
    if (countTeams() === 0) {
      return reply
        .code(409)
        .send({ error: 'No hay datos de béisbol. Corre `npm run update-data:bsb` primero.' });
    }
    return { ok: true, ...(await refreshBaseballOdds()) };
  });
}

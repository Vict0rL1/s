// REST API bootstrap (Fastify).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config.ts';
import { getDb } from './db.ts';
import { countRows } from './repo.ts';
import { refreshOdds } from './ingest/odds.ts';
import { refreshBasketballOdds } from './basketball/ingest/odds.ts';
import { refreshFootballOdds } from './football/ingest/odds.ts';
import { registerRoutes } from './routes/api.ts';
import { registerBasketballRoutes } from './routes/basketball.ts';
import { registerFootballRoutes } from './routes/football.ts';
import { resolvePredictions } from './trackRecord.ts';
import { resolveGamePredictions } from './basketball/trackRecord.ts';
import { resolveFootballPredictions } from './football/trackRecord.ts';

/**
 * Keep odds current on their own: refresh once at startup and then on an
 * interval. Only runs when an ODDS_API_KEY is configured (otherwise there is
 * nothing live to fetch and the demo fixtures are static).
 */
function startAutoRefresh(log: (msg: string) => void): void {
  if (!env.oddsApiKey) {
    log('Auto-refresh disabled (set ODDS_API_KEY to fetch live odds automatically).');
    return;
  }
  if (env.autoRefreshMinutes <= 0) {
    log('Auto-refresh disabled (AUTO_REFRESH_MINUTES=0).');
    return;
  }
  const run = async () => {
    if (countRows('players') > 0) {
      try {
        const r = await refreshOdds();
        log(`Tennis odds refreshed: ${r.count} upcoming matches (${r.source}).`);
      } catch (e) {
        log(`Tennis odds refresh failed: ${(e as Error).message}`);
      }
    }
    // Basketball refreshes independently: one sport failing must not stop the
    // other from updating.
    if (countRows('bb_teams') > 0) {
      try {
        const r = await refreshBasketballOdds();
        log(`Basketball odds refreshed: ${r.count} games (${r.source}).`);
      } catch (e) {
        log(`Basketball odds refresh failed: ${(e as Error).message}`);
      }
    }
    if (countRows('fb_teams') > 0) {
      try {
        const r = await refreshFootballOdds();
        log(`Football odds refreshed: ${r.count} fixtures (${r.source}).`);
      } catch (e) {
        log(`Football odds refresh failed: ${(e as Error).message}`);
      }
    }
  };
  void run(); // once at startup
  setInterval(run, env.autoRefreshMinutes * 60_000).unref();
  log(`Auto-refresh every ${env.autoRefreshMinutes} min.`);
}

async function main() {
  getDb(); // open + create schema up front

  // Catch up on any prediction whose result arrived while the server was down
  // (history is normally ingested by a separate `update-data` process).
  try {
    resolvePredictions();
    resolveGamePredictions();
    resolveFootballPredictions();
  } catch {
    // Never block startup over the track record.
  }

  const app = Fastify({ logger: { level: 'info', transport: undefined } });
  await app.register(cors, { origin: true });
  await app.register(registerRoutes, { prefix: '/api' });
  // Basketball lives in its own namespace: no endpoint can return both sports.
  await app.register(registerBasketballRoutes, { prefix: '/api/basketball' });
  await app.register(registerFootballRoutes, { prefix: '/api/football' });

  app.get('/', async () => ({
    name: 'tennis-predictor API',
    docs:
      'Tenis: /api/health, /api/tours, /api/matches/upcoming, /api/predictions/:id · ' +
      'Baloncesto: /api/basketball/leagues, /api/basketball/games/upcoming · ' +
      'Fútbol: /api/football/leagues, /api/football/fixtures/upcoming, /api/football/power',
  }));

  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    app.log.info(`Tennis Predictor API listening on http://localhost:${env.port}`);
    startAutoRefresh((msg) => app.log.info(msg));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

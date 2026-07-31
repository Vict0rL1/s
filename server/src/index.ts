// REST API bootstrap (Fastify).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config.ts';
import { getDb } from './db.ts';
import { countRows } from './repo.ts';
import { refreshOdds } from './ingest/odds.ts';
import { registerRoutes } from './routes/api.ts';
import { resolvePredictions } from './trackRecord.ts';

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
    if (countRows('players') === 0) return; // nothing to attach odds to yet
    try {
      const r = await refreshOdds();
      log(`Odds refreshed: ${r.count} upcoming matches (${r.source}).`);
    } catch (e) {
      log(`Odds refresh failed: ${(e as Error).message}`);
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
  } catch {
    // Never block startup over the track record.
  }

  const app = Fastify({ logger: { level: 'info', transport: undefined } });
  await app.register(cors, { origin: true });
  await app.register(registerRoutes, { prefix: '/api' });

  app.get('/', async () => ({
    name: 'tennis-predictor API',
    docs: 'See /api/health, /api/tours, /api/matches/upcoming, /api/predictions/:id',
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

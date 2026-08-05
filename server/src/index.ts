// REST API bootstrap (Fastify).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config.ts';
import { getDb } from './db.ts';
import { countRows } from './repo.ts';
import { refreshOdds } from './ingest/odds.ts';
import { refreshBasketballOdds } from './basketball/ingest/odds.ts';
import { refreshFootballOdds } from './football/ingest/odds.ts';
import { refreshBaseballOdds } from './baseball/ingest/odds.ts';
import { refreshOdds as refreshNflOdds } from './nfl/ingest/odds.ts';
import { getQuota, planTotal, recommendedRefreshMinutes, recordCycleSpend } from './oddsQuota.ts';
import { registerRoutes } from './routes/api.ts';
import { registerBasketballRoutes } from './routes/basketball.ts';
import { registerFootballRoutes } from './routes/football.ts';
import { registerBaseballRoutes } from './routes/baseball.ts';
import { registerNflRoutes } from './routes/nfl.ts';
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
  // The interval is a live value, not a constant: every cycle measures what it
  // spent and the next one is scheduled from the plan's budget. A fixed number
  // would be wrong the day a plan changes or six football leagues come back into
  // season, and neither of those is something anyone should have to remember.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentMinutes = env.autoRefreshMinutes;

  const run = async () => {
    const before = getQuota().used;
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
    // Baseball and American football were missing from this loop, so their odds
    // only ever updated when someone pressed the button. Adding them is safe now
    // that an out-of-season league costs nothing: the free /sports listing
    // decides, and in February neither MLB nor the NFL spends a credit.
    if (countRows('bsb_teams') > 0) {
      try {
        const r = await refreshBaseballOdds();
        log(`Baseball odds refreshed: ${r.count} games (${r.source}).`);
      } catch (e) {
        log(`Baseball odds refresh failed: ${(e as Error).message}`);
      }
    }
    if (countRows('naf_teams') > 0) {
      try {
        const n = await refreshNflOdds();
        log(`NFL odds refreshed: ${n} games.`);
      } catch (e) {
        log(`NFL odds refresh failed: ${(e as Error).message}`);
      }
    }
    // Say where the quota stands after every cycle. The whole reason the free
    // plan ran out was that nothing ever mentioned it until it was gone.
    const q = getQuota();
    if (q.remaining != null) {
      const plan = planTotal();
      log(
        `The Odds API: quedan ${q.remaining} peticiones (usadas ${q.used ?? '?'}` +
          `${plan != null ? ` de ${plan}` : ''}).`,
      );
    }

    // What did this cycle cost? The difference in the API's own `used` counter,
    // which is authoritative in a way that adding up our intentions is not.
    if (before != null && q.used != null && q.used > before) {
      recordCycleSpend(q.used - before);
    }
    schedule();
  };

  const schedule = () => {
    // An explicit AUTO_REFRESH_MINUTES always wins: someone who set it meant it.
    const suggested = env.autoRefreshMinutesExplicit ? null : recommendedRefreshMinutes();
    const next = suggested ?? env.autoRefreshMinutes;
    if (next !== currentMinutes) {
      log(`Auto-refresh: ${currentMinutes} → ${next} min (ajustado al plan de The Odds API).`);
      currentMinutes = next;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, currentMinutes * 60_000);
    timer.unref?.();
  };

  void run(); // once at startup; `run` schedules the next one itself
  if (env.autoRefreshMinutesExplicit) {
    // Worth saying out loud. Anyone who copied the old .env.example has
    // AUTO_REFRESH_MINUTES=720 sitting in their file, and would otherwise upgrade
    // their plan, see nothing change, and have no way to know why.
    log(
      `Auto-refresh every ${env.autoRefreshMinutes} min (fijado por AUTO_REFRESH_MINUTES; ` +
        'el ajuste automático al tamaño del plan está desactivado — quita esa línea del .env para activarlo).',
    );
  } else {
    log(`Auto-refresh every ${env.autoRefreshMinutes} min de salida; se ajustará al plan tras el primer ciclo.`);
  }
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
  await app.register(registerBaseballRoutes, { prefix: '/api/baseball' });
  await app.register(registerNflRoutes, { prefix: '/api/nfl' });

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

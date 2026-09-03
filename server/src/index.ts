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
import { registerBetRoutes } from './routes/bets.ts';
import { resolvePredictions } from './trackRecord.ts';
import { resolveGamePredictions } from './basketball/trackRecord.ts';
import { resolveFootballPredictions } from './football/trackRecord.ts';
import { resolveBaseballPredictions } from './baseball/trackRecord.ts';
import { resolveNflPredictions } from './nfl/trackRecord.ts';

/**
 * Keep the schedule current on its own: refresh once at startup and then on an
 * interval.
 *
 * IT RUNS WITHOUT AN API KEY TOO, and that is the fix to a bug rather than a
 * nicety. This used to return early with "the demo fixtures are static", which is
 * false: `demoKickoffs` builds its times RELATIVE TO NOW, so a slate generated on
 * Sunday is entirely in the past by Tuesday. With no key and no auto-refresh, the
 * demo slate was written once by `update-data` and never again — every tab went
 * empty after a day and stayed empty until the reader happened to press
 * "Actualizar". Measured: 60 football rows in the table, all from three days
 * earlier, and the app showing none of them.
 *
 * Refreshing without a key costs nothing. Every sport's refresh checks
 * `env.oddsApiKey` before it reaches for the network and otherwise goes straight to
 * its fixture generator, so these cycles make zero HTTP requests and spend zero
 * quota. The interval logic below measures spend per cycle and finds zero, which is
 * the correct answer.
 */
function startAutoRefresh(log: (msg: string) => void): void {
  if (!env.oddsApiKey) {
    log('Sin ODDS_API_KEY: se refrescará solo el calendario de demostración (no gasta cuota).');
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

/**
 * Score every prediction whose result has since arrived, for all five sports.
 *
 * TWO BUGS THIS FIXES, and they had the same shape as each other.
 *
 * 1. BASEBALL AND THE NFL WERE NEVER SCORED. Both have a working resolver and
 *    neither was called, so both logged predictions forever and resolved none —
 *    their track-record panels were permanently stuck on "esperando resultado".
 *    They were the last two sports added and they got left out of this loop the
 *    same way they were left out of the odds auto-refresh.
 *
 * 2. IT ONLY EVER RAN AT STARTUP. A game finishing while the server was up was
 *    not scored until someone restarted it, which on a machine left running is
 *    never. Now it runs on a timer too.
 *
 * Each sport is wrapped on its own: a resolver throwing must not stop the other
 * four, which is exactly how one missing sport could have hidden the others.
 */
function resolveAllPredictions(log?: (msg: string) => void): void {
  const jobs: [string, () => { resolved: number }][] = [
    ['tennis', resolvePredictions],
    ['basketball', resolveGamePredictions],
    ['football', resolveFootballPredictions],
    ['baseball', resolveBaseballPredictions],
    ['nfl', resolveNflPredictions],
  ];
  const done: string[] = [];
  for (const [name, run] of jobs) {
    try {
      const r = run();
      if (r?.resolved > 0) done.push(`${name} ${r.resolved}`);
    } catch (e) {
      log?.(`Track record (${name}) failed: ${(e as Error).message}`);
    }
  }
  if (done.length && log) log(`Predicciones puntuadas: ${done.join(' · ')}.`);
}

/** How often to look for results. Cheap: local queries, no network, no quota. */
const RESOLVE_EVERY_MINUTES = 30;

async function main() {
  getDb(); // open + create schema up front


  const app = Fastify({ logger: { level: 'info', transport: undefined } });
  await app.register(cors, { origin: true });
  await app.register(registerRoutes, { prefix: '/api' });
  // Basketball lives in its own namespace: no endpoint can return both sports.
  await app.register(registerBasketballRoutes, { prefix: '/api/basketball' });
  await app.register(registerFootballRoutes, { prefix: '/api/football' });
  await app.register(registerBaseballRoutes, { prefix: '/api/baseball' });
  await app.register(registerNflRoutes, { prefix: '/api/nfl' });
  // The bet log is not a sixth sport: it records what the person staked, not what
  // any model claimed, so it gets its own namespace rather than living under one.
  await app.register(registerBetRoutes, { prefix: '/api/bets' });

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

    // Catch up on results that arrived while the server was down, then keep
    // looking. Local queries only — no network, no quota — so a short interval
    // costs nothing and means a finished game shows up in the track record
    // within half an hour instead of at the next restart.
    const resolveLog = (msg: string) => app.log.info(msg);
    resolveAllPredictions(resolveLog);
    setInterval(() => resolveAllPredictions(resolveLog), RESOLVE_EVERY_MINUTES * 60_000).unref();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

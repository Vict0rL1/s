// REST API bootstrap (Fastify).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env, ROOT } from './config.ts';
import path from 'node:path';
import { readOddsReason, type SportPrefix } from './oddsReason.ts';
import { inspectEnvFile } from './envFile.ts';
import { getDb } from './db.ts';
import { countRows } from './repo.ts';
import { refreshOdds } from './ingest/odds.ts';
import { refreshBasketballOdds } from './basketball/ingest/odds.ts';
import { refreshFootballOdds } from './football/ingest/odds.ts';
import { refreshBaseballOdds } from './baseball/ingest/odds.ts';
import { refreshOdds as refreshNflOdds } from './nfl/ingest/odds.ts';
import {
  getQuota,
  lastCycleCredits,
  planTotal,
  recommendedRefreshMinutes,
  recordCycleSpend,
} from './oddsQuota.ts';
import { registerRoutes } from './routes/api.ts';
import { assertAuthConfigured, registerAuth, isProduction } from './auth.ts';
import { registerStatic, webBuildExists, WEB_DIST } from './static.ts';
import { registerBasketballRoutes } from './routes/basketball.ts';
import { registerFootballRoutes } from './routes/football.ts';
import { registerBaseballRoutes } from './routes/baseball.ts';
import { registerNflRoutes } from './routes/nfl.ts';
import { registerBetRoutes } from './routes/bets.ts';
import { registerLatencyRoutes } from './routes/latency.ts';
import { registerStakingRoutes } from './routes/staking.ts';
import { recordLatency } from './latency/record.ts';
import { checkLatency, publish } from './latency/alert.ts';
import { allocate } from './latency/schedule.ts';
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
const ENV_PATH = path.join(ROOT, '.env');

// ===========================================================================
// EL AVISO DE ARRANQUE: «TUS CUOTAS SON DE DEMOSTRACIÓN Y ESTO ES LO QUE SE ESCRIBE»
// ===========================================================================
// El ciclo de arriba ya decía, deporte a deporte, `Tennis odds refreshed: 27 upcoming
// matches (fixture)`. Esa palabra —`fixture`— ES el aviso, y no lo parece: está en
// inglés, en medio de un muro de JSON de pino, y no dice ni que sea un problema ni qué
// hacer. Alguien puede arrancar la app veinte veces, ver esa línea las veinte, y seguir
// preguntándose por qué salen partidos de demostración. Pasó exactamente así.
//
// `npm run go` sí lo dice, pero no todo el mundo arranca con `npm run go`: `npm run dev`
// es igual de legítimo y es lo que sale en media documentación. Así que el aviso tiene
// que estar donde arranca el servidor, no en un envoltorio que puede no usarse.
//
// Solo en el PRIMER ciclo. Repetirlo cada doce horas lo convertiría en ruido, y el ruido
// se deja de leer — que es el estado del que este aviso intenta sacar a alguien.
function avisoDeCuotas(estado: { nombre: string; vivo: boolean; prefijo: SportPrefix }[]): void {
  const demo = estado.filter((s) => !s.vivo);
  if (demo.length === 0) return;

  const L: string[] = [];
  L.push('');
  L.push('  ┌──────────────────────────────────────────────────────────────────────┐');
  L.push('  │  LAS CUOTAS SON DE DEMOSTRACIÓN                                      │');
  L.push('  └──────────────────────────────────────────────────────────────────────┘');
  const vivos = estado.filter((s) => s.vivo);
  if (vivos.length > 0) {
    L.push(`  Con cuotas REALES: ${vivos.map((s) => s.nombre).join(', ')}.`);
  }

  // Agrupadas por causa, porque cada una se arregla de una forma distinta y cinco
  // líneas iguales no se leen.
  const porCausa = new Map<string, string[]>();
  for (const s of demo) {
    const { reason } = readOddsReason(s.prefijo);
    const k = reason ?? 'sin_causa';
    porCausa.set(k, [...(porCausa.get(k) ?? []), s.nombre]);
  }
  for (const [causa, nombres] of porCausa) {
    L.push('');
    L.push(`  ${nombres.join(', ')}`);
    switch (causa) {
      case 'sin_clave': {
        // El caso de lejos más común, y el que más vueltas ha costado. Se dice la ruta
        // COMPLETA del fichero: «ponla en el .env» manda a crear un fichero que no se ve
        // en el Finder, y en la carpeta equivocada no lo lee nadie.
        //
        // Y antes de mandar a ESCRIBIR la clave, se mira si ya está escrita y solo está
        // mal puesta. «Falta la clave» es verdad y es inútil cuando la clave está en el
        // fichero sin el `ODDS_API_KEY=` delante: manda a poner algo que ya está puesto.
        const pegas = inspectEnvFile(ENV_PATH);
        if (pegas.length > 0) {
          for (const p of pegas) {
            L.push(`    ${p.titulo}`);
            for (const d of p.detalle.split('\n')) L.push(`      ${d}`);
            if (p.arreglo) {
              L.push('    Se arregla con esto, sin tener que volver a escribir la clave:');
              L.push(`      ${p.arreglo}`);
            }
          }
          L.push('    Y después:   npm run odds');
          break;
        }
        L.push('    Falta ODDS_API_KEY. Tiene que estar en el .env de la RAÍZ del proyecto:');
        L.push(`      ${ENV_PATH}`);
        L.push('    Con una línea así dentro:   ODDS_API_KEY=tu-clave');
        L.push('    OJO con `>` y `>>`: `>` BORRA el fichero y escribe encima, `>>` añade.');
        L.push('    Y después, en otra terminal y dentro de la carpeta:   npm run odds');
        break;
      }
      case 'fuente_falla':
        L.push('    El proveedor no contestó: cuota del mes agotada, clave inválida o sin red.');
        L.push('    Poner la clave otra vez NO lo arregla.  npm run doctor  lo desglosa gratis.');
        break;
      case 'sin_ligas':
        L.push('    El proveedor no ofrece ninguna de las ligas configuradas ahora mismo.');
        L.push('    Fuera de temporada es lo normal y no hay nada que arreglar.');
        break;
      case 'sin_eventos':
        L.push('    Ninguna casa tiene precio publicado todavía. Entre jornadas es lo normal:');
        L.push('    no hay nada que arreglar, aparecerán solas.');
        break;
      default:
        L.push('    Sin causa registrada.  npm run doctor  lo desglosa sin gastar cuota.');
    }
  }

  // ¿Hay clave puesta pero la causa dice que faltaba? Entonces lo guardado se bajó ANTES
  // de ponerla, y ningún reinicio lo arregla porque el reinicio no vuelve a pedirlas...
  // salvo que este mismo ciclo acabe de hacerlo. Si sigue en `sin_clave` con clave
  // puesta, es que este proceso arrancó sin leerla: casi siempre, un .env en la carpeta
  // equivocada.
  if (env.oddsApiKey && [...porCausa.keys()].includes('sin_clave')) {
    L.push('');
    L.push('  OJO: hay una ODDS_API_KEY cargada en este proceso y aun así la causa dice que');
    L.push('  faltaba. Eso significa que lo guardado se bajó antes de ponerla. Arréglalo con:');
    L.push('      npm run odds');
  }
  L.push('');
  // process.stdout, no el logger: el logger escribe JSON de una línea y esto tiene que
  // poder leerse de un vistazo entre cien líneas de JSON.
  process.stdout.write(L.join('\n') + '\n');
}

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
  let primerCiclo = true;

  const run = async () => {
    const before = getQuota().used;
    // Qué consiguió cada deporte en ESTE ciclo, para el aviso de abajo. Se recoge aquí y
    // no se deduce de la base: un deporte cuya tabla está vacía no entra en el aviso, y
    // desde fuera «vacía» y «en demostración» se parecen demasiado.
    const estado: { nombre: string; vivo: boolean; prefijo: SportPrefix }[] = [];
    if (countRows('players') > 0) {
      try {
        const r = await refreshOdds();
        log(`Tennis odds refreshed: ${r.count} upcoming matches (${r.source}).`);
        estado.push({ nombre: 'Tenis', vivo: r.source === 'live', prefijo: '' });
      } catch (e) {
        log(`Tennis odds refresh failed: ${(e as Error).message}`);
        estado.push({ nombre: 'Tenis', vivo: false, prefijo: '' });
      }
    }
    // Basketball refreshes independently: one sport failing must not stop the
    // other from updating.
    if (countRows('bb_teams') > 0) {
      try {
        const r = await refreshBasketballOdds();
        log(`Basketball odds refreshed: ${r.count} games (${r.source}).`);
        estado.push({ nombre: 'Baloncesto', vivo: r.source === 'live', prefijo: 'bb_' });
      } catch (e) {
        log(`Basketball odds refresh failed: ${(e as Error).message}`);
        estado.push({ nombre: 'Baloncesto', vivo: false, prefijo: 'bb_' });
      }
    }
    if (countRows('fb_teams') > 0) {
      try {
        const r = await refreshFootballOdds();
        log(`Football odds refreshed: ${r.count} fixtures (${r.source}).`);
        estado.push({ nombre: 'Fútbol', vivo: r.source === 'live', prefijo: 'fb_' });
      } catch (e) {
        log(`Football odds refresh failed: ${(e as Error).message}`);
        estado.push({ nombre: 'Fútbol', vivo: false, prefijo: 'fb_' });
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
        estado.push({ nombre: 'Béisbol', vivo: r.source === 'live', prefijo: 'bsb_' });
      } catch (e) {
        log(`Baseball odds refresh failed: ${(e as Error).message}`);
        estado.push({ nombre: 'Béisbol', vivo: false, prefijo: 'bsb_' });
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

    // ===========================================================================
    // LA ALERTA: SE COMPRUEBA CADA CICLO, NO CUANDO ALGUIEN MIRA
    // ===========================================================================
    // Un objetivo de latencia que solo se comprueba al abrir un panel no es un
    // objetivo, es una curiosidad. Se mira aquí, se dice en el log, y se empuja al
    // canal para que aparezca en pantalla sin que nadie tenga que ir a buscarlo.
    try {
      const al = checkLatency();
      if (al.breached) {
        log(`⚠ Latencia: ${al.message}`);
        publish({
          type: 'latency',
          title: 'Latencia fuera del objetivo',
          body: al.message,
          at: new Date().toISOString(),
        });
      }
    } catch {
      // Comprobar la latencia no puede romper el ciclo de odds.
    }

    // Solo en el primer ciclo: ver `avisoDeCuotas`. Repetido cada doce horas sería ruido,
    // y el ruido se deja de leer.
    //
    // La NFL NO entra en el aviso a propósito. Los otros cuatro inventan cuotas cuando no
    // las consiguen, así que ahí «demostración» significa que el precio no es de nadie.
    // La NFL nunca inventa: sin línea, la tarjeta sale sin precio y el partido sigue
    // siendo real. Meterla diría que sus partidos son inventados, que es peor que callarse.
    if (primerCiclo) {
      primerCiclo = false;
      try {
        avisoDeCuotas(estado);
      } catch {
        // Un aviso que no se puede imprimir no puede tumbar el servidor.
      }
    }
    schedule();
  };

  const schedule = () => {
    // An explicit AUTO_REFRESH_MINUTES always wins: someone who set it meant it.
    //
    // ===========================================================================
    // CADENCIA ADAPTATIVA
    // ===========================================================================
    // El ritmo base sigue saliendo del tamaño del plan, como antes. Lo nuevo es que se
    // ACELERA cuando hay un partido inminente o un mercado moviéndose, y se relaja
    // cuando no hay nada. El gasto medio no cambia —lo que se adelanta hoy se devuelve
    // mañana— pero el precio llega antes justo cuando llegar antes vale algo.
    //
    // Un partido a media hora con la línea moviéndose puede acelerar el ciclo ×8; una
    // tarde sin nada lo deja en el ritmo del plan. Ver latency/schedule.ts para por qué
    // el reparto es por deporte y no por partido: el proveedor cobra por petición y
    // devuelve la liga entera, así que «refrescar solo este partido» no existe.
    const suggested = env.autoRefreshMinutesExplicit ? null : recommendedRefreshMinutes();
    let next = suggested ?? env.autoRefreshMinutes;
    if (!env.autoRefreshMinutesExplicit) {
      const plan = planTotal();
      const perCycle = lastCycleCredits();
      if (plan != null && perCycle != null && perCycle > 0) {
        try {
          const a = allocate(plan / 30, perCycle);
          if (a.cycleMinutes < next) {
            log(`Latencia: acelerando a ${a.cycleMinutes} min — ${a.explanation}`);
            next = a.cycleMinutes;
          }
        } catch {
          // Si el reparto falla, el ritmo del plan sigue siendo correcto.
        }
      }
    }
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

  // ===========================================================================
  // ETAPA «SERVIDOR»: petición → respuesta
  // ===========================================================================
  // Se mide con los ganchos de Fastify y no con un cronómetro dentro de cada ruta,
  // porque así cubre TODA la petición —parseo, ruta, serialización— y no se puede
  // olvidar en una ruta nueva. Solo se guardan las de predicción: medir el endpoint de
  // latencia dentro de la propia latencia añade ruido y no informa de nada.
  app.addHook('onRequest', async (req) => {
    (req as { __t0?: bigint }).__t0 = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req) => {
    const t0 = (req as { __t0?: bigint }).__t0;
    if (!t0) return;
    const url = req.url;
    // Solo las rutas que producen una predicción: son las que están en el camino del
    // precio hasta la pantalla. Las demás no forman parte de este recorrido.
    if (!/\/api\/(football|basketball|baseball|nfl|matches)/.test(url)) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const sport = url.includes('/football')
      ? 'football'
      : url.includes('/basketball')
        ? 'basketball'
        : url.includes('/baseball')
          ? 'baseball'
          : url.includes('/nfl')
            ? 'nfl'
            : 'tennis';
    try {
      recordLatency({ stage: 'servidor', ms, sport });
    } catch {
      // Medir no puede tumbar una respuesta que ya se ha enviado.
    }
  });

  // La contraseña, antes que NADA. Un hook registrado después de las rutas sigue
  // corriendo antes que ellas —Fastify ordena por ciclo de vida, no por orden de
  // registro—, pero ponerlo aquí hace que al leer el fichero se vea que está puesto, y
  // que nadie añada una ruta «arriba» creyendo que la esquiva.
  registerAuth(app);

  await app.register(cors, { origin: true });
  await app.register(registerRoutes, { prefix: '/api' });
  // Basketball lives in its own namespace: no endpoint can return both sports.
  await app.register(registerBasketballRoutes, { prefix: '/api/basketball' });
  await app.register(registerFootballRoutes, { prefix: '/api/football' });
  await app.register(registerLatencyRoutes, { prefix: '/api/latency' });
  await app.register(registerStakingRoutes, { prefix: '/api/staking' });
  await app.register(registerBaseballRoutes, { prefix: '/api/baseball' });
  await app.register(registerNflRoutes, { prefix: '/api/nfl' });
  // The bet log is not a sixth sport: it records what the person staked, not what
  // any model claimed, so it gets its own namespace rather than living under one.
  await app.register(registerBetRoutes, { prefix: '/api/bets' });

  // Fly comprueba que la máquina vive pidiendo esto. Va sin contraseña a propósito (ver
  // auth.ts) y no toca la base: solo dice que el proceso responde.
  app.get('/healthz', async () => ({ ok: true }));

  // La app construida, si la hay. En desarrollo no la hay y la sirve Vite, así que esto
  // no se registra y `/` sigue devolviendo el índice de la API de abajo.
  if (webBuildExists()) {
    await registerStatic(app);
    app.log.info(`Sirviendo la app construida desde ${WEB_DIST}`);
  } else if (isProduction) {
    // En producción esto NO es un detalle: significa que el despliegue responde a la API
    // y devuelve 404 en la portada. Mejor no arrancar que quedar así.
    throw new Error(
      `No hay app construida en ${WEB_DIST}, y NODE_ENV=production.\n\n` +
        'El contenedor tiene que construir el frontend (npm run build) antes de arrancar\n' +
        'el servidor; si no, la URL contesta a /api pero no se puede abrir.',
    );
  }

  // El índice de la API en `/` SOLO cuando no hay app que servir.
  //
  // Con las dos cosas registradas gana esta, porque una ruta explícita tiene prioridad
  // sobre el comodín del plugin de estáticos — y entonces abrir la URL desplegada
  // devuelve un JSON que describe la API en vez de la aplicación. Es el fallo más tonto
  // posible («desplegado con éxito», imposible de abrir) y salió probando la portada, no
  // leyendo el código.
  if (!webBuildExists())
    app.get('/', async () => ({
      name: 'tennis-predictor API',
      docs:
        'Tenis: /api/health, /api/tours, /api/matches/upcoming, /api/predictions/:id · ' +
        'Baloncesto: /api/basketball/leagues, /api/basketball/games/upcoming · ' +
        'Fútbol: /api/football/leagues, /api/football/fixtures/upcoming, /api/football/power',
    }));

  try {
    // Antes de aceptar una sola conexión: si esto va a ser público y no hay contraseña,
    // el proceso muere aquí en vez de quedarse abierto.
    assertAuthConfigured();
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

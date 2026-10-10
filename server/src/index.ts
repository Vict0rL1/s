// REST API bootstrap (Fastify).

import { captureClosingOdds } from './odds/closingCapture.ts';
import { env, ROOT } from './config.ts';
import path from 'node:path';
import { readOddsReason, type SportPrefix } from './oddsReason.ts';
import { inspectEnvFile } from './envFile.ts';
import { place, settle } from './paper/bankroll.ts';
import { colocarEstrategias, liquidarEstrategias } from './estrategias/index.ts';
import { cicloResumenDiario, cicloInformeSemanal } from './informes/index.ts';
import { calentar } from './cache/respuestas.ts';
import { cicloAsistenteTelegram } from './telegram/asistente.ts';
import { getDb } from './db.ts';
import { countRows } from './repo.ts';
import { refreshOdds } from './ingest/odds.ts';
import { conRegistro, marcarMuertas } from './ingest/runs.ts';
import { horasDesdeEntorno, cicloResultados, PRIMERA_PASADA_MIN } from './ingest/scheduler.ts';
import { registrar, arrancar } from './scheduler/registry.ts';
import { horasDesdeEntorno as horasDeCadencia } from './scheduler/horas.ts';
import { instalarApagado } from './apagado.ts';
import { cicloClima } from './weather/openMeteo.ts';
import { cicloMonitorizacion } from './monitoring/series.ts';
import { cicloSimulacion } from './simulation/season.ts';
import { ingestBullpen } from './baseball/ingest/bullpen.ts';
import { hacerCopia, ultimaCopia } from './db/backup.ts';
import { featureEncendida } from './features.ts';
import { refreshBasketballOdds } from './basketball/ingest/odds.ts';
import { refreshFootballOdds } from './football/ingest/odds.ts';
import { refreshBaseballOdds } from './baseball/ingest/odds.ts';
import { refreshOdds as refreshNflOdds } from './nfl/ingest/odds.ts';
import { refrescarCuotas as refreshNhlOdds } from './nhl/proximos.ts';
import { refrescarCuotas as refreshUfcOdds } from './ufc/proximos.ts';
import {
  getQuota,
  lastCycleCredits,
  planTotal,
  recommendedRefreshMinutes,
  recordCycleSpend,
} from './oddsQuota.ts';
import { assertAuthConfigured, authRuntimeDesdeEntorno } from './auth.ts';
import { buildApp } from './app.ts';
import { cicloPrePartido } from './prematch/job.ts';
import { checkLatency, publish } from './latency/alert.ts';
import { allocate } from './latency/schedule.ts';
import { resolvePredictions } from './trackRecord.ts';
import { resolveGamePredictions } from './basketball/trackRecord.ts';
import { resolveFootballPredictions } from './football/trackRecord.ts';
import { resolveBaseballPredictions } from './baseball/trackRecord.ts';
import { resolveNflPredictions } from './nfl/trackRecord.ts';
import { resolveNhlPredictions } from './nhl/trackRecord.ts';
import { resolveUfcPredictions } from './ufc/trackRecord.ts';
import { hostDeEscucha } from './auth/mode.ts';

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
  // El DETALLE, además de la causa. La causa dice qué tipo de problema es; el detalle
  // dice cuál en concreto —a qué ligas se preguntó y qué contestó cada una— y es lo
  // único con lo que se puede seguir cuando la frase genérica no cuadra con la
  // realidad («la Premier está en temporada y esto dice que no hay partidos»).
  //
  // Va aquí y no solo en `npm run odds` porque `npm run dev` es una forma
  // perfectamente legítima de arrancar, y era la que estaba usando quien tenía el
  // problema: pedirle la salida de otro comando para ver un dato que este ya conoce es
  // mandarle a repetir trabajo que la app puede ahorrarle.
  const detallePorCausa = new Map<string, string>();
  for (const s of demo) {
    const { reason, detail } = readOddsReason(s.prefijo);
    const k = reason ?? 'sin_causa';
    porCausa.set(k, [...(porCausa.get(k) ?? []), s.nombre]);
    if (detail && !detallePorCausa.has(k)) detallePorCausa.set(k, detail);
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
        L.push('    Falta ODDS_API_KEY. Lo más fácil, en otra terminal y dentro de la carpeta:');
        L.push('      npm run clave   (la pide sin enseñarla, la escribe en el .env y la comprueba)');
        L.push(`    A mano: una línea ODDS_API_KEY=tu-clave en ${ENV_PATH}`);
        L.push('    Y después: reinicia esto (Ctrl+C y npm run dev) y, si quieres cuotas ya, npm run odds');
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
      case 'presupuesto':
        // Esta causa NO manda a esperar. Es la única de las cinco que se arregla
        // escribiendo algo, y la única que empeora si se ignora: el refresco automático
        // seguirá frenado mañana y pasado.
        L.push('    NO se ha llegado a preguntar: la app se frenó sola para repartir el plan');
        L.push('    del mes. Esto NO lo arregla esperar — el refresco automático seguirá');
        L.push('    frenado. Pídelas a mano, que sí pasa el freno:   npm run odds');
        break;
      default:
        L.push('    Sin causa registrada.  npm run doctor  lo desglosa sin gastar cuota.');
    }
    const d = detallePorCausa.get(causa);
    // Se parte a lo ancho de la caja en vez de cortarlo: la lista de ligas consultadas
    // es justo lo que hay que leer entero, y truncarla a una línea deja fuera las del
    // final, que son las que suelen faltar.
    if (d) {
      L.push('');
      for (const trozo of d.match(/.{1,68}(\s|$)/g) ?? [d]) L.push(`      ${trozo.trim()}`);
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
        const r = await conRegistro('odds:tenis', async () => {
          const x = await refreshOdds();
          return { ...x, rowsAdded: x.count, detail: x.source };
        });
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
        const r = await conRegistro('odds:baloncesto', async () => {
          const x = await refreshBasketballOdds();
          return { ...x, rowsAdded: x.count, detail: x.source };
        });
        log(`Basketball odds refreshed: ${r.count} games (${r.source}).`);
        estado.push({ nombre: 'Baloncesto', vivo: r.source === 'live', prefijo: 'bb_' });
      } catch (e) {
        log(`Basketball odds refresh failed: ${(e as Error).message}`);
        estado.push({ nombre: 'Baloncesto', vivo: false, prefijo: 'bb_' });
      }
    }
    if (countRows('fb_teams') > 0) {
      try {
        const r = await conRegistro('odds:futbol', async () => {
          const x = await refreshFootballOdds();
          return { ...x, rowsAdded: x.count, detail: x.source };
        });
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
        const r = await conRegistro('odds:beisbol', async () => {
          const x = await refreshBaseballOdds();
          return { ...x, rowsAdded: x.count, detail: x.source };
        });
        log(`Baseball odds refreshed: ${r.count} games (${r.source}).`);
        estado.push({ nombre: 'Béisbol', vivo: r.source === 'live', prefijo: 'bsb_' });
      } catch (e) {
        log(`Baseball odds refresh failed: ${(e as Error).message}`);
        estado.push({ nombre: 'Béisbol', vivo: false, prefijo: 'bsb_' });
      }
    }
    if (countRows('naf_teams') > 0) {
      try {
        const { n } = await conRegistro('odds:nfl', async () => {
          const x = await refreshNflOdds();
          return { n: x, rowsAdded: x };
        });
        log(`NFL odds refreshed: ${n} games.`);
      } catch (e) {
        log(`NFL odds refresh failed: ${(e as Error).message}`);
      }
    }
    // La NHL: fuera de temporada no gasta (el listado de /sports, gratis, lo decide).
    if (countRows('nhl_games') > 0) {
      try {
        const { n } = await conRegistro('odds:nhl', async () => {
          const x = await refreshNhlOdds();
          return { n: x, rowsAdded: x };
        });
        log(`NHL odds refreshed: ${n} games.`);
      } catch (e) {
        log(`NHL odds refresh failed: ${(e as Error).message}`);
      }
    }
    // La UFC: solo con el archivo (sin él no se sabe quién es quién ni qué cartelera es de la UFC).
    if (countRows('ufc_fights') > 0) {
      try {
        const { n } = await conRegistro('odds:ufc', async () => {
          const x = await refreshUfcOdds();
          return { n: x, rowsAdded: x };
        });
        log(`UFC odds refreshed: ${n} fights.`);
      } catch (e) {
        log(`UFC odds refresh failed: ${(e as Error).message}`);
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

    // El banco de papel: liquidar antes de apostar, para que el sizing use el banco
    // actualizado y no el de antes de saber cómo acabaron los partidos del fin de semana.
    try {
      settle();
      liquidarEstrategias();
      // Evaluación de confianza con las cuotas recién descargadas: sin ella, la
      // abstención de `place()` no se fía de nada y no apuesta.
      cicloPrePartido(log);
      place();
      // El laboratorio (Fase 6.1): las mismas candidatas, cada estrategia con su configuración.
      colocarEstrategias();
    } catch (e) {
      log(`Banco de papel: ${(e as Error).message}`);
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
    ['nhl', resolveNhlPredictions],
    ['ufc', resolveUfcPredictions],
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
  // La configuración de la puerta se comprueba ANTES de construir nada: si esto va a ser
  // público y no hay contraseña, el proceso muere aquí en vez de quedarse abierto.
  const auth = authRuntimeDesdeEntorno();
  assertAuthConfigured(auth.config);
  const app = await buildApp({ auth, servirWeb: true });

  try {
    // 127.0.0.1 en el portátil sin contraseña; toda la red solo con ella o en producción (D15).
    await app.listen({ port: env.port, host: hostDeEscucha() });
    app.log.info(`Tennis Predictor API listening on http://localhost:${env.port}`);
    startAutoRefresh((msg) => app.log.info(msg));

    const resolveLog = (msg: string) => app.log.info(msg);
    // Ingestas que se quedaron «running» porque el proceso anterior cayó: se marcan.
    const muertas = marcarMuertas();
    if (muertas > 0) resolveLog(`${muertas} ingesta(s) a medias del arranque anterior marcadas como error.`);

    // =========================================================================
    // LOS TRABAJOS PROGRAMADOS, EN UN REGISTRO (Fase 3.7)
    // =========================================================================
    // Antes eran temporizadores sueltos aquí; ahora cada uno es una entrada del registro
    // (scheduler/registry.ts): cadencia, primera pasada, última ejecución, duración, estado y
    // un interruptor por trabajo que se puede apagar desde la API sin reiniciar. Todos locales
    // y sin cuota salvo el cierre de cuotas, que solo se registra con clave.
    // Acotadas a 7 días (lote B, B5): un setTimeout por encima de 24,8 días dispara en el acto.
    const backupHoras = horasDeCadencia(process.env, 'BACKUP_HOURS', 24);
    const horasResultados = horasDesdeEntorno();

    // Puntuar el registro en vivo con los resultados que lleguen (y al arrancar, lo atrasado).
    registrar({ nombre: 'puntuar-en-vivo', descripcion: 'Puntúa las predicciones en vivo con los resultados del archivo', cadenciaMin: RESOLVE_EVERY_MINUTES, primeraEnMin: 0, fn: (log) => resolveAllPredictions(log) });
    // Instantáneas pre-partido (T-24h, T-6h, T-1h y la final congelada). Ver prematch/snapshots.ts.
    registrar({ nombre: 'pre-partido', descripcion: 'Predice lo próximo, guarda instantáneas y congela la final de lo que empezó', cadenciaMin: 15, primeraEnMin: 0, fn: (log) => {
        cicloPrePartido(log);
        // Las listas de próximos por defecto quedan calculadas para la siguiente visita (Fase 7.2).
        calentar(log);
      } });
    // Copia del libro mayor (ver db/backup.ts). La primera, a los dos minutos si la última es
    // más vieja que el intervalo: reiniciar no dispara copias.
    registrar({
      nombre: 'copia-ledger',
      descripcion: 'Copia de seguridad de ledger.db (local y, con BACKUP_S3_*, S3)',
      cadenciaMin: backupHoras * 60,
      primeraEnMin: 2,
      cuando: () => featureEncendida('datos.backupProgramado') && backupHoras > 0,
      fn: (log) =>
        conRegistro('backup', async () => {
          const ultima = ultimaCopia();
          if (ultima && Date.now() - Date.parse(ultima.cuando) < backupHoras * 3_600_000 * 0.9) {
            log(`Copia del libro mayor: la última es reciente (${ultima.cuando}); se deja para el siguiente tic.`);
            return { rowsAdded: 0, detail: 'reciente, no hacía falta' };
          }
          const c = await hacerCopia();
          log(`Copia del libro mayor: ${c.fichero} (${(c.bytes / 1048576).toFixed(1)} MB)${c.s3 ? (c.s3.subido ? ' · subida a S3' : ` · S3 falló: ${c.s3.error}`) : ''}`);
          return { rowsAdded: 1, detail: c.fichero };
        }),
    });
    // Resultados de los deportes con archivo propio, en procesos hijo (ver ingest/scheduler.ts).
    registrar({
      nombre: 'resultados',
      descripcion: 'update-results: resultados de fútbol, baloncesto, béisbol, NFL, NHL y UFC en procesos hijo, sin cuota',
      cadenciaMin: horasResultados * 60,
      primeraEnMin: PRIMERA_PASADA_MIN,
      cuando: () => featureEncendida('datos.resultadosProgramados') && horasResultados > 0,
      fn: async (log) => {
        await cicloResultados(undefined, log);
        resolveAllPredictions(log);
      },
    });
    // Clima (Fase 2C): previsión a tres horizontes y observación final. Solo informativo.
    registrar({
      nombre: 'clima',
      descripcion: 'Previsión y observación de Open-Meteo para NFL y MLB (informativo)',
      cadenciaMin: 30,
      primeraEnMin: 3,
      cuando: () => featureEncendida('fuentes.clima'),
      fn: (log) =>
        conRegistro('clima', async () => {
          const r = await cicloClima({ log });
          return { rowsAdded: r.guardados, detail: `${r.consultados} consultas · ${r.fallidos} fallidas · ${r.sinEstadio} sin estadio` };
        }),
    });
    // Bullpen MLB (Fase 2C): boxscores de los últimos tres días. Solo informativo.
    registrar({
      nombre: 'bullpen',
      descripcion: 'Carga del bullpen MLB de los boxscores recientes (informativo)',
      cadenciaMin: 12 * 60,
      primeraEnMin: 4,
      cuando: () => featureEncendida('fuentes.bullpen') && countRows('bsb_teams') > 0,
      fn: (log) =>
        conRegistro('bullpen', async () => {
          const r = await ingestBullpen();
          log(`Bullpen: ${r.partidos} boxscores, ${r.equipos} equipos, ${r.relevistas} relevistas (al día ${r.asOf}).`);
          return { rowsAdded: r.relevistas, detail: `${r.partidos} partidos · ${r.equipos} equipos` };
        }),
    });
    // La cuota de CIERRE de verdad: justo antes de que empiecen los partidos con una apuesta
    // de papel o una señal abierta (1 crédito por liga, respetando el presupuesto).
    // Monitorización diaria (Fase 4.5): ventana de 4 semanas, PSI y alerta de deriva.
    registrar({
      nombre: 'monitorizacion',
      descripcion: 'Serie diaria de log loss, Brier y PSI en vivo contra el backtest; alerta de deriva',
      cadenciaMin: 24 * 60,
      primeraEnMin: 6,
      cuando: () => featureEncendida('analitica.monitorizacion'),
      fn: (log) => cicloMonitorizacion(log),
    });
    // Simulación de temporada (Fase 4.6): una corrida por liga y día, cacheada.
    registrar({
      nombre: 'simulacion-temporada',
      descripcion: 'Monte Carlo de la temporada por liga con las probabilidades de hoy (cacheado por día)',
      cadenciaMin: 24 * 60,
      primeraEnMin: 8,
      cuando: () => featureEncendida('simulacion.temporada'),
      fn: (log) => cicloSimulacion(log),
    });
    // Informes (Fase 6.7–6.8): cada hora se mira si toca; se generan una vez por periodo.
    registrar({
      nombre: 'resumen-diario',
      descripcion: 'Resumen del día (a partir de las 7:00 de APP_TIMEZONE), archivado y enviado por los canales',
      cadenciaMin: 60,
      primeraEnMin: 9,
      cuando: () => featureEncendida('informes.diario'),
      fn: (log) => cicloResumenDiario(log),
    });
    registrar({
      nombre: 'informe-semanal',
      descripcion: 'Informe de la semana anterior (desde el lunes a las 7:00), archivado y enviado por los canales',
      cadenciaMin: 60,
      primeraEnMin: 11,
      cuando: () => featureEncendida('informes.semanal'),
      fn: (log) => cicloInformeSemanal(log),
    });
    // El asistente por Telegram (Fase 8.3, apagado por defecto): una pasada por minuto, sin esperar.
    registrar({
      nombre: 'asistente-telegram',
      descripcion: 'Contesta en Telegram con el asistente determinista, solo a los chats permitidos',
      cadenciaMin: 1,
      primeraEnMin: 1,
      cuando: () => featureEncendida('asistente.telegram') && !!process.env.TELEGRAM_BOT_TOKEN?.trim(),
      fn: async (log) => {
        const r = await cicloAsistenteTelegram({ log });
        if (r.error) log(`Asistente de Telegram: ${r.error}`);
      },
    });
    registrar({ nombre: 'cierre-cuotas', descripcion: 'Observa el cierre de los partidos con apuesta o señal abierta (gasta cuota)', cadenciaMin: 10, primeraEnMin: 10, cuando: () => !!env.oddsApiKey, fn: (log) => captureClosingOdds(log) });

    if (featureEncendida('operacion.registroTrabajos')) arrancar(resolveLog);
    else resolveLog('Registro de trabajos apagado (features.json: operacion.registroTrabajos): nada programado salvo el refresco de cuotas.');

    // Parar bien: SIGINT/SIGTERM cierran los trabajos, el servidor y la base (ver apagado.ts).
    instalarApagado(() => app.close(), resolveLog);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

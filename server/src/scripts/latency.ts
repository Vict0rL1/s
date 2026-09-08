// El informe de latencia de punta a punta.
//
// CLI:
//   npm run latency            — el desglose por etapas contra el objetivo
//   npm run latency -- --probe — comprueba si el proveedor ofrece WebSocket
//
// ===========================================================================
// LO QUE ESTE INFORME TIENE QUE CONSEGUIR
// ===========================================================================
// Que alguien lo lea y sepa QUÉ HACER. No «vas a 7 minutos», sino «vas a 7 minutos, seis
// de ellos esperando al siguiente sondeo, y eso se arregla con un plan mayor o con menos
// deportes — no tocando el código».
//
// Por eso cada etapa sale con su dueño al lado, y por eso el informe dice si el objetivo
// es siquiera alcanzable con el plan que hay antes de reprocharle nada a nadie.

import { getDb } from '../db.ts';
import {
  budgetFromEnv,
  reachable,
  STAGE_LABEL,
  STAGE_OWNER,
  type Stage,
} from '../latency/budget.ts';
import { stageStats, totalP95, pruneLatency } from '../latency/record.ts';
import { checkLatency } from '../latency/alert.ts';
import { probeWebSocket, storeProbe, lastProbe, currentTransport } from '../latency/transport.ts';
import { allocate } from '../latency/schedule.ts';
import { planTotal, lastCycleCredits } from '../oddsQuota.ts';
import { env } from '../config.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1] ?? 'true']] : [])),
) as Record<string, string>;

const db = getDb();
const fmt = (ms: number): string =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;

async function probe(): Promise<void> {
  console.log('SONDA DE TRANSPORTE\n');
  console.log('  Intentando el apretón de manos de WebSocket contra los endpoints candidatos.');
  console.log('  (Un 404 o un 400 son respuestas válidas: significan que ahí no hay WebSocket.)\n');
  const r = await probeWebSocket(env.oddsApiKey || undefined);
  for (const t of r.tried) console.log(`  ${t.url.padEnd(46)} ${t.result}`);
  storeProbe(r);
  console.log(`\n  → ${r.conclusive ? r.transport.toUpperCase() : 'SIN CONCLUSIÓN'}: ${r.detail}`);
  if (r.transport === 'sondeo' && r.conclusive) {
    console.log(
      '\n  Consecuencia práctica: la latencia de ORIGEN la fija la cadencia de sondeo, no\n' +
        '  la red. Optimizar el parseo o la serialización no la toca. Lo que la mueve es\n' +
        '  sondear más a menudo (cuesta cuota) o sondear de forma desigual (gratis, y es\n' +
        '  lo que hace el reparto adaptativo).',
    );
  }
}

function report(): void {
  const hours = Number(args.hours) || 24;
  const budget = budgetFromEnv();
  const stats = stageStats(hours);
  const total = totalP95(hours);
  const alert = checkLatency(hours);

  console.log(`LATENCIA DE PUNTA A PUNTA · últimas ${hours} h\n`);

  // ---- ¿Es alcanzable el objetivo? Esto va PRIMERO ----
  const plan = planTotal();
  const perCycle = lastCycleCredits();
  const feasible = reachable(budget, plan, perCycle);
  console.log(`OBJETIVO: ${fmt(budget.totalMs)} de punta a punta (p95)`);
  // Un ✓ sobre «todavía no lo sé» es la misma mentira que un ✓ sobre una medición
  // incompleta: `ok` es true ahí porque no hay nada que reprochar, no porque el
  // objetivo quepa. `bestPossibleMs` es lo que distingue haberlo calculado de no.
  console.log(
    `  ${feasible.bestPossibleMs == null ? '·' : feasible.ok ? '✓' : '✗'} ${feasible.reason}`,
  );
  if (!feasible.ok) {
    console.log(
      '\n  Esto es lo primero que hay que leer: el objetivo NO se puede cumplir con este\n' +
        '  plan, así que incumplirlo no es un fallo del código. Sube el plan, quita\n' +
        '  deportes del ciclo, o baja el objetivo con LATENCY_TARGET_MS.',
    );
  }

  // ---- El desglose ----
  console.log('\nPOR ETAPAS  (p95: cómo va cuando va mal, que es la pregunta)');
  console.log('  etapa      n      p50        p95        presupuesto  dueño');
  for (const s of stats) {
    const b = budget.perStage[s.stage as Stage];
    const flag = s.n > 0 && s.p95 > b ? ' ⚠' : '';
    console.log(
      `  ${s.stage.padEnd(10)} ${String(s.n).padStart(5)}  ` +
        `${fmt(s.p50).padStart(9)}  ${fmt(s.p95).padStart(9)}  ${fmt(b).padStart(11)}  ` +
        `${STAGE_OWNER[s.stage as Stage]}${flag}`,
    );
  }
  console.log();
  for (const s of stats) {
    if (s.n === 0) {
      console.log(
        `  · «${STAGE_LABEL[s.stage as Stage]}» sin muestras todavía` +
          (s.stage === 'cliente'
            ? ' — la mide el navegador; abre la app.'
            : s.stage === 'origen'
              ? ' — hace falta una clave de The Odds API y un precio que cambie.'
              : ''),
      );
    }
  }

  console.log(
    `\nTOTAL p95: ${fmt(total.ms)}` +
      (total.complete ? '' : `  (INCOMPLETO: faltan ${total.missing.join(', ')})`),
  );
  console.log(
    '  Sumar los p95 de cuatro etapas NO da el p95 del total —solo sería cierto si se\n' +
      '  atascaran siempre a la vez— y sale PESIMISTA. Se usa así a propósito: para un\n' +
      '  objetivo de latencia, equivocarse por el lado pesimista es el lado correcto.',
  );
  // Un ✓ sobre una medición incompleta es peor que no decir nada: parece que se
  // cumple el objetivo cuando lo que pasa es que no se ha medido.
  const mark = !total.complete ? '· ' : alert.breached ? '⚠ ' : '✓ ';
  console.log(`\n${mark}${alert.message}`);
  for (const o of alert.offenders) {
    console.log(
      `    · ${o.stage}: ${fmt(o.p95)} contra ${fmt(o.budget)} — se pasa ${fmt(o.overBy)} (${o.owner})`,
    );
  }

  // ---- Transporte ----
  const t = currentTransport();
  console.log(`\nTRANSPORTE: ${t.kind}`);
  console.log(`  ${t.note}`);
  if (!lastProbe()) console.log('  Compruébalo con `npm run latency -- --probe`.');

  // ---- El reparto adaptativo ----
  console.log('\nREPARTO ADAPTATIVO');
  if (plan == null || perCycle == null) {
    console.log(
      '  Sin datos del plan todavía: hace falta un ciclo de refresco con clave para saber\n' +
        '  cuánto cuesta y cuánto hay. Hasta entonces, cadencia fija.',
    );
  } else {
    const a = allocate(plan / 30, perCycle);
    console.log(`  ${a.explanation}`);
    if (a.fixtures.length > 0) {
      console.log('\n  los más urgentes:');
      for (const f of a.fixtures.slice(0, 6)) {
        console.log(
          `    ${f.fixtureId.slice(0, 12).padEnd(13)} ` +
            `empieza en ${f.minutesToStart.toFixed(0).padStart(5)} min · ` +
            `${f.recentMoves} mov. · peso ${f.weight.toFixed(3)} · ${f.reason}`,
        );
      }
      if (a.deferred > 0) console.log(`    … y ${a.deferred} más`);
    }
  }

  // ---- Frescura observada en origen ----
  const fresh = db
    .prepare(
      `SELECT COUNT(*) n,
              AVG((julianday(fetched_at) - julianday(source_updated_at)) * 86400000) avgMs
       FROM odds_freshness WHERE fetched_at >= ?`,
    )
    .get(new Date(Date.now() - hours * 3600_000).toISOString()) as unknown as {
    n: number;
    avgMs: number | null;
  };
  console.log('\nFRESCURA EN ORIGEN');
  if (fresh.n === 0) {
    console.log(
      '  Sin precios nuevos en la ventana. Con las fixtures de demostración esto queda\n' +
        '  vacío a propósito: no tienen marca de origen, y ponerles «ahora» daría una\n' +
        '  latencia de cero y haría presumir de una velocidad que no existe.',
    );
  } else {
    console.log(
      `  ${fresh.n} precios nuevos · antigüedad media al leerlos ${fmt(fresh.avgMs ?? 0)}`,
    );
    console.log(
      '  Esto es «la casa publicó → lo teníamos». Incluye el viaje casa → proveedor, que\n' +
        '  NO se puede separar: el proveedor no sella cuándo lo recibió él, solo reenvía\n' +
        '  el last_update de la casa.',
    );
  }

  if (args.prune) {
    const removed = pruneLatency(Number(args.prune) || 30);
    console.log(`\nPodadas ${removed} muestras viejas.`);
  }
}

if (args.probe) await probe();
else report();

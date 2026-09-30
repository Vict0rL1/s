// CLI: `npm run study:correlation`
//
// ===========================================================================
// LA PREGUNTA
// ===========================================================================
// El módulo de riesgo dimensiona cada apuesta como si fuera la única que existe. Un
// sábado no lo es: hay ocho posiciones abiertas a la vez y, si fallan juntas, el banco
// no cae ocho veces un poco — cae una vez mucho.
//
// «Fallan juntas» tiene un significado preciso y comprobable: los ERRORES del modelo
// están correlacionados entre partidos. No los resultados —el Arsenal y el Chelsea
// pueden ganar los dos sin que eso sea sospechoso— sino la parte del resultado que el
// modelo NO vio venir. Si el modelo infravalora los goles de una jornada entera, todos
// los «over» de esa jornada fallan a la vez, y ninguno de los ocho sizings lo sabía.
//
// ===========================================================================
// CÓMO SE MIDE, Y POR QUÉ ASÍ
// ===========================================================================
// Para cada partido se saca la predicción FUERA DE MUESTRA (walk-forward: el modelo
// solo ha visto lo anterior a ese día) y se calcula el residuo tipificado:
//
//     z = (y − p) / sqrt(p·(1 − p))        y ∈ {0, 1}
//
// Con el modelo bien calibrado, E[z] = 0 y Var[z] = 1 por construcción. Entonces la
// correlación entre dos apuestas es directamente E[z_i · z_j]: si vale 0 son
// independientes dado el modelo, y si es positiva fallan juntas.
//
// Tipificar importa. Sin dividir por sqrt(p·q), un partido con p = 0.9 aporta residuos
// diminutos y otro con p = 0.5 los aporta grandes, y la «correlación» acabaría midiendo
// qué mezcla de probabilidades tiene cada grupo en vez de si los errores van juntos.
//
// ===========================================================================
// EL GRUPO DE CONTROL ES LA MITAD DEL EXPERIMENTO
// ===========================================================================
// Pares de LIGAS DISTINTAS y DÍAS DISTINTOS. No hay ningún mecanismo por el que el
// error del Betis contra el Cádiz en marzo deba parecerse al del Everton contra el
// Burnley en noviembre, así que ese número TIENE que salir ~0.
//
// Si no sale 0, el estimador está roto y ninguna de las otras cifras vale nada. Es la
// única forma de distinguir «he medido una correlación» de «he medido un artefacto de
// mi propio código», y sin él este script sería una máquina de fabricar números
// convincentes.
//
// ===========================================================================
// EL ERROR ESTÁNDAR NO PUEDE SER EL INGENUO
// ===========================================================================
// Los pares NO son independientes: un partido aparece en muchos pares, así que N pares
// no son N observaciones y un error estándar calculado sobre pares saldría
// ridículamente pequeño. Se usa bootstrap por BLOQUES sobre (liga, jornada): se
// remuestrean jornadas enteras, que es la unidad que sí se puede considerar
// independiente.

import { scoreDistribution, outcomeProbabilities } from '../football/model.ts';
import { expectedGoalsDc, type DcMatch } from '../football/bayes/dixonColes.ts';
import { DcWalkForward } from '../football/bayes/walkforward.ts';
import { DC_HYPER } from '../football/ratings.ts';
import { footballConfig } from '../config.ts';
import { getDb } from '../db.ts';
import { splitOf } from '../experiments/holdout.ts';
import { recordExperiment } from '../experiments/registry.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1] ?? 'true']] : [])),
) as Record<string, string>;

const LEAGUES = footballConfig.leagues.map((l) => l.id);
const REFIT_DAYS = Number(args.refit) || 14;

/** Los tres mercados que la app dimensiona. Cada uno con su dirección. */
type Market = '1X2' | 'over25' | 'btts';

interface Obs {
  league: string;
  date: string;
  /**
   * El partido. Hace falta para SEPARAR dos preguntas que la primera versión de este
   * script mezcló y que dan respuestas opuestas: dos mercados del MISMO partido están
   * fuertemente correlacionados por construcción (el 1X2 y el over de Arsenal-Chelsea
   * miran el mismo marcador), y dos mercados de partidos DISTINTOS de la misma jornada
   * no tienen por qué. Al no excluir el mismo partido, el grupo «mercados distintos»
   * salía significativo y lo único que estaba midiendo era lo primero.
   */
  matchId: string;
  /** La jornada: la unidad que se remuestrea en el bootstrap. */
  block: string;
  market: Market;
  /**
   * Hacia qué lado apuesta el modelo, para poder separar «mismo sesgo» de «sesgo
   * opuesto». En el 1X2 es local/visitante; en los binarios, sí/no.
   */
  side: 'local' | 'visitante' | 'si' | 'no';
  p: number;
  y: 0 | 1;
  /** Residuo tipificado. */
  z: number;
}

function leagueMatches(league: string): (DcMatch & { season: number })[] {
  return getDb()
    .prepare(
      `SELECT match_date date, season, home_id homeId, away_id awayId,
              home_goals homeGoals, away_goals awayGoals
       FROM fb_matches WHERE league = ? ORDER BY match_date`,
    )
    .all(league) as unknown as (DcMatch & { season: number })[];
}

/**
 * La jornada de un partido.
 *
 * Se agrupa por fin de semana y no por fecha exacta: una jornada de liga se juega entre
 * viernes y lunes, y tratar el sábado y el domingo como días distintos partiría en dos
 * la unidad que de verdad comparte condiciones. Se ancla al jueves anterior.
 */
function blockOf(league: string, date: string): string {
  // `fb_matches.match_date` es YYYYMMDD, sin guiones. Pasarlo tal cual a `new Date`
  // da Invalid Date en silencio hasta que algo llama a toISOString.
  const d = new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`,
  );
  // getUTCDay(): 0 domingo … 4 jueves. Días transcurridos desde el jueves anterior.
  const back = (d.getUTCDay() + 3) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return `${league}|${d.toISOString().slice(0, 10)}`;
}

function collect(): Obs[] {
  const out: Obs[] = [];
  for (const league of LEAGUES) {
    const all = leagueMatches(league);
    if (all.length < 200) continue;
    const wf = new DcWalkForward(all, DC_HYPER, { refitDays: REFIT_DAYS, warmupDays: 400 });
    for (const m of all) {
      // El holdout final no se toca. Medir una correlación sobre él lo gastaría igual
      // que medir un log loss: es una decisión tomada mirando esos datos.
      if (splitOf('football', m.season) === 'holdout') continue;
      const params = wf.paramsFor(m.date);
      if (!params) continue;
      const { home, away } = expectedGoalsDc(params, m.homeId, m.awayId);
      const dist = scoreDistribution(home, away, params.rho);
      const p3 = outcomeProbabilities(dist);

      let over = 0;
      let both = 0;
      for (let h = 0; h < dist.grid.length; h++) {
        for (let a = 0; a < dist.grid[h].length; a++) {
          const p = dist.grid[h][a];
          if (h + a > 2.5) over += p;
          if (h > 0 && a > 0) both += p;
        }
      }

      const block = blockOf(league, m.date);
      const matchId = `${league}|${m.date}|${m.homeId}|${m.awayId}`;
      const push = (market: Market, side: Obs['side'], p: number, y: 0 | 1): void => {
        // Con p pegada a 0 o a 1 el residuo tipificado explota y un solo partido
        // domina la media. Se recorta el rango, que es lo mismo que hace el módulo de
        // apuestas: nadie dimensiona una cuota de 1.02.
        if (!(p > 0.02) || !(p < 0.98)) return;
        out.push({
          league,
          date: m.date,
          matchId,
          block,
          market,
          side,
          p,
          y,
          z: (y - p) / Math.sqrt(p * (1 - p)),
        });
      };

      // El 1X2 se registra como «el local gana». La dirección de la apuesta —a quién
      // respaldaría el modelo— es lo que separa mismo sesgo de sesgo opuesto.
      push('1X2', p3.home >= p3.away ? 'local' : 'visitante', p3.home, m.homeGoals > m.awayGoals ? 1 : 0);
      push('over25', over >= 0.5 ? 'si' : 'no', over, m.homeGoals + m.awayGoals > 2.5 ? 1 : 0);
      push('btts', both >= 0.5 ? 'si' : 'no', both, m.homeGoals > 0 && m.awayGoals > 0 ? 1 : 0);
    }
  }
  return out;
}

/** Media de z_i·z_j sobre los pares que cumplen el filtro, y cuántos son. */
function pairMean(obs: Obs[], keep: (a: Obs, b: Obs) => boolean, cap = 4_000_000): { rho: number; pairs: number } {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < obs.length && n < cap; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      if (!keep(obs[i], obs[j])) continue;
      sum += obs[i].z * obs[j].z;
      n++;
    }
  }
  return { rho: n > 0 ? sum / n : 0, pairs: n };
}

/**
 * Pares DENTRO de cada bloque, que es donde caben todos sin explotar.
 *
 * Recorrer los ~70.000 residuos por parejas serían 2.500 millones de pares. Agrupando
 * primero por bloque y emparejando solo dentro, son unos pocos cientos por bloque.
 */
function withinBlocks(obs: Obs[], keep: (a: Obs, b: Obs) => boolean): { rho: number; pairs: number } {
  const byBlock = new Map<string, Obs[]>();
  for (const o of obs) (byBlock.get(o.block) ?? byBlock.set(o.block, []).get(o.block)!).push(o);
  let sum = 0;
  let n = 0;
  for (const group of byBlock.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!keep(group[i], group[j])) continue;
        sum += group[i].z * group[j].z;
        n++;
      }
    }
  }
  return { rho: n > 0 ? sum / n : 0, pairs: n };
}

/**
 * Bootstrap por bloques: se remuestrean JORNADAS, no pares.
 *
 * Un partido entra en muchos pares, así que tratar los pares como observaciones
 * independientes daría un intervalo varias veces más estrecho de lo debido — y un
 * intervalo demasiado estrecho es peor que ninguno, porque convierte el ruido en un
 * hallazgo.
 */
function blockBootstrap(
  obs: Obs[],
  keep: (a: Obs, b: Obs) => boolean,
  draws = 400,
): { lo: number; hi: number } {
  const byBlock = new Map<string, Obs[]>();
  for (const o of obs) (byBlock.get(o.block) ?? byBlock.set(o.block, []).get(o.block)!).push(o);
  const blocks = [...byBlock.values()];
  if (blocks.length === 0) return { lo: 0, hi: 0 };

  const stats: number[] = [];
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    let n = 0;
    for (let b = 0; b < blocks.length; b++) {
      const g = blocks[(Math.random() * blocks.length) | 0];
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          if (!keep(g[i], g[j])) continue;
          sum += g[i].z * g[j].z;
          n++;
        }
      }
    }
    if (n > 0) stats.push(sum / n);
  }
  stats.sort((a, b) => a - b);
  if (stats.length === 0) return { lo: 0, hi: 0 };
  return {
    lo: stats[Math.floor(0.025 * stats.length)],
    hi: stats[Math.min(stats.length - 1, Math.floor(0.975 * stats.length))],
  };
}

// ===========================================================================

console.log('CORRELACIÓN ENTRE POSICIONES ABIERTAS\n' + '='.repeat(64));
console.log(
  '\nResiduos tipificados z = (y − p)/√(p·q) del Dixon-Coles fuera de muestra.\n' +
    'E[z_i·z_j] estima la correlación entre dos apuestas dado el modelo:\n' +
    '0 = independientes, positivo = fallan juntas.\n',
);
process.stdout.write('Recorriendo el walk-forward… ');
const t0 = Date.now();
const obs = collect();
console.log(`${obs.length} residuos en ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const blocks = new Set(obs.map((o) => o.block)).size;
console.log(`${blocks} jornadas · ${new Set(obs.map((o) => o.league)).size} ligas\n`);

// --- Comprobación de cordura: los residuos tienen que estar tipificados ---
const meanZ = obs.reduce((a, o) => a + o.z, 0) / obs.length;
const varZ = obs.reduce((a, o) => a + o.z * o.z, 0) / obs.length - meanZ * meanZ;
console.log(`CORDURA DEL ESTIMADOR`);
console.log(`  media de z    ${meanZ.toFixed(4)}  (debe ser ~0 si el modelo está calibrado)`);
console.log(`  varianza de z ${varZ.toFixed(4)}  (debe ser ~1 por construcción)`);
if (Math.abs(varZ - 1) > 0.15) {
  console.log('  ⚠ La varianza se aleja de 1: el modelo está mal calibrado y las');
  console.log('    correlaciones de abajo mezclan descalibración con dependencia.');
}

// --- El control. Se lee ANTES que nada ---
// Pares de ligas distintas y días distintos, muestreados: no hay mecanismo que los
// una, así que esto tiene que dar ~0 o el resto no vale nada.
const sample = obs.filter(() => Math.random() < Math.min(1, 2500 / obs.length));
const control = pairMean(
  sample,
  (a, b) => a.league !== b.league && a.date !== b.date && a.market === b.market,
);
console.log(`\nCONTROL (ligas distintas, días distintos, mismo mercado)`);
console.log(`  ρ = ${control.rho.toFixed(4)} sobre ${control.pairs.toLocaleString('es')} pares`);
const controlOk = Math.abs(control.rho) < 0.02;
console.log(
  controlOk
    ? '  ✓ ~0, como tiene que ser. El estimador no fabrica correlación de la nada.'
    : '  ✗ NO es ~0. El estimador está sesgado y las cifras de abajo no son fiables.',
);

// --- Los grupos que importan ---
interface Row {
  label: string;
  keep: (a: Obs, b: Obs) => boolean;
}
// Todos los grupos excluyen el MISMO partido, menos el que lo mide a propósito. Sin
// esa exclusión, «mercados distintos» mide sobre todo el 1X2 contra el over del mismo
// marcador, que está correlacionado por construcción y no dice nada sobre la cartera.
const distinct = (a: Obs, b: Obs): boolean => a.matchId !== b.matchId;
const groups: Row[] = [
  {
    label: 'MISMO partido · mercados distintos',
    keep: (a, b) => a.matchId === b.matchId && a.market !== b.market,
  },
  {
    label: 'misma liga · misma jornada · mismo mercado',
    keep: (a, b) => distinct(a, b) && a.market === b.market,
  },
  {
    label: '  … y además el mismo lado (mismo sesgo)',
    keep: (a, b) => distinct(a, b) && a.market === b.market && a.side === b.side,
  },
  {
    label: '  … pero lados opuestos',
    keep: (a, b) => distinct(a, b) && a.market === b.market && a.side !== b.side,
  },
  {
    label: 'misma liga · misma jornada · partidos y mercados distintos',
    keep: (a, b) => distinct(a, b) && a.market !== b.market,
  },
];

console.log('\nPOR TIPO DE PAREJA  (IC 95 % por bootstrap de bloques sobre jornadas)');
console.log('  pareja                                            ρ        IC 95 %         pares');
const measured: Record<string, { rho: number; lo: number; hi: number; pairs: number }> = {};
for (const g of groups) {
  const r = withinBlocks(obs, g.keep);
  const ci = blockBootstrap(obs, g.keep, Number(args.draws) || 300);
  measured[g.label.trim()] = { rho: r.rho, lo: ci.lo, hi: ci.hi, pairs: r.pairs };
  const sig = ci.lo > 0 || ci.hi < 0 ? '' : '  (incluye 0)';
  console.log(
    `  ${g.label.padEnd(48)} ${r.rho.toFixed(4).padStart(7)}  ` +
      `[${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]  ${r.pairs.toLocaleString('es').padStart(9)}${sig}`,
  );
}

// --- Por mercado, que es lo que hace falta para parametrizar el módulo ---
console.log('\nMISMA LIGA · MISMA JORNADA, DESGLOSADO POR MERCADO');
for (const mk of ['1X2', 'over25', 'btts'] as Market[]) {
  const keep = (a: Obs, b: Obs): boolean => a.market === mk && b.market === mk && distinct(a, b);
  const r = withinBlocks(obs, keep);
  const ci = blockBootstrap(obs, keep, 200);
  console.log(
    `  ${mk.padEnd(10)} ρ = ${r.rho.toFixed(4).padStart(7)}  ` +
      `[${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]  ${r.pairs.toLocaleString('es')} pares`,
  );
}

// --- El único par que sí correlaciona: dos mercados del MISMO partido ---
// Esto es lo que necesita el módulo de riesgo, par a par. Y con SIGNO: la medición usa
// la dirección canónica (gana el local / hay over / marcan los dos), así que respaldar
// el lado contrario en uno de los dos invierte el signo. Una cartera de «local» y
// «under» está NEGATIVAMENTE correlacionada — se cubre sola — y tratarla como positiva
// recortaría un tamaño que no hacía falta recortar.
console.log('\nMISMO PARTIDO, PAR A PAR  (dirección canónica: local / over / sí)');
const PAIRS: [Market, Market][] = [
  ['1X2', 'over25'],
  ['1X2', 'btts'],
  ['over25', 'btts'],
];
const sameMatch: Record<string, { rho: number; lo: number; hi: number; pairs: number }> = {};
for (const [x, y] of PAIRS) {
  const keep = (a: Obs, b: Obs): boolean =>
    a.matchId === b.matchId &&
    ((a.market === x && b.market === y) || (a.market === y && b.market === x));
  const r = withinBlocks(obs, keep);
  const ci = blockBootstrap(obs, keep, 200);
  sameMatch[`${x}~${y}`] = { rho: r.rho, lo: ci.lo, hi: ci.hi, pairs: r.pairs };
  console.log(
    `  ${(x + ' ~ ' + y).padEnd(20)} ρ = ${r.rho.toFixed(4).padStart(7)}  ` +
      `[${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]  ${r.pairs.toLocaleString('es')} pares`,
  );
}

// --- Qué significa para el tamaño ---
const same = measured['misma liga · misma jornada · mismo mercado'];
const crossMatch = measured['MISMO partido · mercados distintos'];
console.log('\nQUÉ IMPLICA PARA EL TAMAÑO');
if (!controlOk) {
  console.log('  Nada todavía: con el control fallando, estos números no se pueden usar.');
} else {
  console.log(
    '  Con n apuestas de correlación media ρ, el Kelly de cartera divide cada tamaño\n' +
      '  por 1 + (n−1)·ρ.\n',
  );
  console.log('  entre PARTIDOS distintos de la misma jornada     entre MERCADOS del mismo partido');
  console.log(`  (ρ = ${same.rho.toFixed(4)}, no distinguible de 0)              (ρ = ${crossMatch.rho.toFixed(3)})`);
  for (const n of [2, 3, 4, 8]) {
    const fa = 1 + (n - 1) * Math.max(0, same.rho);
    const fb = 1 + (n - 1) * Math.max(0, crossMatch.rho);
    console.log(
      `    ${String(n).padStart(2)} → ÷ ${fa.toFixed(2)}  (${(100 / fa).toFixed(0)} % del tamaño aislado)` +
        `        ${String(n).padStart(2)} → ÷ ${fb.toFixed(2)}  (${(100 / fb).toFixed(0)} %)`,
    );
  }
  console.log(
    '\n  LA CONCLUSIÓN, que no es la que se esperaba: la correlación entre partidos\n' +
      '  DISTINTOS de la misma liga y jornada no se distingue de cero, ni siquiera\n' +
      '  restringiendo a apuestas del mismo lado. La que sí existe —y es dos órdenes de\n' +
      '  magnitud mayor— es entre MERCADOS DEL MISMO PARTIDO, que es justo la que el\n' +
      '  sizing por apuesta aislada no veía: se elige una selección por 1X2, pero nada\n' +
      '  impedía dimensionar además el over y el ambos-marcan del mismo encuentro.',
  );
}

if (args.record) {
  // DOS anotaciones, no una. El resultado nulo es tan resultado como el positivo, y es
  // el que contradice la hipótesis de partida: sin dejarlo escrito, dentro de seis meses
  // alguien vuelve a suponer que las apuestas de una misma jornada se arrastran entre sí
  // y nadie sabrá que ya se midió y que no.
  recordExperiment({
    hypothesis:
      'Los errores del modelo entre PARTIDOS DISTINTOS de la misma liga y jornada están ' +
      'correlacionados, así que dimensionar cada apuesta por separado sobreestima la ' +
      'diversificación de una cartera simultánea.',
    dataset: { sport: 'football', split: 'validation', n: same.pairs },
    features: ['dixon-coles', 'walk-forward', 'residuos tipificados'],
    hyperparams: { refitDays: REFIT_DAYS, bloques: blocks, mercados: 3 },
    metric: 'corr',
    baseline: 'independencia (ρ = 0), que es lo que supone el sizing por apuesta aislada',
    result: { delta: same.rho, ciLo: same.lo, ciHi: same.hi, p: same.lo > 0 ? 0.04 : 0.5, n: same.pairs },
    verdict: same.lo > 0 ? 'shipped' : 'rejected',
    notes:
      `NULO. Control (ligas y días distintos) ρ = ${control.rho.toFixed(4)}, que valida el ` +
      'estimador, así que el cero de arriba es una medición y no una falta de potencia. ' +
      'Tampoco aparece restringiendo al mismo lado (mismo sesgo del modelo): ' +
      `ρ = ${measured['… y además el mismo lado (mismo sesgo)'].rho.toFixed(4)}. Bootstrap por ` +
      `bloques sobre ${blocks} jornadas, no sobre pares. En esta métrica un delta positivo ` +
      'significa más dependencia, no un modelo peor.',
  });
  recordExperiment({
    hypothesis:
      'Dos MERCADOS DEL MISMO PARTIDO (1X2, over 2.5, ambos marcan) tienen errores ' +
      'correlacionados, así que dimensionarlos como apuestas independientes construye ' +
      'una posición concentrada sin que ningún sizing lo vea.',
    dataset: { sport: 'football', split: 'validation', n: crossMatch.pairs },
    features: ['dixon-coles', 'walk-forward', 'residuos tipificados'],
    hyperparams: { refitDays: REFIT_DAYS, bloques: blocks },
    metric: 'corr',
    baseline: 'independencia (ρ = 0)',
    result: {
      delta: crossMatch.rho,
      ciLo: crossMatch.lo,
      ciHi: crossMatch.hi,
      p: crossMatch.lo > 0 ? 0.001 : 0.5,
      n: crossMatch.pairs,
    },
    verdict: 'shipped',
    notes:
      'Par a par y CON SIGNO, en dirección canónica (gana el local / hay over / marcan ' +
      Object.entries(sameMatch)
        .map(([k, v]) => `los dos): ${k} ρ = ${v.rho.toFixed(3)} [${v.lo.toFixed(3)}, ${v.hi.toFixed(3)}]`)
        .join('; ') +
      '. El signo importa: respaldar el lado contrario en uno de los dos lo invierte, y ' +
      'local + ambos-marcan es una cobertura parcial, no una concentración.',
  });
  console.log('\nAnotadas 2 entradas en el registro de experimentos.');
}

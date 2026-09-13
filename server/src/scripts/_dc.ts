// ¿El Dixon-Coles jerárquico le gana al modelo que hay? Walk-forward, y sin trampas.
//
// CLI: `npm run study:dc`
//
// ===========================================================================
// CÓMO SE EVALÚA UN MODELO QUE HAY QUE REAJUSTAR
// ===========================================================================
// El modelo de Elo se actualiza partido a partido y por eso el backtest es directo:
// cuando llega a un partido, los ratings solo han visto los anteriores. Un Dixon-Coles
// se AJUSTA sobre un bloque de historia, así que hay que decidir cada cuánto se
// reajusta — y ahí es facilísimo hacer trampa sin querer.
//
// La trampa sería ajustar una vez con todo el archivo y puntuar sobre él. Aquí se
// reajusta cada N días usando SOLO los partidos anteriores a esa fecha, y con esos
// parámetros se predicen los partidos hasta el siguiente reajuste. Ningún partido se
// puntúa con un modelo que lo haya visto.
//
// El arranque en caliente es lo que lo hace viable: partiendo del ajuste de hace dos
// semanas bastan 60 iteraciones en vez de 400.
//
// ===========================================================================
// LOS HIPERPARÁMETROS SE ELIGEN SIN MIRAR LA VALIDACIÓN
// ===========================================================================
// ξ (decay) y σ (encogimiento) se buscan puntuando temporadas de ENTRENAMIENTO. La de
// validación no se toca hasta que la combinación ya está decidida, y el holdout final
// no se toca en absoluto. Si se eligiera mirando la validación, el número final sería
// el del conjunto sobre el que se optimizó — que es exactamente el error que el
// registro de experimentos existe para hacer visible.

import {
  scoreDistribution,
  outcomeProbabilities,
  DIXON_COLES_RHO,
} from '../football/model.ts';
import { loadMatches, replayMatches } from '../football/ratings.ts';
import {
  expectedGoalsDc,
  type DcHyper,
  type DcMatch,
} from '../football/bayes/dixonColes.ts';
import { DcWalkForward } from '../football/bayes/walkforward.ts';
import { footballConfig } from '../config.ts';
import { getDb } from '../db.ts';
import { splitOf, VALIDATION_SEASON, FINAL_HOLDOUT_FROM } from '../experiments/holdout.ts';
import { recordExperiment, bootstrapP, familySize } from '../experiments/registry.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1]]] : [])),
) as Record<string, string>;

/** Cada cuántos días se reajusta el modelo en el walk-forward. */
const REFIT_DAYS = Number(args.refit) || 14;

const LEAGUES = footballConfig.leagues.map((l) => l.id);

/** Todos los partidos de una liga, en el formato del ajuste. */
function leagueMatches(league: string): (DcMatch & { season: number })[] {
  return getDb()
    .prepare(
      `SELECT match_date date, season, home_id homeId, away_id awayId,
              home_goals homeGoals, away_goals awayGoals
       FROM fb_matches WHERE league = ? ORDER BY match_date`,
    )
    .all(league) as unknown as (DcMatch & { season: number })[];
}

interface Scored {
  key: string;
  /** Log loss del resultado a tres bandas. */
  outcome: number;
  /** Log loss del MARCADOR EXACTO. Es la métrica que juzga la rejilla entera. */
  scoreline: number;
  /**
   * Los mercados que se DERIVAN de la rejilla, cada uno con su log loss binario.
   *
   * Están aquí porque son el motivo de todo esto. Un modelo puede empatar en el 1X2 y
   * ser mucho mejor en el over/under: el resultado depende del signo de la diferencia
   * de goles y estos dependen de la forma entera de la distribución. Sin medirlos por
   * separado, una mejora que vive justo ahí queda escondida detrás de un 1X2 plano.
   */
  over25: number;
  btts: number;
  /** Hándicap asiático de −1 para el local: gana si vence por 2 o más. */
  handicap: number;
}

/**
 * Walk-forward del Dixon-Coles sobre las temporadas pedidas.
 *
 * `warmup` deja fuera el arranque de cada liga: los primeros meses no tienen historia
 * suficiente para ajustar nada y puntuarlos mete ruido común que aplasta las
 * diferencias entre configuraciones.
 */
function evaluateDc(hyper: DcHyper, seasons: (s: number) => boolean, warmupDays = 400): Scored[] {
  const out: Scored[] = [];
  for (const league of LEAGUES) {
    const all = leagueMatches(league);
    if (all.length < 200) continue;
    // La regla de «solo el pasado» vive en DcWalkForward, compartida con el backtest:
    // dos copias del bucle son dos sitios donde se puede romper por separado.
    const wf = new DcWalkForward(all, hyper, { refitDays: REFIT_DAYS, warmupDays });

    for (const m of all) {
      if (splitOf('football', m.season) === 'holdout') continue;
      if (!seasons(m.season)) continue;
      const params = wf.paramsFor(m.date);
      if (!params) continue;
      const { home, away } = expectedGoalsDc(params, m.homeId, m.awayId);
      const dist = scoreDistribution(home, away, params.rho);
      const p3 = outcomeProbabilities(dist);
      const res =
        m.homeGoals > m.awayGoals ? p3.home : m.homeGoals === m.awayGoals ? p3.draw : p3.away;
      const cell = dist.grid[Math.min(m.homeGoals, dist.grid.length - 1)]?.[
        Math.min(m.awayGoals, dist.grid.length - 1)
      ];
      out.push({
        key: `${league}|${m.date}|${m.homeId}|${m.awayId}`,
        outcome: -Math.log(Math.max(res, 1e-9)),
        scoreline: -Math.log(Math.max(cell ?? 1e-9, 1e-9)),
        ...derived(dist, m.homeGoals, m.awayGoals),
      });
    }
  }
  return out;
}

/** El modelo que se publica hoy, sobre los mismos partidos. */
function evaluateCurrent(seasons: (s: number) => boolean): Map<string, Scored> {
  const out = new Map<string, Scored>();
  for (const league of LEAGUES) {
    const matches = loadMatches(league as never, 0);
    if (matches.length === 0) continue;
    replayMatches(matches, {
      onMatch: ({ match, home, away, lambda }) => {
        if (home.matches < 10 || away.matches < 10) return;
        const season = Number(match.season);
        if (splitOf('football', season) === 'holdout' || !seasons(season)) return;
        const dist = scoreDistribution(lambda.home, lambda.away, DIXON_COLES_RHO);
        const p3 = outcomeProbabilities(dist);
        const res =
          match.home_goals > match.away_goals
            ? p3.home
            : match.home_goals === match.away_goals
              ? p3.draw
              : p3.away;
        const cell = dist.grid[Math.min(match.home_goals, dist.grid.length - 1)]?.[
          Math.min(match.away_goals, dist.grid.length - 1)
        ];
        out.set(`${league}|${match.match_date}|${match.home_id}|${match.away_id}`, {
          key: '',
          outcome: -Math.log(Math.max(res, 1e-9)),
          scoreline: -Math.log(Math.max(cell ?? 1e-9, 1e-9)),
          ...derived(dist, match.home_goals, match.away_goals),
        });
      },
    });
  }
  return out;
}

/**
 * Los mercados derivados de la rejilla, con su log loss binario.
 *
 * Se calculan sumando celdas de la MISMA distribución que produce el 1X2, que es la
 * propiedad que hace que todos los números de una tarjeta sean coherentes entre sí. Si
 * el over/under saliera de otro sitio, podría contradecir al marcador más probable.
 */
function derived(
  dist: { grid: number[][] },
  homeGoals: number,
  awayGoals: number,
): { over25: number; btts: number; handicap: number } {
  let over = 0;
  let both = 0;
  let hcp = 0;
  for (let h = 0; h < dist.grid.length; h++) {
    for (let a = 0; a < dist.grid[h].length; a++) {
      const p = dist.grid[h][a];
      if (h + a > 2.5) over += p;
      if (h > 0 && a > 0) both += p;
      // Hándicap −1 al local: cubre si gana por 2 o más. El empate exacto a 1 de
      // diferencia es nulo en el mercado real; aquí se puntúa como no-cubierto, que
      // es la convención más simple y la misma para los dos modelos.
      if (h - a >= 2) hcp += p;
    }
  }
  const bin = (p: number, hit: boolean): number =>
    -Math.log(Math.max(hit ? p : 1 - p, 1e-9));
  return {
    over25: bin(over, homeGoals + awayGoals > 2.5),
    btts: bin(both, homeGoals > 0 && awayGoals > 0),
    handicap: bin(hcp, homeGoals - awayGoals >= 2),
  };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Bootstrap emparejado sobre las diferencias por partido. */
function paired(a: number[], b: number[]): { mean: number; lo: number; hi: number; p: number } {
  const d = a.map((x, i) => b[i] - x);
  const m = mean(d);
  let seed = 13371337;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // 4.000 remuestreos y no 500. Con 500 el p más pequeño que se puede expresar es
  // 2/501 = 0.004, así que un resultado contundente y otro justo en el límite salen
  // con el mismo número — y ese número se compara luego contra un umbral de
  // Bonferroni del orden de 0.004. Medir con una regla cuya última marca es
  // justamente el umbral no sirve para decidir nada.
  const iters = 4000;
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let k = 0; k < d.length; k++) s += d[(rnd() * d.length) | 0];
    means.push(s / d.length);
  }
  const sorted = [...means].sort((x, y) => x - y);
  return {
    mean: m,
    lo: sorted[Math.floor(iters * 0.025)],
    hi: sorted[Math.floor(iters * 0.975)],
    p: bootstrapP(means),
  };
}

// ===========================================================================
console.log(
  `Dixon-Coles jerárquico · reajuste cada ${REFIT_DAYS} días · ` +
    `validación ${VALIDATION_SEASON.football} · holdout desde ${FINAL_HOLDOUT_FROM.football} (cerrado)\n`,
);

// --- 1. Hiperparámetros, elegidos con temporadas de ENTRENAMIENTO ---
const TRAIN = (s: number) => s >= 2023 && s < VALIDATION_SEASON.football;
console.log('BUSCA DE HIPERPARÁMETROS (solo entrenamiento, 2023–2024)');
console.log('  semivida    σ      n      log loss 1X2   log loss marcador');
const XIS: [string, number][] = [
  ['sin decay', 0],
  ['2 años', Math.LN2 / 730],
  ['1 año', Math.LN2 / 365],
  ['6 meses', Math.LN2 / 182],
];
const SIGMAS = [0.15, 0.3, 0.6];
let best: { hyper: DcHyper; ll: number; label: string } | null = null;
for (const [label, xi] of XIS) {
  for (const sigma of SIGMAS) {
    const hyper: DcHyper = { xi, sigmaAttack: sigma, sigmaDefence: sigma };
    const r = evaluateDc(hyper, TRAIN);
    if (r.length === 0) continue;
    const ll = mean(r.map((x) => x.outcome));
    const sl = mean(r.map((x) => x.scoreline));
    console.log(
      `  ${label.padEnd(11)} ${sigma.toFixed(2)}  ${String(r.length).padStart(5)}   ` +
        `${ll.toFixed(5)}        ${sl.toFixed(5)}`,
    );
    if (!best || ll < best.ll) best = { hyper, ll, label: `${label} / σ ${sigma}` };
  }
}
if (!best) {
  console.log('sin datos suficientes');
  process.exit(1);
}
console.log(`\n  Elegido: ${best.label}  (ξ = ${best.hyper.xi.toFixed(5)})`);

// --- 2. La validación, una sola vez, con la configuración ya decidida ---
const VAL = (s: number) => s === VALIDATION_SEASON.football;
console.log(`\nVALIDACIÓN ${VALIDATION_SEASON.football} — no se ha mirado hasta ahora`);
const dc = evaluateDc(best.hyper, VAL);
const cur = evaluateCurrent(VAL);

// Solo los partidos que los DOS puntuaron: comparar sobre conjuntos distintos no es
// una comparación pareada y el intervalo dejaría de significar nada.
const both = dc.filter((d) => cur.has(d.key));
const curOutcome = both.map((d) => cur.get(d.key)!.outcome);
const curScore = both.map((d) => cur.get(d.key)!.scoreline);
const dcOutcome = both.map((d) => d.outcome);
const dcScore = both.map((d) => d.scoreline);

console.log(`  ${both.length} partidos puntuados por los dos modelos\n`);
console.log('  modelo                 log loss 1X2   log loss marcador');
console.log(`  actual (Elo → λ)        ${mean(curOutcome).toFixed(5)}        ${mean(curScore).toFixed(5)}`);
console.log(`  Dixon-Coles jerárquico  ${mean(dcOutcome).toFixed(5)}        ${mean(dcScore).toFixed(5)}`);

const dOut = paired(curOutcome, dcOutcome);
const dScore = paired(curScore, dcScore);
console.log(
  `\n  1X2:       ${(dOut.mean >= 0 ? '+' : '') + dOut.mean.toFixed(5)}  ` +
    `IC 95 % [${dOut.lo.toFixed(5)}, ${dOut.hi.toFixed(5)}]  p = ${dOut.p.toFixed(4)}`,
);
console.log(
  `  marcador:  ${(dScore.mean >= 0 ? '+' : '') + dScore.mean.toFixed(5)}  ` +
    `IC 95 % [${dScore.lo.toFixed(5)}, ${dScore.hi.toFixed(5)}]  p = ${dScore.p.toFixed(4)}`,
);
console.log(
  dOut.hi < 0
    ? '\n  → MEJOR en el 1X2, y el intervalo entero por debajo de cero.'
    : dOut.lo > 0
      ? '\n  → PEOR en el 1X2 de forma significativa.'
      : '\n  → En el 1X2 es indistinguible del modelo actual.',
);
console.log(
  dScore.hi < 0
    ? '  → MEJOR en el marcador exacto, que es lo que juzga la rejilla entera.'
    : dScore.lo > 0
      ? '  → PEOR en el marcador exacto.'
      : '  → En el marcador exacto es indistinguible.',
);

// ---- los mercados derivados, que son el motivo del cambio ----
console.log('\n  MERCADOS DERIVADOS DE LA REJILLA (log loss binario)');
console.log('  mercado            actual    Dixon-Coles   diferencia            p');
const markets: [string, (s: Scored) => number][] = [
  ['más de 2.5 goles', (x) => x.over25],
  ['ambos marcan', (x) => x.btts],
  ['hándicap −1 local', (x) => x.handicap],
];
const derivedResults: { label: string; diff: ReturnType<typeof paired> }[] = [];
for (const [label, pick] of markets) {
  const a = both.map((d) => pick(cur.get(d.key)!));
  const b = both.map(pick);
  const diff = paired(a, b);
  const verdict = diff.hi < 0 ? 'mejor' : diff.lo > 0 ? 'PEOR' : 'igual';
  console.log(
    `  ${label.padEnd(18)} ${mean(a).toFixed(5)}   ${mean(b).toFixed(5)}   ` +
      `${(diff.mean >= 0 ? '+' : '') + diff.mean.toFixed(5)} ${verdict.padEnd(6)} ${diff.p.toFixed(4)}`,
  );
  derivedResults.push({ label, diff });
}

const k = familySize({ sport: 'football', split: 'validation', n: both.length });
console.log(`\n  Experimentos previos sobre este conjunto: ${k}. Ver \`npm run experiments\`.`);

if (args.record !== 'false') {
  // ===========================================================================
  // POR QUÉ LOS CINCO VAN COMO 'shipped', INCLUSO LOS QUE NO CONVENCEN
  // ===========================================================================
  // 'shipped' en este registro quiere decir «esto es lo que hace producción», no
  // «esto salió bien». Y producción usa la MISMA rejilla del Dixon-Coles para las
  // cinco salidas: no se puede enviar el marcador exacto y dejar el 1X2 con el
  // modelo viejo, es un solo modelo.
  //
  // Marcar el 1X2 como 'inconclusive' porque p = 0.054 lo sacaría de la lista de
  // avisos de `npm run experiments` — que es justo la lista donde tiene que estar:
  // se ha cambiado el modelo de predicción entero y el resultado a tres bandas, que
  // es el número que mira la gente, NO ha mejorado de forma medible. Eso se enseña.
  recordExperiment({
    hypothesis: 'el Dixon-Coles jerárquico mejora el log loss del 1X2 sobre el modelo de Elo',
    dataset: { sport: 'football', split: 'validation', n: both.length },
    features: ['dixon-coles', 'ataque-defensa', 'decay-temporal', 'priors-jerarquicos'],
    hyperparams: {
      xi: best.hyper.xi,
      sigma: best.hyper.sigmaAttack,
      refitDays: REFIT_DAYS,
      elegidoCon: 'temporadas 2023-2024',
    },
    metric: 'logloss',
    baseline: 'modelo publicado (Elo → λ)',
    result: { delta: dOut.mean, ciLo: dOut.lo, ciHi: dOut.hi, p: dOut.p, n: both.length },
    verdict: 'shipped',
    notes:
      `El 1X2 NO es el motivo del cambio y por sí solo no lo justificaría. ` +
      `Marcador exacto: ${dScore.mean.toFixed(5)} [${dScore.lo.toFixed(5)}, ${dScore.hi.toFixed(5)}], p = ${dScore.p.toFixed(4)}.`,
  });
  recordExperiment({
    hypothesis: 'el Dixon-Coles jerárquico mejora el log loss del MARCADOR EXACTO',
    dataset: { sport: 'football', split: 'validation', n: both.length },
    features: ['dixon-coles', 'ataque-defensa', 'decay-temporal', 'priors-jerarquicos'],
    hyperparams: {
      xi: best.hyper.xi,
      sigma: best.hyper.sigmaAttack,
      refitDays: REFIT_DAYS,
    },
    metric: 'logloss',
    baseline: 'modelo publicado (Elo → λ)',
    result: { delta: dScore.mean, ciLo: dScore.lo, ciHi: dScore.hi, p: dScore.p, n: both.length },
    verdict: 'shipped',
    notes:
      'La rejilla completa es de donde salen over/under, ambos marcan y hándicaps, así ' +
      'que esta métrica es la que juzga esos mercados y no solo el resultado.',
  });
  // Los tres mercados derivados van al registro cada uno por su lado. Son tres
  // comparaciones más sobre los MISMOS partidos, y esconderlas para que el
  // denominador de Bonferroni salga más pequeño sería exactamente el truco que el
  // registro existe para impedir.
  for (const { label, diff } of derivedResults) {
    recordExperiment({
      hypothesis: `la rejilla del Dixon-Coles mejora el log loss de «${label}»`,
      dataset: { sport: 'football', split: 'validation', n: both.length },
      features: ['dixon-coles', 'rejilla-de-marcadores', 'mercado-derivado'],
      hyperparams: {
        xi: best.hyper.xi,
        sigma: best.hyper.sigmaAttack,
        refitDays: REFIT_DAYS,
        mercado: label,
      },
      metric: 'logloss',
      baseline: 'rejilla del modelo publicado (Elo → λ, ρ constante)',
      result: { delta: diff.mean, ciLo: diff.lo, ciHi: diff.hi, p: diff.p, n: both.length },
      verdict: 'shipped',
      notes:
        'Derivado de la misma rejilla, no es un modelo aparte: va en producción porque ' +
        'va la rejilla, tenga o no evidencia propia. ' +
        (diff.hi < 0
          ? 'Aquí la tiene.'
          : diff.lo > 0
            ? 'Y aquí la evidencia dice que EMPEORA.'
            : 'Aquí no la tiene: el intervalo contiene el cero.'),
    });
  }
  console.log('  Registrado en experiments/registry.jsonl.');
}
getDb();

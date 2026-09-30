// ¿Convierte bien la app el hándicap de la NFL en probabilidad de victoria?
//
// CLI: `npm run study:nfl-spread` (añade `--record` para apuntarlo en el registro)
//
// ===========================================================================
// POR QUÉ IMPORTA
// ===========================================================================
// En la NFL lo que se enseña es casi el precio: el modelo pesa un 10 % en la mezcla
// porque, medido, es peor que la línea de cierre. Y sin clave de cuotas no hay
// moneyline, así que ese «precio» sale de la LÍNEA DE HÁNDICAP, convertida en
// probabilidad. Esa conversión es, en la práctica, la predicción de la NFL.
//
// Se hacía con la curva del propio modelo (su distribución de márgenes), y es
// demasiado plana: con una línea de 7 puntos decía 69 % y el favorito gana el 75 %;
// con 10 puntos, 76 % contra 82 %. Los favoritos claros salían infravalorados.
//
// ===========================================================================
// MÉTODO
// ===========================================================================
// Curva logística P(gana el local) = 1/(1+e^−(a + b·línea)), ajustada a resultados.
// Walk-forward: para cada temporada de 2010 a 2023 se ajusta con las anteriores y se
// puntúa esa. 3.781 partidos de prueba, emparejados contra la conversión anterior con
// TODO el post-proceso encima (la mezcla con el modelo), que es lo que se enseña. El
// holdout (2024+) no se toca; los coeficientes publicados se ajustan con < 2024.

import { listGamesWithMarket } from '../nfl/repo.ts';
import { replayGames } from '../nfl/ratings.ts';
import { buildDistribution, outcomeProbabilities } from '../nfl/model.ts';
import { SPREAD_WIN_LOGIT } from '../nfl/predict.ts';
import { postprocess } from '../postprocess/apply.ts';
import { FINAL_HOLDOUT_FROM } from '../experiments/holdout.ts';
import { pairedBootstrap, recordExperiment } from '../experiments/registry.ts';

interface Row { season: number; line: number; raw: number; curva: number; y: number }

const rows: Row[] = [];
replayGames(listGamesWithMarket('nfl') as never, {
  onGame: ({ game, expectedMargin, expectedTotal }: {
    game: { season: number; home_points: number; away_points: number; close_spread: number | null };
    expectedMargin: number;
    expectedTotal: number;
  }) => {
    if (game.season >= FINAL_HOLDOUT_FROM.nfl || game.close_spread == null) return;
    const m = game.home_points - game.away_points;
    if (m === 0) return;
    const o = outcomeProbabilities(buildDistribution(expectedMargin, expectedTotal));
    // La conversión ANTERIOR: la línea leída con la distribución del modelo.
    const c = outcomeProbabilities(buildDistribution(game.close_spread, expectedTotal));
    rows.push({
      season: game.season,
      line: game.close_spread, // signo de margen: positivo = local favorito
      raw: o.home / (o.home + o.away),
      curva: c.home / (c.home + c.away),
      y: m > 0 ? 1 : 0,
    });
  },
} as never);

/** Logística de una variable por Newton-Raphson: dos parámetros, converge en pocas vueltas. */
function ajustar(rs: Row[]): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (let it = 0; it < 30; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const r of rs) {
      const p = 1 / (1 + Math.exp(-(a + b * r.line)));
      const w = p * (1 - p);
      ga += r.y - p;
      gb += (r.y - p) * r.line;
      haa += w;
      hab += w * r.line;
      hbb += w * r.line * r.line;
    }
    const det = haa * hbb - hab * hab;
    a += (hbb * ga - hab * gb) / det;
    b += (haa * gb - hab * ga) / det;
  }
  return { a, b };
}
const logit = (c: { a: number; b: number }, line: number): number => 1 / (1 + Math.exp(-(c.a + c.b * line)));
const ll = (p: number, y: number): number => -Math.log(Math.max(1e-9, y ? p : 1 - p));
const final = (raw: number, mk: number): number => postprocess('nfl', [raw, 1 - raw], [mk, 1 - mk]).final[0];

const antes: number[] = [];
const despues: number[] = [];
let aciertoAntes = 0;
let aciertoDespues = 0;
for (let s = 2010; s < FINAL_HOLDOUT_FROM.nfl; s++) {
  const c = ajustar(rows.filter((r) => r.season < s));
  for (const r of rows.filter((x) => x.season === s)) {
    const pa = final(r.raw, r.curva);
    const pd = final(r.raw, logit(c, r.line));
    antes.push(ll(pa, r.y));
    despues.push(ll(pd, r.y));
    if ((pa >= 0.5) === (r.y === 1)) aciertoAntes++;
    if ((pd >= 0.5) === (r.y === 1)) aciertoDespues++;
  }
}
const n = antes.length;
const ci = pairedBootstrap(antes, despues);
const mean = (xs: number[]): number => xs.reduce((x, y) => x + y, 0) / xs.length;
console.log(`Walk-forward 2010–${FINAL_HOLDOUT_FROM.nfl - 1}: ${n.toLocaleString('es')} partidos`);
console.log(`  curva del modelo   log loss ${mean(antes).toFixed(5)}  acierto ${((100 * aciertoAntes) / n).toFixed(1)} %`);
console.log(`  curva ajustada     log loss ${mean(despues).toFixed(5)}  acierto ${((100 * aciertoDespues) / n).toFixed(1)} %`);
console.log(`  Δ ${ci.mean.toFixed(5)}  IC95 [${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}]  p ${ci.p.toFixed(4)}`);

const pub = ajustar(rows);
console.log(`\nCoeficientes con todo < ${FINAL_HOLDOUT_FROM.nfl}: a = ${pub.a.toFixed(4)}, b = ${pub.b.toFixed(4)}`);
console.log(`Publicados en nfl/predict.ts:     a = ${SPREAD_WIN_LOGIT.a}, b = ${SPREAD_WIN_LOGIT.b}`);
console.log('\nlínea   curva del modelo   ajustada   real (±0,5)');
for (const l of [1, 3, 4, 7, 10, 14]) {
  const near = rows.filter((r) => Math.abs(r.line - l) <= 0.5);
  console.log(
    `${String(l).padStart(4)}    ${(100 * mean(near.map((r) => r.curva))).toFixed(1)} %           ` +
      `${(100 * logit(pub, l)).toFixed(1)} %    ${(100 * mean(near.map((r) => r.y))).toFixed(1)} % (n ${near.length})`,
  );
}

if (process.argv.includes('--record')) {
  recordExperiment({
    hypothesis: 'convertir la línea de hándicap de la NFL con una curva logística ajustada a resultados mejora la probabilidad que se enseña',
    dataset: { sport: 'nfl', split: 'validation', n },
    features: ['linea-de-cierre', 'logistica', 'post-proceso'],
    hyperparams: { a: Math.round(pub.a * 1e4) / 1e4, b: Math.round(pub.b * 1e4) / 1e4, esquema: 'walk-forward 2010–2023', boots: 4000 },
    metric: 'logloss',
    baseline: 'línea leída con la distribución de márgenes del modelo',
    result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n },
    verdict: ci.hi < 0 ? 'shipped' : ci.lo > 0 ? 'rejected' : 'inconclusive',
    notes: 'El acierto no cambia (el favorito lo decide el signo de la línea); mejora cuánto se le da: los favoritos claros salían 3–5 pp infravalorados.',
  });
  console.log('→ apuntado en experiments/registry.jsonl');
}

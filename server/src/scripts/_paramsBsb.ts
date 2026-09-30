// ¿Siguen siendo los mejores los parámetros del béisbol?
//
// CLI: `npm run study:params-bsb` (añade `--record` para apuntar cada uno en el registro)
//
// La NBA enseñó que un parámetro elegido sobre todo el archivo puede describir otra
// época. Aquí se revisan uno a uno los del béisbol: se ELIGE cada valor con las
// temporadas hasta 2020 y se CONFIRMA en 2021+ contra el publicado, con bootstrap
// emparejado y corrección de Bonferroni por el número de parámetros revisados.

import { runBacktest } from '../baseball/backtest.ts';
import {
  HOME_ADVANTAGE, K_FACTOR, SEASON_CARRYOVER, RUN_DIFF_WEIGHT, RUN_SENSITIVITY,
  PITCHER_WEIGHT, PITCHER_REGRESSION_STARTS, RUN_DISPERSION,
} from '../baseball/model.ts';
import { pairedBootstrap, recordExperiment, bonferroniAlpha } from '../experiments/registry.ts';

const CORTE = 2021;
type Opts = Parameters<typeof runBacktest>[0];
const PARAMS: { clave: keyof Opts; publicado: number; valores: number[] }[] = [
  { clave: 'homeAdvantage', publicado: HOME_ADVANTAGE, valores: [10, 17, 24, 31, 38] },
  { clave: 'k', publicado: K_FACTOR, valores: [3, 4, 5, 6, 8] },
  { clave: 'carryover', publicado: SEASON_CARRYOVER, valores: [0.6, 0.7, 0.8, 0.9] },
  { clave: 'runDiffWeight', publicado: RUN_DIFF_WEIGHT, valores: [0.6, 0.9, 1.2, 1.5, 1.8] },
  { clave: 'runSensitivity', publicado: RUN_SENSITIVITY, valores: [0.2, 0.225, 0.25, 0.275, 0.3] },
  { clave: 'pitcherWeight', publicado: PITCHER_WEIGHT, valores: [0.35, 0.45, 0.55, 0.65, 0.75] },
  { clave: 'pitcherRegressionStarts', publicado: PITCHER_REGRESSION_STARTS, valores: [8, 15, 25, 40] },
  { clave: 'dispersion', publicado: RUN_DISPERSION, valores: [3, 4.5, 6, 9] },
];

const ll = (p: number, y: number): number => -Math.log(Math.max(1e-12, y ? p : 1 - p));
function correr(o: Partial<Opts>): { season: number; ll: number }[] {
  const preds: { season: number; p: number; y: number }[] = [];
  runBacktest({ park: true, ...o, preds } as Opts);
  return preds.map((x) => ({ season: x.season, ll: ll(x.p, x.y) }));
}
const media = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const base = correr({});
const baseVal = base.filter((r) => r.season >= CORTE).map((r) => r.ll);
console.log(`Béisbol · ${base.length.toLocaleString('es')} partidos · elegir < ${CORTE} · validar ${CORTE}+ (${baseVal.length.toLocaleString('es')})`);
console.log(`Publicado: log loss elegir ${media(base.filter((r) => r.season < CORTE).map((r) => r.ll)).toFixed(5)} · validar ${media(baseVal).toFixed(5)}\n`);
const alpha = bonferroniAlpha(PARAMS.length);
for (const par of PARAMS) {
  const res = par.valores.map((v) => ({ v, rows: v === par.publicado ? base : correr({ [par.clave]: v }) }));
  const linea = res.map((x) => `${x.v}: ${media(x.rows.filter((r) => r.season < CORTE).map((r) => r.ll)).toFixed(5)}`).join('  ');
  const mejor = res.sort((a, b) => media(a.rows.filter((r) => r.season < CORTE).map((r) => r.ll)) - media(b.rows.filter((r) => r.season < CORTE).map((r) => r.ll)))[0];
  console.log(`${String(par.clave).padEnd(24)} publicado ${par.publicado} · elegir → ${linea}`);
  if (mejor.v === par.publicado) {
    console.log(`${''.padEnd(24)} → el publicado ya es el mejor con < ${CORTE}\n`);
    continue;
  }
  const cand = mejor.rows.filter((r) => r.season >= CORTE).map((r) => r.ll);
  const ci = pairedBootstrap(baseVal, cand);
  const pasa = ci.hi < 0 && ci.p < alpha;
  console.log(
    `${''.padEnd(24)} → elegido ${mejor.v}: validar Δ ${ci.mean.toFixed(5)} [${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}] p ${ci.p.toFixed(4)} ` +
      `(listón ${alpha.toFixed(4)}) ${pasa ? 'MEJORA' : 'no concluyente'}\n`,
  );
  if (process.argv.includes('--record')) {
    recordExperiment({
      hypothesis: `béisbol: ${String(par.clave)} = ${mejor.v} mejora el log loss sobre el publicado (${par.publicado})`,
      dataset: { sport: 'baseball', split: 'validation', n: cand.length },
      features: [String(par.clave)],
      hyperparams: { [par.clave]: mejor.v, elegidoCon: `temporadas < ${CORTE}`, familia: PARAMS.length, boots: 4000 },
      metric: 'logloss',
      baseline: `publicado ${par.publicado}`,
      result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n: cand.length },
      verdict: pasa ? 'shipped' : ci.lo > 0 ? 'rejected' : 'inconclusive',
    });
  }
}

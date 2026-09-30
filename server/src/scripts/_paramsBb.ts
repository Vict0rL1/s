// ¿Siguen siendo los mejores los parámetros de la NBA, ahora que la ventaja de campo
// se aprende?
//
// CLI: `npm run study:params-bb` (añade `--record` para apuntar cada uno)
//
// Mismo método que `study:params-bsb`: elegir con temporadas ≤ 2020, confirmar en 2021+
// contra el publicado, bootstrap emparejado, Bonferroni por la familia revisada.

import { loadGames, replayGames, type ReplayOptions } from '../basketball/ratings.ts';
import { K_FACTOR, SEASON_CARRYOVER, CALIBRATION_SCALE, HOME_ADV_RATE } from '../basketball/elo.ts';
import { pairedBootstrap, recordExperiment, bonferroniAlpha } from '../experiments/registry.ts';

const CORTE = 2021;
const games = loadGames('nba', 0);
const PARAMS: { clave: keyof ReplayOptions; publicado: number; valores: number[] }[] = [
  { clave: 'k', publicado: K_FACTOR, valores: [16, 18, 20, 22, 25] },
  { clave: 'carryover', publicado: SEASON_CARRYOVER, valores: [0.6, 0.65, 0.7, 0.75, 0.8, 0.85] },
  { clave: 'movWeight', publicado: 1, valores: [0.5, 0.75, 1, 1.25, 1.5] },
  { clave: 'restWeight', publicado: 1, valores: [0, 0.5, 1, 1.5, 2] },
  { clave: 'calibrationScale', publicado: CALIBRATION_SCALE, valores: [0.9, 0.95, 1, 1.05, 1.1] },
  { clave: 'homeAdvRate', publicado: HOME_ADV_RATE, valores: [0.5, 1, 1.5, 2] },
];
function correr(o: Partial<ReplayOptions>): { season: number; ll: number }[] {
  const out: { season: number; ll: number }[] = [];
  replayGames(games, {
    ...o,
    onGame: ({ game, home, away, probHome }) => {
      if (home.games < 20 || away.games < 20 || game.home_pts === game.away_pts) return;
      const y = game.home_pts > game.away_pts;
      out.push({ season: game.season, ll: -Math.log(Math.max(1e-12, y ? probHome : 1 - probHome)) });
    },
  });
  return out;
}
const media = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const eleg = (rs: { season: number; ll: number }[]): number => media(rs.filter((r) => r.season < CORTE).map((r) => r.ll));
const base = correr({});
const baseVal = base.filter((r) => r.season >= CORTE).map((r) => r.ll);
console.log(`NBA · elegir < ${CORTE} · validar ${CORTE}+ (${baseVal.length}) · publicado: ${eleg(base).toFixed(5)} / ${media(baseVal).toFixed(5)}\n`);
const alpha = bonferroniAlpha(PARAMS.length);
for (const par of PARAMS) {
  const res = par.valores.map((v) => ({ v, rows: v === par.publicado ? base : correr({ [par.clave]: v }) }));
  console.log(`${String(par.clave).padEnd(17)} publicado ${par.publicado} · ` + res.map((x) => `${x.v}: ${eleg(x.rows).toFixed(5)}`).join('  '));
  const mejor = [...res].sort((a, b) => eleg(a.rows) - eleg(b.rows))[0];
  if (mejor.v === par.publicado) { console.log(`${''.padEnd(17)} → el publicado ya es el mejor\n`); continue; }
  const cand = mejor.rows.filter((r) => r.season >= CORTE).map((r) => r.ll);
  const ci = pairedBootstrap(baseVal, cand);
  const pasa = ci.hi < 0 && ci.p < alpha;
  console.log(`${''.padEnd(17)} → elegido ${mejor.v}: validar Δ ${ci.mean.toFixed(5)} [${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}] p ${ci.p.toFixed(4)} (listón ${alpha.toFixed(4)}) ${pasa ? 'MEJORA' : 'no concluyente'}\n`);
  if (process.argv.includes('--record')) {
    recordExperiment({
      hypothesis: `NBA: ${String(par.clave)} = ${mejor.v} mejora el log loss sobre el publicado (${par.publicado})`,
      dataset: { sport: 'basketball', split: 'validation', n: cand.length },
      features: [String(par.clave)],
      hyperparams: { [par.clave]: mejor.v, elegidoCon: `temporadas < ${CORTE}`, familia: PARAMS.length, boots: 4000 },
      metric: 'logloss',
      baseline: `publicado ${par.publicado}`,
      result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n: cand.length },
      verdict: pasa ? 'shipped' : ci.lo > 0 ? 'rejected' : 'inconclusive',
    });
  }
}

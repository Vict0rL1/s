// ¿Debe la ventaja de campo del baloncesto aprenderse en vez de ser una constante?
//
// CLI: `npm run study:home-bb` (añade `--record` para apuntarlo en el registro)
//
// ===========================================================================
// DE DÓNDE SALE LA PREGUNTA
// ===========================================================================
// La constante (100 Elo) está ajustada sobre todo el archivo, y el archivo son 60.000
// partidos anteriores a 2011. Medido, victoria local en la NBA:
//
//     antes de 2011   dice 62,2 %   pasa 62,3 %
//     2011–2020       dice 62,1 %   pasa 59,0 %   (−3,1 pp)
//     2021 en adelante dice 62,4 %  pasa 55,3 %   (−7,0 pp, 12 errores estándar)
//
// La cancha vale menos que antes —viajes, descanso, arbitraje, y el vacío de 2020—, y
// una constante no puede enterarse. El σ del margen ya tuvo el mismo problema y se
// resolvió midiéndolo por época (ver MARGIN_SIGMA); aquí se hace algo más directo: que
// la ventaja se APRENDA partido a partido, igual que los ratings.
//
// ===========================================================================
// MÉTODO
// ===========================================================================
// Se ELIGE la tasa con las temporadas hasta 2020, por log loss, y se CONFIRMA en 2021+
// contra la constante, con bootstrap emparejado por partido. La tasa 0 es la constante.

import { loadGames, replayGames } from '../basketball/ratings.ts';
import { HOME_ADVANTAGE } from '../basketball/elo.ts';
import { pairedBootstrap, recordExperiment } from '../experiments/registry.ts';

const CORTE = 2021;
const WARMUP = 20;
const TASAS = [0, 0.25, 0.5, 1, 2, 4, 8];
const league = process.argv.includes('--league') ? process.argv[process.argv.indexOf('--league') + 1] : 'nba';

interface Row { ll: number; p: number; y: number; val: boolean }
const games = loadGames(league, 0);

function run(rate: number): { rows: Row[]; final: number; porTemporada: Map<number, number> } {
  const rows: Row[] = [];
  let final = HOME_ADVANTAGE;
  const porTemporada = new Map<number, number>();
  replayGames(games, {
    homeAdvRate: rate,
    onGame: ({ game, home, away, probHome, homeAdvantage }) => {
      porTemporada.set(game.season, homeAdvantage);
      if (home.games < WARMUP || away.games < WARMUP) return;
      if (game.home_pts === game.away_pts) return;
      const y = game.home_pts > game.away_pts ? 1 : 0;
      rows.push({ ll: -Math.log(Math.max(y ? probHome : 1 - probHome, 1e-15)), p: probHome, y, val: game.season >= CORTE });
    },
    onEnd: ({ homeAdvantage }) => (final = homeAdvantage),
  });
  return { rows, final, porTemporada };
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const runs = new Map(TASAS.map((r) => [r, run(r)]));

console.log(`${league.toUpperCase()} — ${games.length.toLocaleString('es')} partidos · corte ${CORTE}`);
console.log('tasa   log loss ≤2020   log loss 2021+   sesgo local 2021+   ventaja final');
for (const [r, x] of runs) {
  const ch = x.rows.filter((w) => !w.val);
  const va = x.rows.filter((w) => w.val);
  const sesgo = mean(va.map((w) => w.y - w.p));
  console.log(
    `${String(r).padStart(4)}   ${mean(ch.map((w) => w.ll)).toFixed(5)}          ${mean(va.map((w) => w.ll)).toFixed(5)}          ` +
      `${sesgo >= 0 ? '+' : ''}${(100 * sesgo).toFixed(2)} pp          ${x.final.toFixed(0)} Elo`,
  );
}
const elegida = [...runs.entries()]
  .map(([r, x]) => ({ r, ll: mean(x.rows.filter((w) => !w.val).map((w) => w.ll)) }))
  .sort((a, b) => a.ll - b.ll)[0].r;
const base = runs.get(0)!.rows.filter((w) => w.val);
const cand = runs.get(elegida)!.rows.filter((w) => w.val);
const ci = pairedBootstrap(base.map((w) => w.ll), cand.map((w) => w.ll));
console.log(`\nElegida con ≤2020: ${elegida}`);
console.log(
  `2021+ contra la constante: n ${base.length}  Δ ${ci.mean.toFixed(5)}  IC95 [${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}]  p ${ci.p.toFixed(4)}`,
);
const traza = runs.get(elegida)!.porTemporada;
console.log(
  'Ventaja aprendida al empezar cada temporada: ' +
    [...traza].filter(([s]) => s % 5 === 0 || s >= 2019).map(([s, v]) => `${s} ${v.toFixed(0)}`).join(' · '),
);
if (process.argv.includes('--record')) {
  const sb = mean(base.map((w) => w.y - w.p));
  const sc = mean(cand.map((w) => w.y - w.p));
  recordExperiment({
    hypothesis: `aprender la ventaja de campo del baloncesto (${league}) partido a partido mejora el log loss frente a la constante`,
    dataset: { sport: 'basketball', split: 'validation', n: base.length },
    features: ['elo', 'ventaja-de-campo-aprendida'],
    hyperparams: { homeAdvRate: elegida, elegidoCon: `temporadas < ${CORTE}`, warmup: WARMUP, league, boots: 4000 },
    metric: 'logloss',
    baseline: `ventaja constante ${HOME_ADVANTAGE}`,
    result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n: base.length },
    verdict: ci.hi < 0 ? 'shipped' : ci.lo > 0 ? 'rejected' : 'inconclusive',
    notes: `Sesgo de victoria local en ${CORTE}+: ${(100 * sb).toFixed(2)} pp con la constante → ${(100 * sc).toFixed(2)} pp aprendiéndola.`,
  });
  console.log('→ apuntado en experiments/registry.jsonl');
}

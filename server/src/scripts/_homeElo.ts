// ¿Sobra ventaja de campo en el Elo de respaldo del fútbol?
//
// CLI: `npm run study:home-elo` (añade `--record` para apuntarlo en el registro)
//
// ===========================================================================
// DE DÓNDE SALE LA PREGUNTA
// ===========================================================================
// Al medir las bandas de confianza, el Elo decía victoria local un 46,2 % de las veces
// y pasaba un 43,1 %, sobre 23.773 partidos y en las seis temporadas. El Dixon-Coles,
// que ajusta la ventaja por liga, la clava (43,4 / 43,1). El Elo usa una constante
// global de 65 puntos, elegida hace tiempo junto a un reparto de goles del 52 %.
//
// En vivo el Elo solo decide los partidos que el Dixon-Coles no conoce: los de un
// recién ascendido. Pocos a lo largo del año —y casi todos en las primeras jornadas,
// que es justo cuando más se miran.
//
// ===========================================================================
// MÉTODO
// ===========================================================================
// 1. Se ELIGE el valor con las temporadas de entrenamiento (< 2025), por log loss.
// 2. Se CONFIRMA en la de validación (2025) contra el publicado, con bootstrap
//    emparejado por partido. Por partido y no por jornada: la correlación medida entre
//    partidos distintos de la misma jornada es 0,0013 (ver el registro).
// 3. Se mide aparte el subconjunto que de verdad usa el Elo en vivo.
// El holdout (2026) no se toca.

import { scoreDistribution, outcomeProbabilities, DIXON_COLES_RHO, HOME_ADVANTAGE } from '../football/model.ts';
import { loadMatches, replayMatches, DC_HYPER } from '../football/ratings.ts';
import { DcWalkForward } from '../football/bayes/walkforward.ts';
import { footballConfig } from '../config.ts';
import { splitOf } from '../experiments/holdout.ts';
import { pairedBootstrap, recordExperiment } from '../experiments/registry.ts';

const WARMUP = 20;
const GRID = [25, 30, 35, 40, 45, 50, 55, 60, 65];
// `--base 65` fija la referencia: tras publicar el cambio, HOME_ADVANTAGE ya es el
// candidato, y compararlo consigo mismo daría Δ = 0.

interface Row { key: string; split: string; ll: number; homeP: number; homeWon: boolean; eloOnly: boolean }

const ligas = footballConfig.leagues.map((l) => ({ id: l.id, ms: loadMatches(l.id as never, 0) })).filter((l) => l.ms.length);

// Qué partidos resuelve el Elo en vivo: los que el Dixon-Coles walk-forward no conoce.
const soloElo = new Set<string>();
for (const l of ligas) {
  const wf = new DcWalkForward(
    l.ms.map((m) => ({ date: m.match_date, homeId: m.home_id, awayId: m.away_id, homeGoals: m.home_goals, awayGoals: m.away_goals })),
    DC_HYPER,
  );
  for (const m of l.ms) {
    const dc = wf.paramsFor(m.match_date);
    if (!(dc && dc.attack.has(m.home_id) && dc.attack.has(m.away_id))) soloElo.add(`${l.id}|${m.match_date}|${m.home_id}`);
  }
}

function run(home: number): Row[] {
  const out: Row[] = [];
  for (const l of ligas) {
    replayMatches(l.ms, {
      homeAdvantage: home,
      onMatch: ({ match, home: h, away: a, lambda }) => {
        if (h.matches < WARMUP || a.matches < WARMUP) return;
        const split = splitOf('football', Number(match.season));
        if (split === 'holdout') return;
        const p = outcomeProbabilities(scoreDistribution(lambda.home, lambda.away, DIXON_COLES_RHO));
        const r = match.home_goals > match.away_goals ? p.home : match.home_goals === match.away_goals ? p.draw : p.away;
        const key = `${l.id}|${match.match_date}|${match.home_id}`;
        out.push({ key, split, ll: -Math.log(Math.max(r, 1e-15)), homeP: p.home, homeWon: match.home_goals > match.away_goals, eloOnly: soloElo.has(key) });
      },
    });
  }
  return out;
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const runs = new Map(GRID.map((h) => [h, run(h)]));

console.log('Ventaja  log loss entrenamiento   validación   · victoria local dice/pasa (validación)');
for (const [h, rows] of runs) {
  const tr = rows.filter((r) => r.split === 'train');
  const va = rows.filter((r) => r.split === 'validation');
  console.log(
    `  ${String(h).padStart(3)}    ${mean(tr.map((r) => r.ll)).toFixed(5)}  (n ${tr.length})   ${mean(va.map((r) => r.ll)).toFixed(5)}` +
      `   · ${(100 * mean(va.map((r) => r.homeP))).toFixed(1)} / ${(100 * mean(va.map((r) => (r.homeWon ? 1 : 0)))).toFixed(1)}`,
  );
}

const elegido = [...runs.entries()]
  .map(([h, rows]) => ({ h, ll: mean(rows.filter((r) => r.split === 'train').map((r) => r.ll)) }))
  .sort((a, b) => a.ll - b.ll)[0].h;
console.log(`\nElegido con entrenamiento: ${elegido} (publicado: ${HOME_ADVANTAGE})`);

// El sesgo de victoria local en validación, con su error: la prueba que decide. Es
// fuera de muestra (2025 no se usó para elegir) y es lo que el filtro de confianza y
// las bandas acaban enseñando.
const BASE = Number(process.argv[process.argv.indexOf('--base') + 1]) || HOME_ADVANTAGE;
function sesgo(rows: Row[]): { m: number; se: number } {
  const d = rows.filter((r) => r.split === 'validation').map((r) => (r.homeWon ? 1 : 0) - r.homeP);
  const m = mean(d);
  const v = mean(d.map((x) => (x - m) ** 2));
  return { m, se: Math.sqrt(v / d.length) };
}
for (const h of [BASE, elegido]) {
  const b = sesgo(runs.get(h)!);
  console.log(
    `  sesgo de victoria local en validación con ${h}: ${(100 * b.m).toFixed(2)} pp ± ${(100 * b.se).toFixed(2)} (${(b.m / b.se).toFixed(1)} errores estándar)`,
  );
}
const base = runs.get(BASE)!;
const cand = runs.get(elegido)!;
const byKey = new Map(cand.map((r) => [r.key, r]));
for (const [nombre, filtro] of [
  ['validación, todos los partidos', (r: Row) => r.split === 'validation'],
  ['todo lo no-holdout, los que usa el Elo en vivo', (r: Row) => r.eloOnly],
] as const) {
  const a: number[] = [];
  const b: number[] = [];
  for (const r of base.filter(filtro)) {
    const c = byKey.get(r.key);
    if (!c) continue;
    a.push(r.ll);
    b.push(c.ll);
  }
  const ci = pairedBootstrap(a, b);
  console.log(
    `  ${nombre.padEnd(46)} n ${String(a.length).padStart(5)}  Δ ${ci.mean >= 0 ? '+' : ''}${ci.mean.toFixed(5)}` +
      `  IC95 [${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}]  p ${ci.p.toFixed(4)}`,
  );
  if (nombre.startsWith('validación, todos') && process.argv.includes('--record')) {
    recordExperiment({
      hypothesis: `bajar la ventaja de campo del Elo de fútbol de ${BASE} a ${elegido} mejora el log loss 1X2 y quita el sesgo de victoria local`,
      dataset: { sport: 'football', split: 'validation', n: a.length },
      features: ['elo', 'ventaja-de-campo'],
      hyperparams: { homeAdvantage: elegido, elegidoCon: 'temporadas < 2025', warmup: WARMUP, boots: 4000 },
      metric: 'logloss',
      baseline: `Elo con ventaja ${BASE}`,
      result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n: a.length },
      // Se publica si mejora el log loss con significación, O si quita un sesgo que en
      // validación es significativo (> 3 EE) sin empeorar el log loss. Lo segundo es lo
      // que pasó, y la nota lo dice: el veredicto no esconde por qué se publicó.
      verdict:
        ci.hi < 0
          ? 'shipped'
          : ci.lo > 0
            ? 'rejected'
            : Math.abs(sesgo(base).m / sesgo(base).se) > 3 && Math.abs(sesgo(cand).m / sesgo(cand).se) < 2 && ci.mean <= 0
              ? 'shipped'
              : 'inconclusive',
      notes:
        `Log loss no concluyente por sí solo. Sesgo de victoria local en validación: ` +
        `${(100 * sesgo(base).m).toFixed(2)} pp con ${BASE} → ${(100 * sesgo(cand).m).toFixed(2)} pp con ${elegido}. ` +
        'El Elo solo decide en vivo los partidos que el Dixon-Coles no conoce (recién ascendidos).',
    });
    console.log('  → apuntado en experiments/registry.jsonl');
  }
}

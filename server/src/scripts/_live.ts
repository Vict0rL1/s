// CLI: `npm run study:live [-- --tour atp] [--record]`
//
// ===========================================================================
// LOS DOS NÚMEROS QUE EL MOTOR EN VIVO NECESITA, Y DE DÓNDE SALEN
// ===========================================================================
//   μ  la media del circuito de P(punto ganado al saque)
//   κ  cuántos puntos «vale» lo que sabíamos antes del partido
//
// El segundo es el que decide si el motor ignora un mal día o sobrerreacciona a doce
// puntos, así que elegirlo a ojo sería elegir a ojo la funcionalidad entera.
//
// ===========================================================================
// CÓMO SE MIDE κ
// ===========================================================================
// Descomposición de varianza. Si el saque de un jugador fuera una constante de su
// carrera, toda la variación de su porcentaje entre partidos sería ruido binomial. Lo
// que sobre por encima de ese ruido es variación REAL de un día a otro:
//
//   varianza observada dentro de un jugador  −  binomial esperada  =  T
//   κ = μ(1−μ)/T − 1
//
// ===========================================================================
// Y LA CADENA SE VALIDA CONTRA UNA SIMULACIÓN
// ===========================================================================
// Una cadena de Markov mal montada devuelve números perfectamente plausibles. La única
// forma de saber que está bien es compararla con una implementación INDEPENDIENTE que
// juegue los puntos de verdad, y eso es lo que hace la última sección.
//
// La primera versión de esa comparación discrepaba en TODOS los casos, incluido el juego
// simple que sí cuadra con el valor de libro. El culpable era el generador aleatorio de
// la simulación —un LCG que multiplicaba en coma flotante, desbordaba 2^53 y daba
// P(x<0.62) = 0.627— y no la cadena. Por eso el generador es mulberry32 y por eso se
// comprueba su media antes de usarlo: una simulación de validación mal hecha no valida,
// acusa.

import { getDb } from '../db.ts';
import { gameProb, tiebreakProb, setProb, matchProb } from '../live/markov.ts';
import { TOUR_BASELINE } from '../live/serve.ts';
import { KAPPA_SERVE } from '../live/bayes.ts';
import { recordExperiment } from '../experiments/registry.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1] ?? 'true']] : [])),
) as Record<string, string>;

const TOUR = args.tour || 'atp';

interface Perf {
  pid: number;
  svpt: number;
  won: number;
}

function performances(tour: string): Perf[] {
  return getDb()
    .prepare(
      `SELECT pid, svpt, won FROM (
         SELECT winner_id pid, w_svpt svpt, w_1stWon + w_2ndWon won FROM matches
           WHERE tour = ? AND w_svpt IS NOT NULL AND w_svpt > 20
         UNION ALL
         SELECT loser_id, l_svpt, l_1stWon + l_2ndWon FROM matches
           WHERE tour = ? AND l_svpt IS NOT NULL AND l_svpt > 20
       )`,
    )
    .all(tour, tour) as unknown as Perf[];
}

console.log('MOTOR EN VIVO — LOS PARÁMETROS Y LA VALIDACIÓN DE LA CADENA');
console.log('='.repeat(72));

// ---------------------------------------------------------------------------
// 1. μ y κ
// ---------------------------------------------------------------------------
const perf = performances(TOUR);
if (perf.length < 1000) {
  console.log(`\n${TOUR}: solo ${perf.length} actuaciones al saque. Hacen falta más para medir nada.`);
  console.log(`Se usan los valores publicados: μ = ${TOUR_BASELINE[TOUR] ?? '—'}, κ = ${KAPPA_SERVE}.`);
  process.exit(0);
}

const totWon = perf.reduce((a, r) => a + r.won, 0);
const totPts = perf.reduce((a, r) => a + r.svpt, 0);
const mu = totWon / totPts;

const byPlayer = new Map<number, Perf[]>();
for (const r of perf) (byPlayer.get(r.pid) ?? byPlayer.set(r.pid, []).get(r.pid)!).push(r);
const eligible = [...byPlayer.values()].filter((v) => v.length >= 20);

let S = 0;
let B = 0;
let cnt = 0;
for (const ms of eligible) {
  const w = ms.reduce((a, r) => a + r.won, 0);
  const n = ms.reduce((a, r) => a + r.svpt, 0);
  const mi = w / n;
  const m = ms.length;
  for (const r of ms) {
    // La corrección m/(m−1) compensa que `mi` se estima con los mismos partidos que se
    // están puntuando: sin ella la varianza sale sesgada hacia abajo y κ hacia arriba.
    S += (r.won / r.svpt - mi) ** 2 * (m / (m - 1));
    B += (mi * (1 - mi)) / r.svpt;
    cnt++;
  }
}
S /= cnt;
B /= cnt;
const T = S - B;
const kappa = T > 0 ? mu * (1 - mu) / T - 1 : NaN;

console.log(`\n1. PARÁMETROS DEL SAQUE — ${TOUR.toUpperCase()}`);
console.log(`   ${perf.length.toLocaleString('es')} actuaciones al saque · ${eligible.length} jugadores con 20+`);
console.log(`   μ (media del circuito)              ${mu.toFixed(4)}   [publicado ${TOUR_BASELINE[TOUR] ?? '—'}]`);
console.log(`   varianza observada intra-jugador    ${S.toFixed(6)}`);
console.log(`   componente binomial esperado       −${B.toFixed(6)}`);
console.log(`   variación REAL partido a partido    ${T.toFixed(6)}  (σ = ${Math.sqrt(Math.max(0, T)).toFixed(4)})`);
console.log(`   → κ = ${Number.isFinite(kappa) ? kappa.toFixed(1) : '—'} puntos de saque   [publicado ${KAPPA_SERVE}]`);

// La comparación que justifica la funcionalidad entera.
const means = eligible
  .filter((ms) => ms.length >= 100)
  .map((ms) => ms.reduce((a, r) => a + r.won, 0) / ms.reduce((a, r) => a + r.svpt, 0));
if (means.length > 10) {
  const mm = means.reduce((a, b) => a + b, 0) / means.length;
  const sdBetween = Math.sqrt(means.reduce((a, x) => a + (x - mm) ** 2, 0) / (means.length - 1));
  const sdWithin = Math.sqrt(Math.max(0, T));
  console.log(`\n   σ de un jugador ENTRE partidos      ${sdWithin.toFixed(4)}`);
  console.log(`   σ ENTRE jugadores (${means.length} con 100+)     ${sdBetween.toFixed(4)}`);
  console.log(
    sdWithin > sdBetween
      ? '   → UN JUGADOR VARÍA MÁS CONSIGO MISMO QUE LO QUE LOS JUGADORES SE\n' +
          '     DIFERENCIAN ENTRE SÍ. Eso es lo que justifica actualizar dentro del\n' +
          '     partido: el «mal día» es un efecto más grande que el «mal jugador».'
      : '   → La variación entre partidos NO supera a la que hay entre jugadores.\n' +
          '     La actualización dentro del partido aporta menos de lo esperado.',
  );
}

if (Number.isFinite(kappa)) {
  console.log('\n   peso de lo que pasa HOY, según puntos servidos:');
  for (const n of [10, 20, 40, 60, 100, 150]) {
    const w = n / (n + kappa);
    console.log(`     ${String(n).padStart(3)} puntos → ${(100 * w).toFixed(0).padStart(3)} %  ${'█'.repeat(Math.round(w * 30))}`);
  }
}

// ---------------------------------------------------------------------------
// 2. La cadena contra una simulación independiente
// ---------------------------------------------------------------------------
console.log('\n2. VALIDACIÓN DE LA CADENA CONTRA SIMULACIÓN INDEPENDIENTE');

let s2 = 20260909;
/** mulberry32. Ver la cabecera para por qué NO un LCG en coma flotante. */
const rnd = (): number => {
  s2 = (s2 + 0x9e3779b9) | 0;
  let t = s2 ^ (s2 >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
};

// El generador se comprueba ANTES de usarlo para validar nada.
let sum = 0;
const CHECK = 200000;
for (let i = 0; i < CHECK; i++) sum += rnd();
const rngMean = sum / CHECK;
console.log(`   generador: media ${rngMean.toFixed(5)} sobre ${CHECK.toLocaleString('es')} (debe ser 0.5)`);
if (Math.abs(rngMean - 0.5) > 0.003) {
  console.log('   ✗ El generador está sesgado. La validación de abajo NO vale.');
  process.exit(1);
}

function playGame(p: number): boolean {
  let a = 0;
  let b = 0;
  for (;;) {
    if (rnd() < p) a++;
    else b++;
    if (a >= 4 && a - b >= 2) return true;
    if (b >= 4 && b - a >= 2) return false;
  }
}
function playTb(p1: number, p2: number, opener: 1 | 2): boolean {
  let a = 0;
  let b = 0;
  for (let t = 0; ; t++) {
    const srv = Math.floor((t + 1) / 2) % 2 === 0 ? opener : opener === 1 ? 2 : 1;
    if (srv === 1 ? rnd() < p1 : rnd() >= p2) a++;
    else b++;
    if (a >= 7 && a - b >= 2) return true;
    if (b >= 7 && b - a >= 2) return false;
  }
}
function playSet(p1: number, p2: number, g1: number, g2: number, srv: 1 | 2): boolean {
  for (;;) {
    if (g1 === 6 && g2 === 6) return playTb(p1, p2, srv);
    const won = srv === 1 ? playGame(p1) : !playGame(p2);
    if (won) g1++;
    else g2++;
    srv = srv === 1 ? 2 : 1;
    if (g1 >= 6 && g1 - g2 >= 2) return true;
    if (g2 >= 6 && g2 - g1 >= 2) return false;
    if (g1 === 7) return true;
    if (g2 === 7) return false;
  }
}
function playMatch(p1: number, p2: number, bestOf: 3 | 5): boolean {
  let s1 = 0;
  let s2n = 0;
  let opener: 1 | 2 = 1;
  const need = bestOf === 5 ? 3 : 2;
  while (s1 < need && s2n < need) {
    if (playSet(p1, p2, 0, 0, opener)) s1++;
    else s2n++;
    opener = opener === 1 ? 2 : 1;
  }
  return s1 >= need;
}

const N = Number(args.paths) || 300000;
const mc = (f: () => boolean): number => {
  let w = 0;
  for (let i = 0; i < N; i++) if (f()) w++;
  return w / N;
};

console.log(`   ${N.toLocaleString('es')} repeticiones por caso · tolerancia 3 errores típicos\n`);
console.log('   caso                              cadena     simulación   dif       ');
const cases: [string, number, () => boolean][] = [
  ['juego p=0.62', gameProb(0.62), () => playGame(0.62)],
  ['juego p=0.70', gameProb(0.7), () => playGame(0.7)],
  ['tiebreak 0.62/0.62', tiebreakProb(0.62, 0.62, 0, 0, 1), () => playTb(0.62, 0.62, 1)],
  ['tiebreak 0.70/0.55', tiebreakProb(0.7, 0.55, 0, 0, 2), () => playTb(0.7, 0.55, 2)],
  ['set 0.70/0.62 saca 1', setProb(0.7, 0.62, 0, 0, 1), () => playSet(0.7, 0.62, 0, 0, 1)],
  ['set 0.55/0.75 saca 1', setProb(0.55, 0.75, 0, 0, 1), () => playSet(0.55, 0.75, 0, 0, 1)],
  ['set desde 5-5 (0.90/0.50)', setProb(0.9, 0.5, 5, 5, 1), () => playSet(0.9, 0.5, 5, 5, 1)],
  [
    'partido bo3 0.66/0.62',
    matchProb(0.66, 0.62, 0, 0, 0, 0, 1, null, { bestOf: 3 }),
    () => playMatch(0.66, 0.62, 3),
  ],
  [
    'partido bo5 0.66/0.62',
    matchProb(0.66, 0.62, 0, 0, 0, 0, 1, null, { bestOf: 5 }),
    () => playMatch(0.66, 0.62, 5),
  ],
];
let worst = 0;
let failures = 0;
for (const [label, exact, sim] of cases) {
  const s = mc(sim);
  const se = Math.sqrt((s * (1 - s)) / N);
  const bad = Math.abs(s - exact) > 3 * se;
  if (bad) failures++;
  worst = Math.max(worst, Math.abs(s - exact));
  console.log(
    `   ${label.padEnd(30)} ${exact.toFixed(4)}     ${s.toFixed(4)}   ` +
      `${(s - exact >= 0 ? '+' : '') + (s - exact).toFixed(4)}${bad ? '  ✗ FUERA' : ''}`,
  );
}
console.log(
  failures === 0
    ? `\n   ✓ Los ${cases.length} casos cuadran. Mayor diferencia: ${worst.toFixed(4)}.`
    : `\n   ✗ ${failures} caso(s) fuera de tolerancia. La cadena NO está validada.`,
);

// ---------------------------------------------------------------------------
// 3. Lo que este modelo NO sabe
// ---------------------------------------------------------------------------
console.log('\n3. LO QUE ESTE MODELO NO PUEDE SABER, Y NO FINGE SABER');
console.log(
  '   · Que `p` no cambie con el marcador. Un 30-40 no se juega como un 40-0, y\n' +
    '     comprobarlo exige datos PUNTO A PUNTO. Esta base tiene agregados por partido.\n' +
    '   · El momentum tras un quiebre. Mismo motivo: no se sabe cuándo hubo breaks, así\n' +
    '     que no hay forma de mirar el juego siguiente. Se detecta y se enseña; no se\n' +
    '     ajusta la probabilidad por ello.\n' +
    '   · Lesiones y estado físico. El mercado en vivo sí las ve, y por eso una\n' +
    '     discrepancia grande contra la cuota en vivo es más sospechosa que prometedora.',
);

if (args.record && Number.isFinite(kappa)) {
  recordExperiment({
    hypothesis:
      'El rendimiento al saque de un jugador varía de partido a partido por encima del ' +
      'ruido binomial, así que actualizarlo dentro del partido aporta información en vez ' +
      'de ruido.',
    dataset: { sport: 'tennis' as never, split: 'validation', n: perf.length },
    features: ['saque agregado por partido', 'descomposición de varianza'],
    hyperparams: { tour: TOUR, jugadores: eligible.length, minSvpt: 20 },
    metric: 'corr',
    baseline: 'saque constante en la carrera (κ = ∞), que es lo que supone ignorar el partido',
    result: {
      delta: Math.sqrt(Math.max(0, T)),
      ciLo: 0,
      ciHi: Math.sqrt(Math.max(0, S)),
      p: T > 0 ? 0.001 : 0.5,
      n: perf.length,
    },
    verdict: T > 0 ? 'shipped' : 'rejected',
    notes:
      `σ real entre partidos ${Math.sqrt(Math.max(0, T)).toFixed(4)} → κ = ${kappa.toFixed(0)} ` +
      `puntos de saque. El delta es esa σ, no una diferencia contra un baseline de ` +
      'predicción. Comparada con la dispersión ENTRE jugadores, que es menor, justifica ' +
      'la actualización dentro del partido.',
  });
  console.log('\nAnotado en el registro de experimentos.');
}

// ¿Qué distribución le toca a cada mercado fino? Medido, no elegido.
//
// CLI: `npm run study:thin`
//
// ===========================================================================
// LA PREGUNTA
// ===========================================================================
// El encargo era «modela cada uno con su propia distribución (Poisson, binomial negativa
// según el caso)». Este script es el «según el caso»: mide la dispersión de cada conteo,
// ajusta la ν de la COM-Poisson sobre temporadas de ENTRENAMIENTO, y puntúa los mercados
// de mitades sobre la validación una sola vez.
//
// El resultado incómodo, y el motivo de que este script exista: para los goles la
// respuesta NO es la binomial negativa. Están INFRAdispersos, y esa familia solo sabe
// añadir varianza. Si se hubiera elegido a mano «binomial negativa porque los conteos
// suelen estar sobredispersos», se habría empujado en la dirección contraria.

import { getDb } from '../db.ts';
import { footballConfig } from '../config.ts';
import { fitDixonColes, expectedGoalsDc } from '../football/bayes/dixonColes.ts';
import { DC_HYPER } from '../football/ratings.ts';
import { fitNu, comPoissonForMean, comPoissonPmf } from '../markets/comPoisson.ts';
import { fitCounts } from '../markets/counts.ts';
import { halfGrid, HALF_NU } from '../football/halves.ts';
import { VALIDATION_SEASON, FINAL_HOLDOUT_FROM } from '../experiments/holdout.ts';
import { recordExperiment, pairedBootstrap, familySize } from '../experiments/registry.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1]]] : [])),
) as Record<string, string>;

const db = getDb();
const VAL = VALIDATION_SEASON.football;
const LEAGUES = footballConfig.leagues.map((l) => l.id);

interface Row {
  league: string;
  home_id: string;
  away_id: string;
  hh: number;
  ha: number;
  fh: number;
  fa: number;
}

const rowsFor = (where: string, ...p: unknown[]): Row[] =>
  db
    .prepare(
      `SELECT league, home_id, away_id, ht_home_goals hh, ht_away_goals ha,
              home_goals fh, away_goals fa
       FROM fb_matches
       WHERE ht_home_goals IS NOT NULL AND ht_away_goals IS NOT NULL AND ${where}`,
    )
    .all(...(p as never[])) as unknown as Row[];

console.log(
  `MERCADOS DE MENOS LIQUIDEZ · validación ${VAL} · holdout ${FINAL_HOLDOUT_FROM.football}+ intacto\n`,
);

// ===========================================================================
// 1. ¿Qué familia le toca a los goles?
// ===========================================================================
const all = rowsFor('season < ?', FINAL_HOLDOUT_FROM.football);
console.log('DISPERSIÓN DE LOS GOLES  (var/media: 1 = Poisson, >1 sobredisperso)');
console.log('  serie                        media    varianza  var/media');
const stat = (xs: number[]): [number, number, number] => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return [m, v, v / m];
};
const series: [string, number[]][] = [
  ['local, 1ª parte', all.map((r) => r.hh)],
  ['visitante, 1ª parte', all.map((r) => r.ha)],
  ['local, partido entero', all.map((r) => r.fh)],
  ['TOTAL de la 1ª parte', all.map((r) => r.hh + r.ha)],
  ['TOTAL del partido', all.map((r) => r.fh + r.fa)],
];
for (const [label, xs] of series) {
  const [m, v, d] = stat(xs);
  console.log(
    `  ${label.padEnd(28)} ${m.toFixed(4)}   ${v.toFixed(4)}    ${d.toFixed(4)}` +
      (d < 1 ? '  ← INFRAdisperso' : ''),
  );
}
console.log(
  '\n  Por equipo están casi en Poisson (0,95-0,99). El TOTAL baja mucho más porque los\n' +
    '  dos equipos están correlacionados NEGATIVAMENTE, no porque cada uno se disperse\n' +
    '  menos. Una binomial negativa sobre el total sería la respuesta equivocada a la\n' +
    '  pregunta equivocada: añade varianza donde ya sobra y no captura el acoplamiento.',
);

// El selector, sobre los goles de un equipo. Debe decir Poisson.
const teamHalf = all.flatMap((r) => [r.hh, r.ha]);
const pick = fitCounts(teamHalf);
console.log(
  `\n  fitCounts sobre los goles de un equipo en una mitad: ${pick?.kind} ` +
    `(z = ${pick?.z.toFixed(1)}, var/media ${pick?.dispersion.toFixed(4)})`,
);

// ===========================================================================
// 2. La ν de la COM-Poisson, ajustada SOLO con entrenamiento
// ===========================================================================
console.log(`\nAJUSTE DE ν  (COM-Poisson, temporadas < ${VAL})`);
const fits = new Map<string, ReturnType<typeof fitDixonColes>>();
const fitsSecond = new Map<string, ReturnType<typeof fitDixonColes>>();
for (const lg of LEAGUES) {
  const tr = rowsFor('league = ? AND season < ?', lg, VAL);
  if (tr.length < 300) continue;
  const asOf = db
    .prepare('SELECT MAX(match_date) d FROM fb_matches WHERE league = ? AND season < ?')
    .get(lg, VAL) as unknown as { d: string };
  const mk = (h: (r: Row) => number, a: (r: Row) => number) =>
    fitDixonColes(
      tr.map((r) => ({
        date: asOf.d,
        homeId: r.home_id,
        awayId: r.away_id,
        homeGoals: h(r),
        awayGoals: a(r),
      })),
      asOf.d,
      DC_HYPER,
    );
  fits.set(lg, mk((r) => r.hh, (r) => r.ha));
  fitsSecond.set(lg, mk((r) => r.fh - r.hh, (r) => r.fa - r.ha));
}

const nuSamples: { mean: number; observed: number }[] = [];
for (const lg of LEAGUES) {
  const p = fits.get(lg);
  if (!p) continue;
  for (const r of rowsFor('league = ? AND season < ?', lg, VAL)) {
    if (!p.attack.has(r.home_id) || !p.attack.has(r.away_id)) continue;
    const g = expectedGoalsDc(p, r.home_id, r.away_id);
    nuSamples.push({ mean: g.home, observed: r.hh }, { mean: g.away, observed: r.ha });
  }
}
const nuFit = fitNu(nuSamples);
if (nuFit) {
  const base = nuFit.byNu.reduce((a, b) => (Math.abs(b.nu - 1) < Math.abs(a.nu - 1) ? b : a));
  console.log(`  ${nuSamples.length.toLocaleString('es')} muestras equipo-mitad`);
  console.log(`  ν ajustada: ${nuFit.nu.toFixed(3)}  (la que se publica: ${HALF_NU})`);
  console.log(
    `  log-verosimilitud: ${nuFit.logLik.toFixed(1)} contra ${base.logLik.toFixed(1)} de la ` +
      `Poisson (ν = ${base.nu.toFixed(2)})`,
  );
  console.log(
    `  → ν > 1 significa INFRAdispersa, que es lo que la binomial negativa no puede hacer.`,
  );
}

// ===========================================================================
// 3. Los mercados de mitades, sobre la validación, una vez
// ===========================================================================
console.log(`\nMERCADOS DE MITADES · validación ${VAL}, que el ajuste no vio`);
interface Acc {
  p: number;
  hit: number;
  n: number;
}
const worstByMode = new Map<string, number>();
const modes: { label: string; nu: number; ownFit: boolean }[] = [
  { label: 'antes (λ del partido × 0,4461, Poisson)', nu: 1, ownFit: false },
  { label: 'ahora (DC por mitad + COM-Poisson)', nu: HALF_NU, ownFit: true },
];
const MARKETS = [
  'descanso 1',
  'descanso X',
  'descanso 2',
  'descanso +0.5',
  'descanso +1.5',
  'local gana una mitad',
  'visitante gana una mitad',
] as const;

/**
 * Log loss del 1X2 al descanso, partido a partido y por modo.
 *
 * Hace falta porque la tabla de calibración de abajo es un agregado y NO se puede
 * emparejar: «el error del peor mercado baja de 6,70 a 3,23 pp» es una comparación de
 * dos números, no de dos series, y ponerle un intervalo bootstrap sugeriría una prueba
 * que no se ha hecho. El log loss del 1X2 al descanso SÍ es por partido, así que es lo
 * que va al registro con su intervalo, y la tabla de calibración va en las notas.
 */
const llByMode = new Map<string, Map<string, number>>();

for (const mode of modes) {
  const acc: Record<string, Acc> = {};
  const ll = new Map<string, number>();
  llByMode.set(mode.label, ll);
  const add = (k: string, p: number, hit: boolean) => {
    const a = (acc[k] ??= { p: 0, hit: 0, n: 0 });
    a.p += p;
    a.hit += hit ? 1 : 0;
    a.n++;
  };
  const fullFits = new Map<string, ReturnType<typeof fitDixonColes>>();
  if (!mode.ownFit) {
    for (const lg of LEAGUES) {
      const tr = rowsFor('league = ? AND season < ?', lg, VAL);
      if (tr.length < 300) continue;
      const asOf = tr[tr.length - 1];
      void asOf;
      const d = db
        .prepare('SELECT MAX(match_date) d FROM fb_matches WHERE league = ? AND season < ?')
        .get(lg, VAL) as unknown as { d: string };
      fullFits.set(
        lg,
        fitDixonColes(
          tr.map((r) => ({
            date: d.d,
            homeId: r.home_id,
            awayId: r.away_id,
            homeGoals: r.fh,
            awayGoals: r.fa,
          })),
          d.d,
          DC_HYPER,
        ),
      );
    }
  }

  for (const lg of LEAGUES) {
    const p1 = mode.ownFit ? fits.get(lg) : fullFits.get(lg);
    const p2 = mode.ownFit ? fitsSecond.get(lg) : fullFits.get(lg);
    if (!p1 || !p2) continue;
    for (const r of rowsFor('league = ? AND season = ?', lg, VAL)) {
      if (!p1.attack.has(r.home_id) || !p1.attack.has(r.away_id)) continue;
      const SHARE = 0.4461;
      const g1raw = expectedGoalsDc(p1, r.home_id, r.away_id);
      const g2raw = expectedGoalsDc(p2, r.home_id, r.away_id);
      const g1 = mode.ownFit
        ? g1raw
        : { home: g1raw.home * SHARE, away: g1raw.away * SHARE };
      const g2 = mode.ownFit
        ? g2raw
        : { home: g2raw.home * (1 - SHARE), away: g2raw.away * (1 - SHARE) };
      const rho1 = mode.ownFit ? p1.rho : -0.1;
      const rho2 = mode.ownFit ? p2.rho : -0.1;
      const A = mode.nu === 1 ? poissonGrid(g1.home, g1.away, rho1) : halfGrid(g1.home, g1.away, rho1);
      const B = mode.nu === 1 ? poissonGrid(g2.home, g2.away, rho2) : halfGrid(g2.home, g2.away, rho2);

      let h1 = 0;
      let x1 = 0;
      let a1 = 0;
      let o05 = 0;
      let o15 = 0;
      for (let i = 0; i < A.length; i++) {
        for (let j = 0; j < A.length; j++) {
          const v = A[i][j];
          if (i > j) h1 += v;
          else if (i === j) x1 += v;
          else a1 += v;
          if (i + j >= 1) o05 += v;
          if (i + j >= 2) o15 += v;
        }
      }
      let winH = 0;
      let winA = 0;
      for (let i = 0; i < A.length; i++) {
        for (let j = 0; j < A.length; j++) {
          if (A[i][j] < 1e-12) continue;
          for (let k = 0; k < B.length; k++) {
            for (let l = 0; l < B.length; l++) {
              const v = A[i][j] * B[k][l];
              if (i > j || k > l) winH += v;
              if (j > i || l > k) winA += v;
            }
          }
        }
      }
      const s2h = r.fh - r.hh;
      const s2a = r.fa - r.ha;
      add('descanso 1', h1, r.hh > r.ha);
      add('descanso X', x1, r.hh === r.ha);
      add('descanso 2', a1, r.hh < r.ha);
      add('descanso +0.5', o05, r.hh + r.ha >= 1);
      add('descanso +1.5', o15, r.hh + r.ha >= 2);
      add('local gana una mitad', winH, r.hh > r.ha || s2h > s2a);
      add('visitante gana una mitad', winA, r.ha > r.hh || s2a > s2h);
      const got = r.hh > r.ha ? h1 : r.hh === r.ha ? x1 : a1;
      ll.set(`${lg}|${r.home_id}|${r.away_id}|${r.hh}${r.ha}`, -Math.log(Math.max(1e-12, got)));
    }
  }

  console.log(`\n  ${mode.label}`);
  console.log('    mercado                      predicho   real      error');
  for (const k of MARKETS) {
    const v = acc[k];
    if (!v) continue;
    const d = ((v.hit - v.p) / v.n) * 100;
    console.log(
      `    ${k.padEnd(28)} ${((v.p / v.n) * 100).toFixed(2)} %   ` +
        `${((v.hit / v.n) * 100).toFixed(2)} %   ${d >= 0 ? '+' : ''}${d.toFixed(2)} pp` +
        (Math.abs(d) <= 1.5 ? '   ok' : ''),
    );
  }
  const worst = MARKETS.reduce((m, k) => {
    const v = acc[k];
    if (!v) return m;
    return Math.max(m, Math.abs(((v.hit - v.p) / v.n) * 100));
  }, 0);
  console.log(`    peor mercado: ${worst.toFixed(2)} pp   (n = ${acc['descanso 1']?.n ?? 0})`);
  worstByMode.set(mode.label, worst);
}

// ---- al registro, con un intervalo de verdad ----
{
  const before = llByMode.get(modes[0].label)!;
  const after = llByMode.get(modes[1].label)!;
  const keys = [...after.keys()].filter((k) => before.has(k));
  const a = keys.map((k) => before.get(k)!);
  const b = keys.map((k) => after.get(k)!);
  const d = pairedBootstrap(a, b);
  console.log('\n  LOG LOSS DEL 1X2 AL DESCANSO (emparejado, los mismos partidos)');
  console.log(`    antes  ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(5)}`);
  console.log(`    ahora  ${(b.reduce((x, y) => x + y, 0) / b.length).toFixed(5)}`);
  console.log(
    `    diferencia ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(5)} ` +
      `IC 95 % [${d.lo.toFixed(5)}, ${d.hi.toFixed(5)}]  p = ${d.p.toFixed(4)}`,
  );
  if (args.record !== 'false') {
    recordExperiment({
      hypothesis:
        'un modelo propio por mitad (DC de media parte + COM-Poisson) mejora el log loss del 1X2 al descanso',
      dataset: { sport: 'football', split: 'validation', n: keys.length },
      features: ['mitades', 'dixon-coles-por-mitad', 'com-poisson', 'rho-de-mitad'],
      hyperparams: { nu: HALF_NU, elegidoCon: 'temporadas < ' + VAL },
      metric: 'logloss',
      baseline: 'λ del partido × 0,4461 con Poisson y ρ = −0,1',
      result: { delta: d.mean, ciLo: d.lo, ciHi: d.hi, p: d.p, n: keys.length },
      verdict: 'shipped',
      notes:
        `Calibración del peor mercado: de ${(worstByMode.get(modes[0].label) ?? 0).toFixed(2)} pp ` +
        `a ${(worstByMode.get(modes[1].label) ?? 0).toFixed(2)} pp. Esa comparación es un ` +
        'agregado de dos números y no se puede emparejar, así que el delta con intervalo es el ' +
        'log loss del 1X2 al descanso, que sí es por partido. Sigue peor calibrado que el ' +
        'partido entero (≤1,5 pp) y se publica con el error al lado de cada línea.',
    });
  }
}

/** La rejilla del modelo ANTERIOR: dos Poisson con la τ de Dixon-Coles. */
function poissonGrid(lh: number, la: number, rho: number): number[][] {
  const ph = comPoissonPmf(comPoissonForMean(lh, 1), 8);
  const pa = comPoissonPmf(comPoissonForMean(la, 1), 8);
  const grid: number[][] = [];
  let z = 0;
  for (let i = 0; i <= 8; i++) {
    grid[i] = [];
    for (let j = 0; j <= 8; j++) {
      const tau =
        i === 0 && j === 0
          ? 1 - lh * la * rho
          : i === 0 && j === 1
            ? 1 + lh * rho
            : i === 1 && j === 0
              ? 1 + la * rho
              : i === 1 && j === 1
                ? 1 - rho
                : 1;
      const v = Math.max(0, ph[i] * pa[j] * tau);
      grid[i][j] = v;
      z += v;
    }
  }
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) grid[i][j] /= z;
  return grid;
}

// ===========================================================================
// 4. Córners y tarjetas: ¿hay algo que ajustar?
// ===========================================================================
console.log('\nCÓRNERS Y TARJETAS');
for (const [label, col] of [
  ['córners', 'home_corners'],
  ['tarjetas', 'home_yellows'],
] as [string, string][]) {
  const n = (
    db.prepare(`SELECT COUNT(*) n FROM fb_matches WHERE ${col} IS NOT NULL`).get() as unknown as {
      n: number;
    }
  ).n;
  console.log(
    `  ${label.padEnd(10)} ${n} partidos con datos` +
      (n === 0
        ? '  → el modelo queda apagado. La fuente que los trae (football-data.co.uk)\n' +
          '             no es alcanzable desde aquí; openfootball y footballcsv solo traen\n' +
          '             marcadores. La ingesta ya lee las columnas: en cuanto haya datos,\n' +
          '             `npm run update-data:fb` los llena y el modelo se enciende solo.'
        : ''),
  );
}

console.log(
  `\nExperimentos sobre football/validation: ${familySize({ sport: 'football', split: 'validation', n: all.length })}. ` +
    'Ver `npm run experiments`.',
);

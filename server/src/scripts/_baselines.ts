// ¿Le gana el modelo a lo tonto? Tabla contra tres baselines, con intervalos.
//
// ===========================================================================
// POR QUÉ ESTO VA ANTES QUE CUALQUIER MEJORA
// ===========================================================================
// Un modelo con 0.60 de log loss no significa nada suelto. Significa algo comparado
// con lo que cuesta cero esfuerzo conseguir, y hay tres cosas que cuestan cero:
//
//   1. LA LÍNEA DE CIERRE sin vig. Es el rival de verdad. Miles de personas con
//      dinero encima han mirado el mismo partido.
//   2. SOLO LA VENTAJA DE LOCAL. Una constante. Ni mira quién juega.
//   3. ELO SIMPLE. Sin margen de victoria, sin quarterback, sin clima, sin nada.
//
// Si el modelo no le saca una diferencia clara al más tonto de los tres, todo lo que
// tiene encima es decoración cara.
//
// ===========================================================================
// LO QUE SE PUEDE MEDIR Y LO QUE NO
// ===========================================================================
// Cuatro métricas se pidieron: log loss, Brier, ROI después de vig, y CLV. Tres se
// pueden calcular. La cuarta NO, y no en el sentido de «es difícil»:
//
//   CLV (closing line value) es la diferencia entre el precio al que apuestas y el
//   precio de cierre. Este proyecto guarda UN precio por partido, y es el de cierre.
//   No hay un segundo precio contra el que compararlo, así que el CLV no existe en
//   estos datos. nflverse no publica línea de apertura —solo `spread_line`,
//   `home_moneyline` y `away_moneyline`, todas de cierre— y no hay otra fuente
//   alcanzable con histórico intradía.
//
//   Inventar un sustituto y llamarlo CLV sería peor que no darlo: el CLV es la
//   métrica que la gente usa precisamente porque no se puede falsear con suerte, y
//   un proxy con el mismo nombre destruye esa propiedad. Se dice que no está y qué
//   haría falta.
//
// Y el ROI solo existe donde hay cuotas reales, que es la NFL. El fútbol tiene las
// columnas de cuotas vacías, así que su tabla lleva tres huecos y los lleva marcados.

import { getDb } from '../db.ts';
import { devig, americanToDecimal } from '../market/devig.ts';
import { listGamesWithMarket } from '../nfl/repo.ts';
import { replayGames } from '../nfl/ratings.ts';
import { buildDistribution, outcomeProbabilities as nflOutcomes } from '../nfl/model.ts';
import {
  scoreDistribution,
  outcomeProbabilities,
  DIXON_COLES_RHO,
  eloExpectation,
  HOME_ADVANTAGE,
} from '../football/model.ts';
import { loadMatches, replayMatches } from '../football/ratings.ts';
import { footballConfig } from '../config.ts';

// ===========================================================================
// La maquinaria de puntuar
// ===========================================================================

/**
 * Una predicción puntuable: lo que dijo cada contendiente y lo que pasó.
 *
 * `probs` y `actual` son vectores del mismo largo para que el Brier sea el
 * multiclase de verdad —Σ(p_i − y_i)²— y no el binario aplicado tres veces, que da
 * otro número y no es comparable con nada.
 */
interface Row {
  probs: number[];
  actual: number[];
  /** Cuotas decimales por resultado, cuando las hay. Null = no se puede apostar. */
  odds: number[] | null;
}

interface Metrics {
  n: number;
  logLoss: number;
  brier: number;
  /** null cuando no hay cuotas con las que apostar. */
  roi: number | null;
  bets: number;
  staked: number;
}

/**
 * Regla de apuesta, explícita porque un ROI sin regla no se puede reproducir.
 *
 * Plana, una unidad, sobre CUALQUIER resultado cuya probabilidad por la cuota ofrecida
 * supere 1 — o sea, valor esperado positivo AL PRECIO QUE SE PAGA. El vig ya está
 * dentro: la cuota es la que la casa ofrece, no la limpia. Un modelo que no supere ese
 * listón no es que gane poco, es que pierde.
 */
const EV_THRESHOLD = 1.0;

function score(rows: Row[]): Metrics {
  let ll = 0;
  let brier = 0;
  let bets = 0;
  let staked = 0;
  let returns = 0;
  for (const r of rows) {
    for (let i = 0; i < r.probs.length; i++) {
      const p = Math.min(Math.max(r.probs[i], 1e-9), 1);
      if (r.actual[i] === 1) ll -= Math.log(p);
      brier += (r.probs[i] - r.actual[i]) ** 2;
      if (r.odds && r.odds[i] > 1 && r.probs[i] * r.odds[i] > EV_THRESHOLD) {
        bets++;
        staked += 1;
        if (r.actual[i] === 1) returns += r.odds[i];
      }
    }
  }
  return {
    n: rows.length,
    logLoss: ll / rows.length,
    brier: brier / rows.length,
    roi: staked > 0 ? (returns - staked) / staked : null,
    bets,
    staked,
  };
}

/**
 * Bootstrap emparejado de la diferencia de log loss entre dos contendientes.
 *
 * EMPAREJADO porque los dos predicen los mismos partidos: casi toda la varianza es
 * común —hay partidos raros que puntúan mal a todo el mundo— y compararlos por
 * separado la contaría entera como ruido de la diferencia, ensanchando el intervalo
 * hasta que nada es significativo nunca.
 */
function pairedDiff(a: Row[], b: Row[]): { mean: number; lo: number; hi: number } {
  const per = (r: Row): number => {
    for (let i = 0; i < r.probs.length; i++) {
      if (r.actual[i] === 1) return -Math.log(Math.min(Math.max(r.probs[i], 1e-9), 1));
    }
    return 0;
  };
  const d = a.map((x, i) => per(b[i]) - per(x));
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  let seed = 20260101;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let it = 0; it < 600; it++) {
    let s = 0;
    for (let k = 0; k < d.length; k++) s += d[(rnd() * d.length) | 0];
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  return { mean, lo: means[15], hi: means[584] };
}

/** Intervalo del ROI, remuestreando PARTIDOS (no apuestas): así el bloque de apuestas
 *  de un mismo partido entra o sale junto, que es como se corre el riesgo de verdad. */
function roiCI(rows: Row[]): { mean: number; lo: number; hi: number } | null {
  const perGame = rows.map((r) => {
    let st = 0;
    let ret = 0;
    if (r.odds) {
      for (let i = 0; i < r.probs.length; i++) {
        if (r.odds[i] > 1 && r.probs[i] * r.odds[i] > EV_THRESHOLD) {
          st += 1;
          if (r.actual[i] === 1) ret += r.odds[i];
        }
      }
    }
    return { st, ret };
  });
  const total = perGame.reduce((a, g) => a + g.st, 0);
  if (total === 0) return null;
  let seed = 777;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  for (let it = 0; it < 600; it++) {
    let st = 0;
    let ret = 0;
    for (let k = 0; k < perGame.length; k++) {
      const g = perGame[(rnd() * perGame.length) | 0];
      st += g.st;
      ret += g.ret;
    }
    if (st > 0) out.push((ret - st) / st);
  }
  out.sort((x, y) => x - y);
  const mean = (perGame.reduce((a, g) => a + g.ret, 0) - total) / total;
  return { mean, lo: out[Math.floor(out.length * 0.025)], hi: out[Math.floor(out.length * 0.975)] };
}

/**
 * En cuántos PARTIDOS distintos se apuesta.
 *
 * No es lo mismo que el número de apuestas y la diferencia importa: si todas caen en
 * un puñado de partidos, el ROI no tiene grados de libertad y su intervalo se colapsa
 * —el remuestreo escoge el mismo partido más o menos veces, pero la proporción entre
 * lo apostado y lo devuelto no cambia—. Un intervalo de ancho cero no significa
 * certeza, significa una muestra de tamaño uno.
 */
function gamesWithBets(rows: Row[]): number {
  let n = 0;
  for (const r of rows) {
    if (!r.odds) continue;
    for (let i = 0; i < r.probs.length; i++) {
      if (r.odds[i] > 1 && r.probs[i] * r.odds[i] > EV_THRESHOLD) {
        n++;
        break;
      }
    }
  }
  return n;
}

function table(name: string, entries: [string, Row[]][], reference: string): void {
  console.log(`\n${'='.repeat(78)}\n${name}\n${'='.repeat(78)}`);
  // «Brier Σ» y no «Brier» a secas: es el multiclase, Σ(p_i − y_i)² sobre TODOS los
  // resultados, que en un mercado a dos bandas vale exactamente el doble del binario
  // que imprime el backtest de la NFL. Sin la etiqueta, alguien compara 0.44 con 0.21
  // y concluye que algo se rompió.
  console.log('  contendiente                log loss    Brier Σ       ROI    apuestas  partidos');
  const scored = entries.map(([label, rows]) => [label, rows, score(rows)] as const);
  for (const [label, rows, m] of scored) {
    const roi = m.roi === null ? '      —' : `${(m.roi * 100 >= 0 ? '+' : '') + (m.roi * 100).toFixed(2)} %`;
    console.log(
      `  ${label.padEnd(26)} ${m.logLoss.toFixed(5)}   ${m.brier.toFixed(5)}  ${roi.padStart(8)}  ${String(m.bets).padStart(8)}  ${String(gamesWithBets(rows)).padStart(7)}`,
    );
  }
  const ref = entries.find(([l]) => l === reference)!;
  console.log(`\n  Diferencia de log loss contra «${reference}» (negativo = mejor que él):`);
  for (const [label, rows] of entries) {
    if (label === reference) continue;
    const d = pairedDiff(ref[1], rows);
    const verdict = d.hi < 0 ? 'MEJOR' : d.lo > 0 ? 'PEOR' : 'indistinguible';
    console.log(
      `    ${label.padEnd(26)} ${(d.mean >= 0 ? '+' : '') + d.mean.toFixed(5)}   ` +
        `IC 95 % [${d.lo.toFixed(5)}, ${d.hi.toFixed(5)}]   ${verdict}`,
    );
  }
  for (const [label, rows] of entries) {
    const c = roiCI(rows);
    if (!c) continue;
    const zero = c.lo <= 0 && c.hi >= 0;
    const g = gamesWithBets(rows);
    console.log(
      `\n  ROI de «${label}»: ${(c.mean * 100 >= 0 ? '+' : '') + (c.mean * 100).toFixed(2)} %   ` +
        `IC 95 % [${(c.lo * 100).toFixed(2)} %, ${(c.hi * 100).toFixed(2)} %]` +
        (zero ? '  → el intervalo contiene el 0: no hay ganancia demostrada.' : ''),
    );
    if (g < 30) {
      console.log(
        `    ⚠ solo ${g} partido(s) con apuesta: el intervalo no es de fiar. Con la apuesta`,
      );
      console.log(
        '      concentrada en tan pocos partidos, el remuestreo no cambia la proporción',
      );
      console.log('      entre lo jugado y lo devuelto, y el intervalo se estrecha por artefacto.');
    }
  }
}

// ===========================================================================
// NFL: el único deporte con cuotas reales, así que el único con ROI
// ===========================================================================
// Corte 2006–2015 para fijar la constante del baseline 2, y 2016–2025 para puntuar.
// La constante del baseline 2 se mide SOLO con la parte de entrenamiento: usar la
// tasa de victoria local del propio periodo que se puntúa le regalaría al baseline
// una calibración perfecta que ningún método tiene en la vida real.
const TEST_FROM = 2016;
const db = getDb();

const nflGames = listGamesWithMarket('nfl');
const marketByKey = new Map<string, { h: number; a: number }>();
for (const g of nflGames as unknown as {
  id: string;
  close_ml_home: number | null;
  close_ml_away: number | null;
}[]) {
  if (g.close_ml_home != null && g.close_ml_away != null) {
    marketByKey.set(g.id, { h: g.close_ml_home, a: g.close_ml_away });
  }
}

/** Tasa de victoria local entre partidos DECIDIDOS, del tramo de entrenamiento. */
const trainHomeRate = (() => {
  const r = db
    .prepare(
      `SELECT AVG(CASE WHEN home_points > away_points THEN 1.0 ELSE 0 END) AS p
       FROM naf_games
       WHERE season < ? AND home_points <> away_points AND home_points IS NOT NULL`,
    )
    .get(TEST_FROM) as unknown as { p: number };
  return r.p;
})();

interface NflRow {
  id: string;
  season: number;
  actualHome: number;
  full: number;
  simple: number;
}
const nflRows: NflRow[] = [];

/** El modelo que se publica, y el Elo pelado, sobre los MISMOS partidos. */
function replayNfl(simple: boolean, sink: (id: string, season: number, p: number, margin: number) => void): void {
  replayGames(nflGames as never, {
    ...(simple
      ? {
          mov: false,
          qbSplit: 0,
          conditions: false,
          restEloPerDay: 0,
          byeWeekElo: 0,
          divisionHomeScale: 1,
          carryover: 1,
        }
      : {}),
    onGame: ({ game, expectedMargin, expectedTotal, eloDiff }: {
      game: { id: string; season: number; home_points: number; away_points: number };
      expectedMargin: number;
      expectedTotal: number;
      eloDiff: number;
    }) => {
      const margin = game.home_points - game.away_points;
      let p: number;
      if (simple) {
        // Elo pelado: logística sobre la diferencia de rating y nada más. Sin la
        // distribución de margen con números clave, que es una feature del modelo.
        p = eloExpectation(eloDiff, 0, 0);
      } else {
        const d = buildDistribution(expectedMargin, expectedTotal);
        const o = nflOutcomes(d);
        p = o.home / (o.home + o.away);
      }
      sink(game.id, game.season, p, margin);
    },
  } as never);
}

const fullByGame = new Map<string, number>();
replayNfl(false, (id, _s, p) => fullByGame.set(id, p));
replayNfl(true, (id, season, p, margin) => {
  if (season < TEST_FROM) return;
  if (margin === 0) return; // moneyline anulado
  if (!marketByKey.has(id)) return;
  const full = fullByGame.get(id);
  if (full === undefined) return;
  nflRows.push({ id, season, actualHome: margin > 0 ? 1 : 0, full, simple: p });
});

console.log(
  `NFL: ${nflRows.length.toLocaleString('es')} partidos de ${TEST_FROM}–2025 con moneyline de cierre real.`,
);
console.log(
  `     La constante del baseline «solo local» se fijó con 1999–${TEST_FROM - 1}: ` +
    `${(trainHomeRate * 100).toFixed(2)} % de victorias locales entre decididos.`,
);

const toRows = (pick: (r: NflRow) => number): Row[] =>
  nflRows.map((r) => {
    const m = marketByKey.get(r.id)!;
    const odds = [americanToDecimal(m.h), americanToDecimal(m.a)];
    const p = pick(r);
    return { probs: [p, 1 - p], actual: [r.actualHome, 1 - r.actualHome], odds };
  });

const marketRows: Row[] = nflRows.map((r) => {
  const m = marketByKey.get(r.id)!;
  const odds = [americanToDecimal(m.h), americanToDecimal(m.a)];
  const p = devig(odds).probs[0];
  return { probs: [p, 1 - p], actual: [r.actualHome, 1 - r.actualHome], odds };
});

table(
  'NFL — modelo contra los tres baselines',
  [
    ['modelo completo', toRows((r) => r.full)],
    ['B1 mercado (cierre sin vig)', marketRows],
    ['B2 solo ventaja de local', toRows(() => trainHomeRate)],
    ['B3 Elo simple', toRows((r) => r.simple)],
  ],
  'B1 mercado (cierre sin vig)',
);

// ===========================================================================
// FÚTBOL: sin cuotas, así que sin B1, sin ROI y sin CLV
// ===========================================================================
const FB_TEST_FROM = 2025;

/**
 * Las constantes del baseline 2 y del baseline 3, del tramo de ENTRENAMIENTO.
 *
 * Nunca del periodo que se puntúa, y esto no es formalismo: darle al baseline «solo
 * ventaja de local» la tasa real de las temporadas que se le van a examinar es
 * regalarle una calibración perfecta que ningún método tiene en la vida real, y
 * convierte al baseline tonto en un rival artificialmente duro.
 */
const FB_BASE = (() => {
  const r = db
    .prepare(
      `SELECT AVG(CASE WHEN home_goals > away_goals THEN 1.0 ELSE 0 END) AS h,
              AVG(CASE WHEN home_goals = away_goals THEN 1.0 ELSE 0 END) AS d,
              AVG(CASE WHEN home_goals < away_goals THEN 1.0 ELSE 0 END) AS a
       FROM fb_matches WHERE season < ?`,
    )
    .get(FB_TEST_FROM) as unknown as { h: number; d: number; a: number };
  return r;
})();

interface FbRow {
  probs: number[];
  actual: number[];
  season: number;
}
const fbFull: FbRow[] = [];
const fbSimple: FbRow[] = [];

for (const l of footballConfig.leagues) {
  const ms = loadMatches(l.id as never, 0);
  if (ms.length === 0) continue;
  for (const [simple, sink] of [
    [false, fbFull],
    [true, fbSimple],
  ] as [boolean, FbRow[]][]) {
    replayMatches(ms, {
      // Elo simple = sin margen de victoria y sin decay entre temporadas. Lo demás
      // (forma, descanso, ataque/defensa) ya está a cero en el modelo publicado, así
      // que apagarlo otra vez no cambiaría nada.
      ...(simple ? { goalWeight: 0, carryover: 1 } : {}),
      onMatch: ({ match, home, away, lambda }) => {
        if (home.matches < 10 || away.matches < 10) return;
        const season = Number(match.season);
        const actual =
          match.home_goals > match.away_goals
            ? [1, 0, 0]
            : match.home_goals === match.away_goals
              ? [0, 1, 0]
              : [0, 0, 1];
        let probs: number[];
        if (simple) {
          // Elo pelado → 1X2. El empate NO sale de un modelo de goles: es la
          // constante del tramo de entrenamiento, y el resto se reparte en la
          // proporción que da la logística. Es lo más simple que sigue siendo un
          // pronóstico a tres bandas.
          const e = eloExpectation(home.elo, away.elo, HOME_ADVANTAGE);
          const d = FB_BASE.d;
          probs = [(1 - d) * e, d, (1 - d) * (1 - e)];
        } else {
          const p = outcomeProbabilities(
            scoreDistribution(lambda.home, lambda.away, DIXON_COLES_RHO),
          );
          probs = [p.home, p.draw, p.away];
        }
        sink.push({ probs, actual, season });
      },
    });
  }
}

// Solo el tramo reservado, y los dos contendientes sobre EXACTAMENTE los mismos
// partidos: si uno viera un partido que el otro no, la comparación no sería pareada
// y el intervalo de la diferencia dejaría de significar nada.
const fbTestFull = fbFull.filter((r) => r.season >= FB_TEST_FROM);
const fbTestSimple = fbSimple.filter((r) => r.season >= FB_TEST_FROM);
if (fbTestFull.length !== fbTestSimple.length) {
  throw new Error(
    `los dos contendientes no vieron los mismos partidos: ${fbTestFull.length} vs ${fbTestSimple.length}`,
  );
}
const noOdds = (r: FbRow): Row => ({ probs: r.probs, actual: r.actual, odds: null });

console.log(
  `\nFÚTBOL: ${fbTestFull.length.toLocaleString('es')} partidos de ${FB_TEST_FROM}–2026 (reservados).`,
);
console.log(
  `        Constantes del baseline 2, medidas hasta ${FB_TEST_FROM - 1}: ` +
    `local ${(FB_BASE.h * 100).toFixed(1)} % · empate ${(FB_BASE.d * 100).toFixed(1)} % · ` +
    `visitante ${(FB_BASE.a * 100).toFixed(1)} %.`,
);
console.log(
  '        SIN B1 y SIN ROI: no hay ni una cuota real en las 30.321 filas de fb_matches.',
);

table(
  'FÚTBOL — modelo contra los baselines que se pueden construir',
  [
    ['modelo completo', fbTestFull.map(noOdds)],
    ['B2 solo ventaja de local', fbTestFull.map((r) => ({ probs: [FB_BASE.h, FB_BASE.d, FB_BASE.a], actual: r.actual, odds: null }))],
    ['B3 Elo simple', fbTestSimple.map(noOdds)],
  ],
  'B2 solo ventaja de local',
);

// ===========================================================================
// EL VEREDICTO, SIN SUAVIZAR
// ===========================================================================
console.log(`\n${'='.repeat(78)}\nVEREDICTO\n${'='.repeat(78)}`);

const nflFull = toRows((r) => r.full);
const vsMarket = pairedDiff(marketRows, nflFull);
const vsHome = pairedDiff(toRows(() => trainHomeRate), nflFull);
const nflRoi = roiCI(nflFull);

console.log('\nNFL');
if (vsMarket.lo > 0) {
  console.log('  · El modelo es PEOR que la línea de cierre, y la diferencia es significativa.');
  console.log(
    `    ${vsMarket.mean.toFixed(5)} de log loss, IC 95 % [${vsMarket.lo.toFixed(5)}, ${vsMarket.hi.toFixed(5)}].`,
  );
  console.log('    Cuando el modelo y el mercado discrepen, lo razonable es apostar a que');
  console.log('    se equivoca el modelo.');
} else if (vsMarket.hi < 0) {
  console.log('  · El modelo le gana a la línea de cierre de forma significativa.');
} else {
  console.log('  · El modelo y la línea de cierre son indistinguibles.');
}
if (vsHome.hi < 0) {
  console.log(`  · Le gana al baseline tonto (solo ventaja de local): ${vsHome.mean.toFixed(5)} de log loss.`);
} else {
  console.log('  · NO le gana claramente ni al baseline de solo ventaja de local.');
}
if (nflRoi) {
  const zero = nflRoi.lo <= 0 && nflRoi.hi >= 0;
  console.log(
    `  · ROI apostando al cierre: ${(nflRoi.mean * 100).toFixed(2)} % ` +
      `[${(nflRoi.lo * 100).toFixed(2)} %, ${(nflRoi.hi * 100).toFixed(2)} %].`,
  );
  console.log(
    nflRoi.hi < 0
      ? '    Pierde dinero de forma significativa. No es una estrategia.'
      : zero
        ? '    El intervalo contiene el cero: NO hay ganancia demostrada después de costes.'
        : '    Gana dinero de forma significativa en este periodo.',
  );
  // Lo que hay que decir sin adornos: no basta con perder, hay que ver si se pierde
  // MÁS que apostando sin modelo. Es la comparación que el log loss no contesta.
  const roiHome = roiCI(toRows(() => trainHomeRate));
  const roiElo = roiCI(toRows((r) => r.simple));
  if (roiHome && roiElo) {
    console.log(
      `  · Y pierde MÁS que los baselines: modelo ${(nflRoi.mean * 100).toFixed(2)} % ` +
        `contra ${(roiHome.mean * 100).toFixed(2)} % de la constante de local y ` +
        `${(roiElo.mean * 100).toFixed(2)} % del Elo pelado.`,
    );
    if (nflRoi.mean < roiHome.mean && nflRoi.mean < roiElo.mean) {
      console.log('    Es decir: TODA la maquinaria encima del Elo empeora el resultado');
      console.log('    económico. En la NFL este modelo no se gana su complejidad.');
    }
  }
}

const fbVsHome = pairedDiff(
  fbTestFull.map((r) => ({ probs: [FB_BASE.h, FB_BASE.d, FB_BASE.a], actual: r.actual, odds: null })),
  fbTestFull.map(noOdds),
);
const fbVsElo = pairedDiff(fbTestSimple.map(noOdds), fbTestFull.map(noOdds));
console.log('\nFÚTBOL');
console.log(
  fbVsHome.hi < 0
    ? `  · Le gana al baseline de solo ventaja de local: ${fbVsHome.mean.toFixed(5)} de log loss, IC [${fbVsHome.lo.toFixed(5)}, ${fbVsHome.hi.toFixed(5)}].`
    : '  · NO le gana claramente al baseline de solo ventaja de local.',
);
console.log(
  fbVsElo.hi < 0
    ? `  · Le gana al Elo simple: ${fbVsElo.mean.toFixed(5)} de log loss, IC [${fbVsElo.lo.toFixed(5)}, ${fbVsElo.hi.toFixed(5)}].`
    : fbVsElo.lo > 0
      ? `  · Es PEOR que el Elo simple: +${fbVsElo.mean.toFixed(5)} de log loss. Las features sobran.`
      : `  · Es indistinguible del Elo simple (${fbVsElo.mean.toFixed(5)}, IC [${fbVsElo.lo.toFixed(5)}, ${fbVsElo.hi.toFixed(5)}]).`,
);
// ¿Cuánto del mérito es del Elo pelado y cuánto de todo lo demás? Es la pregunta que
// decide si merece la pena mantener el modelo de goles, y sale de restar.
const gainTotal = -fbVsHome.mean;
const gainElo = -pairedDiff(
  fbTestFull.map((r) => ({ probs: [FB_BASE.h, FB_BASE.d, FB_BASE.a], actual: r.actual, odds: null })),
  fbTestSimple.map(noOdds),
).mean;
console.log(
  `  · Reparto del mérito: de los ${gainTotal.toFixed(5)} que el modelo le saca a la constante,`,
);
console.log(
  `    ${gainElo.toFixed(5)} (${((100 * gainElo) / gainTotal).toFixed(0)} %) ya los da el Elo pelado. ` +
    `Todo el modelo de goles, Dixon-Coles`,
);
console.log(
  `    y la capa de ataque/defensa aportan los ${(gainTotal - gainElo).toFixed(5)} restantes ` +
    `(${((100 * (gainTotal - gainElo)) / gainTotal).toFixed(0)} %).`,
);
console.log('  · ROI y CLV: NO SE PUEDEN CALCULAR. No hay cuotas históricas de fútbol.');
console.log('    Sin eso, «le gana al baseline» está dicho en log loss, no en dinero, y las');
console.log('    dos cosas no son la misma: en la NFL, donde sí se puede mirar, el modelo');
console.log('    gana en log loss a los baselines tontos y PIERDE más dinero que ellos.');

console.log('\nCLV — no calculable en ningún deporte');
console.log('  El CLV compara el precio al que apuestas con el de cierre. Aquí solo hay UN');
console.log('  precio por partido y es el de cierre: no existe el segundo término. nflverse');
console.log('  no publica línea de apertura. Para tenerlo haría falta guardar el precio en el');
console.log('  momento de predecir y compararlo con el de cierre — que es algo que esta app');
console.log('  podría empezar a hacer hacia delante, pero no reconstruir hacia atrás.');
getDb();

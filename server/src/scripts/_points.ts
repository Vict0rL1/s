// CLI: `npm run study:points [-- --from 20240101] [--lambda-surface 0.05] [--record]`
//
// ===========================================================================
// LA PREGUNTA QUE DECIDE SI ESTO REEMPLAZA ALGO
// ===========================================================================
// El encargo dice «reemplaza cualquier modelo a nivel de partido por un modelo
// jerárquico de puntos». Construirlo es la parte fácil; lo que decide si se publica es si
// PREDICE MEJOR que el que ya hay, medido fuera de muestra.
//
// El modelo actual —Elo por jugador con ajuste de superficie— está medido y tiene track
// record. Sustituirlo porque el nuevo es más elegante sería exactamente el error que este
// repositorio lleva evitando en todo lo demás.
//
// Así que aquí se comparan los dos sobre los mismos partidos, con walk-forward, y lo que
// se publique sale de esa comparación. Si el modelo de puntos pierde, se dice.
//
// ===========================================================================
// WALK-FORWARD DE VERDAD
// ===========================================================================
// El modelo de puntos se REAJUSTA cada trimestre usando solo partidos anteriores a esa
// fecha. Ajustarlo una vez con todo y puntuar el pasado sería mirarse a sí mismo: los
// parámetros de un jugador saldrían en parte de los partidos que se están puntuando.
//
// ===========================================================================
// Y SE PUNTÚA UN MERCADO DERIVADO, NO SOLO EL GANADOR
// ===========================================================================
// El argumento del modelo de puntos no es solo que acierte más el ganador: es que TODOS
// los mercados salen del mismo sitio. Eso solo se puede defender puntuando alguno de los
// derivados, así que se puntúa el TOTAL DE JUEGOS contra el marcador real — algo que el
// modelo de Elo no puede producir en absoluto.

import { getDb } from '../db.ts';
import { fitPoints, pointProbs, type PointsModel, type Surface } from '../points/fit.ts';
import { matchDistribution, overGames, STANDARD_SET, type MatchRules } from '../points/markets.ts';
import { buildPrediction } from '../model/predict.ts';
import { recordExperiment } from '../experiments/registry.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1] ?? 'true']] : [])),
) as Record<string, string>;

const TOUR = args.tour || 'atp';
const FROM = args.from || '20230101';
const REFIT_DAYS = Number(args['refit-days']) || 90;

interface Row {
  date: string;
  surface: Surface;
  w: number;
  l: number;
  bestOf: number;
  score: string;
}

/** Juegos totales de un marcador como «7-6(4) 4-6 7-5». Null si no es puntuable. */
function totalGamesOf(score: string): number | null {
  if (/RET|W\/O|DEF|ABN|Walkover/i.test(score)) return null;
  let total = 0;
  let sets = 0;
  for (const part of score.trim().split(/\s+/)) {
    const m = /^(\d+)-(\d+)/.exec(part);
    if (!m) return null;
    total += Number(m[1]) + Number(m[2]);
    sets++;
  }
  return sets >= 2 ? total : null;
}

function evaluationRows(): Row[] {
  return getDb()
    .prepare(
      `SELECT tourney_date AS date, surface, winner_id AS w, loser_id AS l,
              best_of AS bestOf, score
       FROM matches
       WHERE tour = ? AND tourney_date >= ?
         AND surface IN ('Hard','Clay','Grass')
         AND score IS NOT NULL AND w_svpt IS NOT NULL
       ORDER BY tourney_date`,
    )
    .all(TOUR, FROM) as unknown as Row[];
}

const logLoss = (p: number, hit: boolean): number =>
  -Math.log(Math.max(hit ? p : 1 - p, 1e-9));

function addDays(ymd: string, days: number): string {
  const d = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

console.log('MODELO JERÁRQUICO DE PUNTOS CONTRA EL MODELO DE PARTIDO');
console.log('='.repeat(74));

const rows = evaluationRows();
console.log(`\n${rows.length.toLocaleString('es')} partidos de ${TOUR.toUpperCase()} desde ${FROM}`);
if (rows.length < 200) {
  console.log('Muy pocos para comparar nada. Amplía el rango con --from.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// El barrido de λ y la comparación, todo con el mismo walk-forward
// ---------------------------------------------------------------------------
// `null` = sin desviaciones por superficie, con el flag y no con una λ enorme.
//
// La primera versión de este barrido usaba λ = 1e6 para «apagar» las superficies, y no
// las apagaba: HACÍA DIVERGIR el ajuste (2.003 de 3.126 δ no finitos, verosimilitud NaN).
// La fila salía 1.05661 IDÉNTICA para los cuatro decays, y eso es lo que la delató —
// el decay tiene que cambiar algo. Estaba midiendo un modelo roto y publicándolo como
// «modelo sin superficie».
const lambdas: (number | null)[] = args['lambda-surface']
  ? [args['lambda-surface'] === 'none' ? null : Number(args['lambda-surface'])]
  : [0.05, 0.2, null];
// El decay se barre igual que λ: si pesa lo mismo un partido de 2015 que uno de ayer, el
// modelo describe una carrera y no un jugador. Medido, no supuesto.
const halfLives: (number | null)[] = args['half-life']
  ? [args['half-life'] === 'none' ? null : Number(args['half-life'])]
  : [null, 730, 365, 180];

interface Score {
  n: number;
  points: number;
  elo: number;
  totalsPoints: number;
  totalsBase: number;
  nTotals: number;
}

/** El baseline del total de juegos: la distribución marginal, sin modelo. */
function marginalTotals(): Map<number, number> {
  const counts = new Map<number, number>();
  let n = 0;
  for (const r of rows) {
    const t = totalGamesOf(r.score);
    if (t == null) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    n++;
  }
  const out = new Map<number, number>();
  for (const [k, v] of counts) out.set(k, v / n);
  void n;
  return out;
}
const marginal = marginalTotals();

function rulesFor(bestOf: number): MatchRules {
  return {
    bestOf: bestOf === 5 ? 5 : 3,
    set: STANDARD_SET,
    // Desde 2022 los cuatro Grand Slams usan tiebreak a 10 en el set decisivo. Es la
    // regla vigente y la que se usa por defecto para los mejores de 5.
    decidingSet: bestOf === 5 ? { tiebreak: true, tiebreakTo: 10 } : STANDARD_SET,
  };
}

function run(lambdaSurface: number | null, halfLifeDays: number | null): Score {
  let model: PointsModel | null = null;
  let refitAt = '';
  const s: Score = { n: 0, points: 0, elo: 0, totalsPoints: 0, totalsBase: 0, nTotals: 0 };

  for (const r of rows) {
    if (!model || r.date >= refitAt) {
      model = fitPoints(TOUR, {
        before: r.date,
        ...(lambdaSurface === null ? { useSurface: false } : { lambdaSurface }),
        halfLifeDays,
      });
      refitAt = addDays(r.date, REFIT_DAYS);
    }
    const pp = pointProbs(model, r.w, r.l, r.surface);
    // Sin datos de alguno, el modelo devolvería el jugador medio para los dos y el
    // partido saldría 50/50. Eso no es una predicción; se salta el partido en LOS DOS
    // modelos para que la comparación sea sobre los mismos.
    if (pp.unknown1 || pp.unknown2) continue;

    const rules = rulesFor(r.bestOf);
    const dist = matchDistribution(pp.p1, pp.p2, 1, rules);

    // El Elo PUBLICADO, invocando la misma función que sirve la app. Reimplementarlo
    // aquí es exactamente cómo un backtest acaba midiendo un modelo que ya no existe.
    let eloP: number;
    try {
      eloP = buildPrediction(TOUR, r.w, r.l, r.surface, null, r.bestOf).model.prob1;
    } catch {
      continue;
    }

    // `w` es el ganador real, así que acertar es dar probabilidad alta al jugador 1.
    s.points += logLoss(dist.matchProb, true);
    s.elo += logLoss(eloP, true);
    s.n++;

    const actual = totalGamesOf(r.score);
    if (actual != null) {
      // Se puntúa como un mercado binario sobre la línea más cercana a la esperanza del
      // modelo — que es donde una casa la pondría — para que el número sea comparable.
      const line = Math.round(dist.expectedGames) + 0.5;
      const o = overGames(dist, line);
      s.totalsPoints += logLoss(o.over, actual > line);
      let base = 0;
      for (const [g, p] of marginal) if (g > line) base += p;
      s.totalsBase += logLoss(base, actual > line);
      s.nTotals++;
    }
  }
  return s;
}

console.log(`\nWalk-forward: reajuste cada ${REFIT_DAYS} días, solo con partidos anteriores.`);
console.log('Esto tarda: cada reajuste son ~8 s y hay uno por trimestre.\n');
console.log('  λ superficie   semivida    n      log loss puntos   log loss Elo   diferencia');

let best: { lambda: number | null; halfLife: number | null; score: Score } | null = null;
for (const lam of lambdas) {
  for (const hl of halfLives) {
    const t0 = Date.now();
    const s = run(lam, hl);
    const lp = s.points / s.n;
    const le = s.elo / s.n;
    const label = lam === null ? 'sin superficie' : lam.toFixed(2);
    console.log(
      `  ${label.padEnd(14)} ${(hl === null ? 'sin decay' : `${hl} d`).padEnd(11)} ${String(s.n).padStart(5)}  ` +
        `${lp.toFixed(5).padStart(15)}   ${le.toFixed(5).padStart(12)}   ` +
        `${(lp - le >= 0 ? '+' : '') + (lp - le).toFixed(5)}` +
        `${lp < le ? '  ← puntos mejor' : ''}   (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
    );
    if (!best || s.points / s.n < best.score.points / best.score.n) {
      best = { lambda: lam, halfLife: hl, score: s };
    }
  }
}

const b = best!;
const lp = b.score.points / b.score.n;
const le = b.score.elo / b.score.n;

console.log(
  `\nMEJOR CONFIGURACIÓN: λ superficie ${b.lambda === null ? 'ninguna (sin δ)' : b.lambda} · ` +
    `${b.halfLife === null ? 'sin decay' : `semivida ${b.halfLife} días`}`,
);
console.log(
  `  modelo de puntos ${lp.toFixed(5)} · Elo ${le.toFixed(5)} · ` +
    `${lp < le ? `el de puntos gana por ${(le - lp).toFixed(5)}` : `el Elo gana por ${(lp - le).toFixed(5)}`}`,
);

// ---------------------------------------------------------------------------
// El mercado derivado que el modelo de partido NO puede producir
// ---------------------------------------------------------------------------
if (b.score.nTotals > 0) {
  const tp = b.score.totalsPoints / b.score.nTotals;
  const tb = b.score.totalsBase / b.score.nTotals;
  console.log(`\nTOTAL DE JUEGOS (${b.score.nTotals.toLocaleString('es')} partidos con marcador completo)`);
  console.log(`  modelo de puntos  ${tp.toFixed(5)}`);
  console.log(`  distribución marginal (sin modelo)  ${tb.toFixed(5)}`);
  console.log(
    tp < tb
      ? `  → el modelo de puntos aporta ${(tb - tp).toFixed(5)} sobre no saber nada.`
      : `  → NO aporta nada sobre la marginal (${(tp - tb).toFixed(5)} peor).`,
  );
  console.log(
    '\n  El Elo no aparece en esta tabla porque no puede: no produce una distribución\n' +
      '  de juegos. Ese es el argumento del modelo de puntos que no se ve en el log loss\n' +
      '  del ganador — no que acierte más, sino que contesta preguntas que el otro no.',
  );
}

// ---------------------------------------------------------------------------
// El veredicto, dicho sin rodeos
// ---------------------------------------------------------------------------
console.log('\nVEREDICTO');
if (lp < le) {
  console.log(
    `  El modelo de puntos gana por ${(le - lp).toFixed(5)} de log loss. Sustituir el\n` +
      '  modelo de partido está respaldado por esta medición.',
  );
} else {
  console.log(
    `  El modelo de puntos PIERDE por ${(lp - le).toFixed(5)} de log loss. NO sustituye al\n` +
      '  modelo de partido, y forzarlo sería cambiar un modelo medido por uno más elegante.\n' +
      '\n' +
      '  Por qué, con lo que se puede afirmar desde aquí: las tasas de punto agregadas\n' +
      '  TIRAN la información de quién ganó. Se puede ganar el 63 % de los puntos al saque\n' +
      '  y perder el partido por haber perdido los importantes, y este modelo no puede\n' +
      '  distinguir las dos cosas. El Elo aprende de victorias, que es justo lo que se\n' +
      '  está prediciendo.\n' +
      '\n' +
      '  Lo que el modelo de puntos SÍ aporta es lo de abajo: mercados que el de partido\n' +
      '  no puede producir en absoluto.',
  );
}

console.log('\nLO QUE ESTA COMPARACIÓN NO ES');
console.log(
  '  · No es un holdout. El tenis no tiene uno registrado en experiments/holdout.ts,\n' +
    '    así que esto es una medición de validación y se ha mirado más de una vez.\n' +
    '  · El Elo se evalúa con sus ratings ACTUALES, no reajustados a cada fecha. Eso le\n' +
    '    da ventaja —conoce partidos posteriores— así que si el de puntos gana aquí, gana\n' +
    '    contra una versión del Elo mejor de la que se podría haber usado en su día.',
);

if (args.record) {
  recordExperiment({
    hypothesis:
      'Un modelo jerárquico de puntos (saque y resto por jugador ajustados por rival, ' +
      'con desviaciones por superficie encogidas) predice el ganador mejor que el Elo ' +
      'por partido con ajuste de superficie.',
    dataset: { sport: 'tennis' as never, split: 'validation', n: b.score.n },
    features: ['saque/resto conjunto', 'ajuste por rival', 'δ por superficie', 'cadena de Markov'],
    hyperparams: {
      lambdaSurface: b.lambda ?? 0,
      useSurface: b.lambda !== null,
      halfLifeDays: b.halfLife ?? 0,
      refitDays: REFIT_DAYS,
      from: FROM,
      tour: TOUR,
    },
    metric: 'logloss',
    baseline: 'Elo por jugador con ajuste de superficie (el modelo publicado)',
    result: { delta: lp - le, ciLo: 0, ciHi: 0, p: 0.5, n: b.score.n },
    verdict: lp < le ? 'shipped' : 'rejected',
    notes:
      `Walk-forward con reajuste cada ${REFIT_DAYS} días. El Elo juega con ventaja: sus ` +
      'ratings son los actuales, no los de cada fecha. Sin intervalo de confianza en esta ' +
      'ejecución: el bootstrap emparejado sobre walk-forward exigiría reajustar por cada ' +
      'remuestreo. El delta es la diferencia de log loss; negativo = el de puntos mejora.',
  });
  console.log('\nAnotado en el registro de experimentos.');
}

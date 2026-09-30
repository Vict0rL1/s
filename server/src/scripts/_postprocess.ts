// Ajustar la capa de post-proceso: calibrar, mezclar con el mercado y encoger.
//
// CLI: `npm run study:postprocess`
//
// ===========================================================================
// LA REGLA QUE ORDENA TODO ESTE FICHERO
// ===========================================================================
// Cada pieza tiene que GANARSE el sitio fuera de muestra. Un calibrador que mejora sobre
// los partidos con los que se ajustó no ha demostrado nada: la isotónica puede clavar el
// conjunto de ajuste y ser peor que no hacer nada en el siguiente partido. Así que:
//
//     se AJUSTA con temporadas de entrenamiento
//     se ELIGE mirando la temporada de validación, una vez
//     el holdout final no se toca
//
// Y si ninguno mejora, se guarda 'ninguno' y la capa no transforma nada. Es un resultado
// legítimo y se escribe tal cual.
//
// ===========================================================================
// POR QUÉ EL PESO DE LA MEZCLA SOLO SE PUEDE AJUSTAR EN LA NFL
// ===========================================================================
// Ajustar «cuánto peso darle al mercado» exige tener el precio de partidos YA JUGADOS.
// En esta base de datos eso solo existe para la NFL: 5.281 moneylines de cierre reales.
// El fútbol, el tenis, el baloncesto y el béisbol tienen cero cuotas históricas — la
// fuente que las trae (football-data.co.uk) no es alcanzable desde aquí, y la API de
// cuotas solo da partidos FUTUROS.
//
// La respuesta a eso NO es poner un peso a ojo ni copiar el de la NFL. Es dejar la
// mezcla apagada, decir por qué, y dejar montado el camino por el que se enciende sola:
// `*_prediction_log` guarda modelo y mercado de cada partido que la app predice, así que
// en cuanto haya suficientes partidos resueltos en la máquina de quien la use, este
// mismo script ajusta el peso con SUS datos.

import { getDb } from '../db.ts';
import { footballConfig } from '../config.ts';
import { loadMatches, replayMatches, DC_HYPER } from '../football/ratings.ts';
import { scoreDistribution, outcomeProbabilities, DIXON_COLES_RHO } from '../football/model.ts';
import { expectedGoalsDc, type DcMatch } from '../football/bayes/dixonColes.ts';
import { DcWalkForward } from '../football/bayes/walkforward.ts';
import { dcUsableFor } from '../football/bayes/repo.ts';
import { listGamesWithMarket } from '../nfl/repo.ts';
import { replayGames } from '../nfl/ratings.ts';
import { buildDistribution, outcomeProbabilities as nflOutcomes } from '../nfl/model.ts';
import { devig, americanToDecimal } from '../market/devig.ts';
import { splitOf, VALIDATION_SEASON, FINAL_HOLDOUT_FROM } from '../experiments/holdout.ts';
import { recordExperiment, pairedBootstrap, familySize } from '../experiments/registry.ts';
import { fitPlatt, applyPlatt } from '../postprocess/platt.ts';
import { fitIsotonic, applyIsotonic, type Isotonic } from '../postprocess/isotonic.ts';
import { blend, type BlendParams } from '../postprocess/blend.ts';
import {
  readPostprocess,
  writePostprocess,
  type SportPostprocess,
  type CalibratorKind,
} from '../postprocess/params.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1]]] : [])),
) as Record<string, string>;

// ---------------------------------------------------------------------------
// Métricas

/** Una predicción out-of-sample: lo que dijo el modelo y lo que pasó. */
interface Sample {
  season: number;
  /** Probabilidades del modelo, en orden fijo. */
  p: number[];
  /** Índice del resultado que ocurrió. */
  outcome: number;
  /** Probabilidades del mercado sin margen, si las hay. */
  market: number[] | null;
}

const logLoss = (s: Sample[], probs: (x: Sample) => number[]): number =>
  s.reduce((acc, x) => acc - Math.log(Math.max(probs(x)[x.outcome], 1e-12)), 0) / Math.max(1, s.length);

const perSample = (s: Sample[], probs: (x: Sample) => number[]): number[] =>
  s.map((x) => -Math.log(Math.max(probs(x)[x.outcome], 1e-12)));

const brier = (s: Sample[], probs: (x: Sample) => number[]): number =>
  s.reduce((acc, x) => {
    const q = probs(x);
    return acc + q.reduce((t, v, k) => t + (v - (k === x.outcome ? 1 : 0)) ** 2, 0);
  }, 0) / Math.max(1, s.length);

/**
 * Error de calibración esperado sobre el resultado que ocurrió.
 *
 * Se mide sobre la probabilidad dada a CADA resultado, no solo al favorito: un modelo
 * puede tener bien el favorito y mentir en el empate, y la media sobre favoritos no lo
 * vería.
 */
function ece(s: Sample[], probs: (x: Sample) => number[], bins = 20): number {
  const acc = Array.from({ length: bins }, () => ({ n: 0, sum: 0, hit: 0 }));
  for (const x of s) {
    const q = probs(x);
    for (let k = 0; k < q.length; k++) {
      const b = Math.min(bins - 1, Math.floor(q[k] * bins));
      acc[b].n++;
      acc[b].sum += q[k];
      acc[b].hit += k === x.outcome ? 1 : 0;
    }
  }
  const total = acc.reduce((t, b) => t + b.n, 0);
  return acc.reduce(
    (t, b) => (b.n === 0 ? t : t + (b.n / total) * Math.abs(b.sum / b.n - b.hit / b.n)),
    0,
  );
}

// ---------------------------------------------------------------------------
// Generar las predicciones out-of-sample

/** Fútbol: el mismo camino que producción — Dixon-Coles, y Elo donde aquel no llega. */
function footballSamples(): Sample[] {
  const out: Sample[] = [];
  for (const league of footballConfig.leagues.map((l) => l.id)) {
    const matches = loadMatches(league as never, 0);
    if (matches.length < 200) continue;
    const dcRows: DcMatch[] = matches.map((m) => ({
      date: m.match_date,
      homeId: m.home_id,
      awayId: m.away_id,
      homeGoals: m.home_goals,
      awayGoals: m.away_goals,
    }));
    const wf = new DcWalkForward(dcRows, DC_HYPER);
    replayMatches(matches, {
      onMatch: ({ match, home, away, lambda }) => {
        if (home.matches < 20 || away.matches < 20) return;
        const season = Number(match.season);
        if (splitOf('football', season) === 'holdout') return;
        const dc = wf.paramsFor(match.match_date);
        const usable = dcUsableFor(dc, match.home_id, match.away_id);
        const lam = usable ? expectedGoalsDc(dc!, match.home_id, match.away_id) : lambda;
        const dist = scoreDistribution(lam.home, lam.away, usable ? dc!.rho : DIXON_COLES_RHO);
        const o = outcomeProbabilities(dist);
        out.push({
          season,
          p: [o.home, o.draw, o.away],
          outcome: match.result === 'H' ? 0 : match.result === 'D' ? 1 : 2,
          // La columna existe; en esta base está vacía y por eso la mezcla queda
          // apagada para el fútbol. Se lee igualmente: el día que haya cuotas, funciona.
          market:
            match.odds_home && match.odds_draw && match.odds_away
              ? devig([match.odds_home, match.odds_draw, match.odds_away]).probs
              : null,
        });
      },
    });
  }
  return out;
}

/** NFL: el modelo publicado contra el moneyline de cierre real. */
function nflSamples(): Sample[] {
  const games = listGamesWithMarket('nfl');
  const market = new Map<string, number[]>();
  for (const g of games as unknown as {
    id: string;
    close_ml_home: number | null;
    close_ml_away: number | null;
  }[]) {
    if (g.close_ml_home != null && g.close_ml_away != null) {
      market.set(
        g.id,
        devig([americanToDecimal(g.close_ml_home), americanToDecimal(g.close_ml_away)]).probs,
      );
    }
  }
  const out: Sample[] = [];
  replayGames(games as never, {
    onGame: ({ game, expectedMargin, expectedTotal }: {
      game: { id: string; season: number; home_points: number; away_points: number };
      expectedMargin: number;
      expectedTotal: number;
    }) => {
      const margin = game.home_points - game.away_points;
      if (margin === 0) return; // el moneyline se anula en empate
      if (splitOf('nfl', game.season) === 'holdout') return;
      const m = market.get(game.id);
      if (!m) return;
      const o = nflOutcomes(buildDistribution(expectedMargin, expectedTotal));
      const pHome = o.home / (o.home + o.away);
      out.push({
        season: game.season,
        p: [pHome, 1 - pHome],
        outcome: margin > 0 ? 0 : 1,
        market: m,
      });
    },
  } as never);
  return out;
}

/**
 * El registro de predicciones de la app: modelo y mercado del mismo partido.
 *
 * Es la vía por la que un deporte sin cuotas históricas acaba teniendo su propio peso
 * ajustado. Aquí devuelve poco o nada; en la máquina de quien use la app se llena solo.
 */
function logSamples(sport: 'football' | 'nfl'): Sample[] {
  const db = getDb();
  if (sport === 'football') {
    const rows = db
      .prepare(
        `SELECT prob_home, prob_draw, prob_away,
                market_prob_home, market_prob_draw, market_prob_away,
                home_goals, away_goals, commence_time
         FROM fb_prediction_log
         WHERE resolved_at IS NOT NULL AND home_goals IS NOT NULL
           AND market_prob_home IS NOT NULL`,
      )
      .all() as unknown as Record<string, number | string>[];
    return rows.map((r) => ({
      season: Number(String(r.commence_time).slice(0, 4)),
      p: [Number(r.prob_home), Number(r.prob_draw), Number(r.prob_away)],
      outcome:
        Number(r.home_goals) > Number(r.away_goals)
          ? 0
          : Number(r.home_goals) === Number(r.away_goals)
            ? 1
            : 2,
      market: [
        Number(r.market_prob_home),
        Number(r.market_prob_draw),
        Number(r.market_prob_away),
      ],
    }));
  }
  const rows = db
    .prepare(
      `SELECT prob_home, market_prob_home, home_points, away_points, commence_time
       FROM naf_prediction_log
       WHERE resolved_at IS NOT NULL AND home_points IS NOT NULL
         AND market_prob_home IS NOT NULL AND home_points <> away_points`,
    )
    .all() as unknown as Record<string, number | string>[];
  return rows.map((r) => ({
    season: Number(String(r.commence_time).slice(0, 4)),
    p: [Number(r.prob_home), 1 - Number(r.prob_home)],
    outcome: Number(r.home_points) > Number(r.away_points) ? 0 : 1,
    market: [Number(r.market_prob_home), 1 - Number(r.market_prob_home)],
  }));
}

// ---------------------------------------------------------------------------
// El ajuste de un deporte

const norm = (p: number[]): number[] => {
  const c = p.map((x) => Math.max(1e-9, x));
  const s = c.reduce((t, x) => t + x, 0);
  return c.map((x) => x / s);
};

function fitIsotonicAll(train: Sample[], K: number): Isotonic[] | null {
  const curves: Isotonic[] = [];
  for (let k = 0; k < K; k++) {
    const c = fitIsotonic(
      train.map((s) => ({ x: s.p[k], y: s.outcome === k ? 1 : 0 })),
    );
    if (!c) return null;
    curves.push(c);
  }
  return curves;
}

interface SportResult {
  key: string;
  label: string;
  pp: SportPostprocess;
}

function study(key: string, label: string, all: Sample[], logRows: Sample[]): SportResult | null {
  const sport = key as 'football' | 'nfl';
  console.log(`\n${'='.repeat(92)}\n${label}\n${'='.repeat(92)}`);
  if (all.length < 1000) {
    console.log('  Sin predicciones suficientes. Nada que ajustar.');
    return null;
  }
  const K = all[0].p.length;
  const valSeason = VALIDATION_SEASON[sport];
  // ===========================================================================
  // TRES TRAMOS, NO DOS
  // ===========================================================================
  // Elegir entre tres calibradores mirando la validación y luego PUBLICAR el número de
  // validación del ganador es el mismo error que este proyecto lleva un registro entero
  // intentando no cometer: el ganador de tres se lleva algo de suerte, y el número
  // publicado se la lleva con él.
  //
  // Así que el entrenamiento se parte: se AJUSTA con lo más viejo, se ELIGE con la
  // última temporada de entrenamiento, y la validación solo ve un procedimiento ya
  // cerrado. Así el número de validación mide lo que de verdad se va a publicar.
  const selectSeason = valSeason - 1;
  const fit = all.filter((s) => s.season < selectSeason);
  const select = all.filter((s) => s.season === selectSeason);
  const train = all.filter((s) => s.season < valSeason);
  const val = all.filter((s) => s.season === valSeason);
  console.log(
    `  ${all.length.toLocaleString('es')} predicciones fuera de muestra · ` +
      `ajuste ${fit.length.toLocaleString('es')} (hasta ${selectSeason - 1}) · ` +
      `elección ${select.length.toLocaleString('es')} (${selectSeason}) · ` +
      `validación ${val.length.toLocaleString('es')} (${valSeason}) · ` +
      `holdout ${FINAL_HOLDOUT_FROM[sport]}+ intacto`,
  );
  if (fit.length < 500 || select.length < 200 || val.length < 200) {
    console.log('  Tramos demasiado cortos para decidir nada.');
    return null;
  }

  // ---- 1. Calibración ----
  console.log(
    `\n  [1] CALIBRACIÓN — ajustada hasta ${selectSeason - 1}, elegida con ${selectSeason}, ` +
      `medida en ${valSeason}`,
  );
  const platt = fitPlatt(fit);
  const iso = fitIsotonicAll(fit, K);
  const candidates: [CalibratorKind, (s: Sample) => number[]][] = [
    ['ninguno', (s) => s.p],
  ];
  if (platt) candidates.push(['platt', (s) => norm(applyPlatt(platt, s.p))]);
  if (iso) {
    candidates.push(['isotonic', (s) => norm(s.p.map((p, k) => applyIsotonic(iso[k], p)))]);
  }

  // ===========================================================================
  // LA REGLA DE ELECCIÓN, ESCRITA ANTES DE MIRAR NADA
  // ===========================================================================
  // No basta con «el que salga más bajo». Con 282 partidos, la diferencia entre tres
  // métodos es ruido casi siempre, y quedarse con el mínimo de tres ruidos es quedarse
  // con el más afortunado: eso fue exactamente lo que pasó en la primera versión, que
  // eligió la isotónica para la NFL por 0,0027 sobre 282 partidos y luego salió PEOR que
  // no calibrar en la temporada siguiente.
  //
  // Así que un calibrador solo entra si le gana a NO CALIBRAR con el intervalo del
  // bootstrap entero por debajo de cero, en el tramo de elección. Si ninguno lo
  // consigue, gana 'ninguno' — que es la respuesta correcta cuando no hay señal.
  const rawSelect = perSample(select, (s) => s.p);
  console.log(
    `    método      log loss ${selectSeason}   vs. no calibrar (IC 95 %)          ` +
      `log loss ${valSeason}   Brier     ECE`,
  );
  let best: { kind: CalibratorKind; fn: (s: Sample) => number[]; ll: number } | null = null;
  for (const [kind, fn] of candidates) {
    const sel = logLoss(select, fn);
    const d = kind === 'ninguno' ? null : pairedBootstrap(rawSelect, perSample(select, fn));
    const verdict = d
      ? `${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(5)} [${d.lo.toFixed(5)}, ${d.hi.toFixed(5)}]`
      : '—                            ';
    console.log(
      `    ${kind.padEnd(11)} ${sel.toFixed(5)}         ${verdict.padEnd(33)} ` +
        `${logLoss(val, fn).toFixed(5)}   ${brier(val, fn).toFixed(5)}   ${ece(val, fn).toFixed(5)}`,
    );
    // Solo compiten los que superan la puerta; 'ninguno' es el suelo por definición.
    if (d && d.hi < 0 && (!best || sel < best.ll)) best = { kind, fn, ll: sel };
  }
  if (!best) {
    console.log(
      '    Ningún calibrador le gana a no calibrar con el intervalo entero por debajo ' +
        'de cero en el tramo de elección.',
    );
    best = { kind: 'ninguno', fn: (s) => s.p, ll: logLoss(select, (s) => s.p) };
  }
  // A partir de aquí el ganador ya está fijado; lo que se reporta es su validación.
  best = { ...best, ll: logLoss(val, best.fn) };
  const rawLl = logLoss(val, (s) => s.p);
  const rawArr = perSample(val, (s) => s.p);
  const calArr = perSample(val, best!.fn);
  const calDiff = pairedBootstrap(rawArr, calArr);
  if (platt) {
    console.log(
      `    Platt: a = ${platt.a.toFixed(3)} (por debajo de 1 = el modelo era demasiado ` +
        `tajante) · sesgos ${platt.b.map((x) => x.toFixed(3)).join(' / ')}`,
    );
  }
  console.log(
    `\n    Elegido: ${best!.kind}  ` +
      `(${calDiff.mean >= 0 ? '+' : ''}${calDiff.mean.toFixed(5)} de log loss, ` +
      `IC [${calDiff.lo.toFixed(5)}, ${calDiff.hi.toFixed(5)}], p = ${calDiff.p.toFixed(4)})`,
  );
  if (best!.kind !== 'ninguno' && calDiff.hi >= 0) {
    console.log(
      '    ⚠ Gana en la media pero el intervalo contiene el cero: la mejora NO está ' +
        'demostrada, solo es la mejor apuesta disponible.',
    );
  }
  // El listón de verdad no es 0,05: es 0,05 partido por cuántas veces se ha mirado ya
  // este mismo conjunto. Sin esta línea, un p = 0,04 sobre la decimosexta comparación
  // se leería como un hallazgo cuando es lo que el azar produce por aritmética.
  const k = familySize({ sport, split: 'validation', n: val.length }) + 1;
  const alpha = 0.05 / k;
  if (best!.kind !== 'ninguno') {
    console.log(
      calDiff.p < alpha
        ? `    Pasa Bonferroni: p = ${calDiff.p.toFixed(4)} < ${alpha.toFixed(5)} (${k} comparaciones).`
        : `    ⚠ NO pasa Bonferroni: p = ${calDiff.p.toFixed(4)}, hace falta < ${alpha.toFixed(5)} ` +
            `(${k} comparaciones sobre este conjunto). Se aplica igualmente —es el mejor de los\n` +
            '      tres y la alternativa es no calibrar— pero la mejora es pequeña y la evidencia\n' +
            '      no la sostiene por sí sola.',
    );
  }

  // ---- 2 y 3. Mezcla con el mercado y encogimiento ----
  console.log('\n  [2+3] MEZCLA CON EL MERCADO Y ENCOGIMIENTO');
  const trainMkt = train.filter((s) => s.market);
  const valMkt = val.filter((s) => s.market);
  let blendParams: BlendParams | null = null;
  let blendNote: string | undefined;
  let finalLl: number | null = null;

  if (trainMkt.length < 500 || valMkt.length < 200) {
    const extra = logRows.filter((s) => s.market).length;
    blendNote =
      `sin cuotas históricas suficientes (${trainMkt.length} en entrenamiento, ` +
      `${valMkt.length} en validación; el registro de predicciones aporta ${extra}). ` +
      'La mezcla queda APAGADA: el peso se ajusta por backtest o no se pone.';
    console.log(`    ${blendNote}`);
    console.log(
      '    Se enciende sola: cada partido que la app predice queda en ' +
        `${sport === 'football' ? 'fb' : 'naf'}_prediction_log con el precio del día, y ` +
        'al resolverse entra aquí. Volver a correr este script cuando haya unos cientos.',
    );
  } else {
    // Rejilla sobre ENTRENAMIENTO. La validación se mira una vez, al final.
    const WS = Array.from({ length: 21 }, (_, i) => i / 20);
    const KS = [0, 0.25, 0.5, 1, 2, 4, 8];
    let bestB: { p: BlendParams; ll: number } | null = null;
    for (const w of WS) {
      for (const kappa of KS) {
        const cand: BlendParams = { w, kappa };
        const ll = logLoss(trainMkt, (s) => blend(best!.fn(s), norm(s.market!), cand).probs);
        if (!bestB || ll < bestB.ll) bestB = { p: cand, ll };
      }
    }
    blendParams = bestB!.p;
    const marketOnly = logLoss(valMkt, (s) => norm(s.market!));
    const calOnly = logLoss(valMkt, best!.fn);
    const blended = logLoss(valMkt, (s) => blend(best!.fn(s), norm(s.market!), blendParams!).probs);
    finalLl = blended;
    console.log(
      `    Peso ajustado en entrenamiento: w = ${blendParams.w.toFixed(2)} · ` +
        `κ = ${blendParams.kappa}` +
        (blendParams.kappa > 0
          ? ` (el peso del modelo se parte por la mitad al discrepar ${(1 / blendParams.kappa).toFixed(2)} nats)`
          : ' (sin encogimiento: no mejoró)'),
    );
    console.log(`\n    sobre ${valMkt.length.toLocaleString('es')} partidos de validación:`);
    console.log('      solo el mercado      ' + marketOnly.toFixed(5));
    console.log('      solo el modelo       ' + calOnly.toFixed(5));
    console.log('      mezcla               ' + blended.toFixed(5));
    const vsMarket = pairedBootstrap(
      perSample(valMkt, (s) => norm(s.market!)),
      perSample(valMkt, (s) => blend(best!.fn(s), norm(s.market!), blendParams!).probs),
    );
    console.log(
      `\n      mezcla vs. mercado: ${vsMarket.mean >= 0 ? '+' : ''}${vsMarket.mean.toFixed(5)} ` +
        `IC [${vsMarket.lo.toFixed(5)}, ${vsMarket.hi.toFixed(5)}] p = ${vsMarket.p.toFixed(4)}`,
    );
    // Lo que hay que decir sin adornos: si el peso sale bajo, el modelo no aporta.
    if (blendParams.w <= 0.2) {
      console.log(
        `\n    ⚠ El peso óptimo del MODELO es ${blendParams.w.toFixed(2)}. Traducido: el ` +
          'backtest dice que la mejor forma de usar este modelo es casi ignorarlo y\n' +
          '      copiar el precio. La mezcla mejora sobre el modelo solo porque el mercado\n' +
          '      hace el trabajo, no porque los dos se complementen.',
      );
    }
    if (vsMarket.lo > 0) {
      console.log(
        '    ⚠ Y la mezcla es PEOR que el mercado solo, de forma significativa. Ni ' +
          'mezclado aporta nada.',
      );
    }
  }

  // ---- registro ----
  const pp: SportPostprocess = {
    calibrator: best!.kind,
    ...(best!.kind === 'platt' && platt ? { platt } : {}),
    ...(best!.kind === 'isotonic' && iso ? { isotonic: iso } : {}),
    blend: blendParams,
    measured: {
      rawLogLoss: rawLl,
      calibratedLogLoss: best!.ll,
      finalLogLoss: finalLl,
      n: val.length,
      split: `validación ${valSeason}`,
      ...(blendNote ? { blendNote } : {}),
    },
    measuredAt: new Date().toISOString(),
  };

  if (args.record !== 'false') {
    recordExperiment({
      hypothesis: `calibrar la salida (${best!.kind}) mejora el log loss de ${label.toLowerCase()}`,
      dataset: { sport, split: 'validation', n: val.length },
      features: ['post-proceso', 'calibracion', best!.kind],
      hyperparams: platt
        ? { metodo: best!.kind, a: Number(platt.a.toFixed(4)) }
        : { metodo: best!.kind },
      metric: 'logloss',
      baseline: 'probabilidad cruda del modelo',
      result: {
        delta: calDiff.mean,
        ciLo: calDiff.lo,
        ciHi: calDiff.hi,
        p: calDiff.p,
        n: val.length,
      },
      verdict: best!.kind === 'ninguno' ? 'rejected' : 'shipped',
      notes:
        best!.kind === 'ninguno'
          ? 'Se probaron Platt e isotónica y ninguna mejoró fuera de muestra; no se aplica ninguna.'
          : `Elegido entre Platt e isotónica por log loss en validación. ECE ${ece(val, best!.fn).toFixed(5)}.`,
    });
    if (blendParams) {
      const vm = pairedBootstrap(
        perSample(valMkt, (s) => norm(s.market!)),
        perSample(valMkt, (s) => blend(best!.fn(s), norm(s.market!), blendParams!).probs),
      );
      recordExperiment({
        hypothesis: `mezclar el modelo con el mercado mejora sobre el mercado solo en ${label.toLowerCase()}`,
        dataset: { sport, split: 'validation', n: valMkt.length },
        features: ['post-proceso', 'mezcla-logaritmica', 'encogimiento'],
        hyperparams: { w: blendParams.w, kappa: blendParams.kappa, elegidoCon: 'entrenamiento' },
        metric: 'logloss',
        baseline: 'línea de cierre sin margen',
        result: { delta: vm.mean, ciLo: vm.lo, ciHi: vm.hi, p: vm.p, n: valMkt.length },
        verdict: 'shipped',
        notes:
          `Peso del modelo w = ${blendParams.w.toFixed(2)}, κ = ${blendParams.kappa}. ` +
          'La mezcla se publica; esta comparación dice si aporta algo SOBRE EL PRECIO, que ' +
          'es la pregunta que importa cuando hay mercado.',
      });
    }
  }
  return { key, label, pp };
}

// ===========================================================================
console.log(
  'CAPA DE POST-PROCESO — calibración, mezcla con el mercado y encogimiento\n' +
    'Cada pieza se ajusta con entrenamiento y se juzga en validación. El holdout no se toca.',
);

const results: SportResult[] = [];
const fb = study('football', 'FÚTBOL (1X2)', footballSamples(), logSamples('football'));
if (fb) results.push(fb);
const nfl = study('nfl', 'NFL (ganador)', nflSamples(), logSamples('nfl'));
if (nfl) results.push(nfl);

const file = readPostprocess();
for (const r of results) file[r.key] = r.pp;
writePostprocess(file);

console.log(`\n${'='.repeat(92)}`);
console.log('Guardado en experiments/postprocess.json. La app lo lee al predecir.');
for (const r of results) {
  const m = r.pp.measured;
  console.log(
    `  ${r.label.padEnd(16)} calibrador ${r.pp.calibrator.padEnd(9)} · ` +
      `mezcla ${r.pp.blend ? `w ${r.pp.blend.w.toFixed(2)} κ ${r.pp.blend.kappa}` : 'apagada'} · ` +
      `log loss ${m.rawLogLoss.toFixed(5)} → ${m.calibratedLogLoss.toFixed(5)}` +
      (m.finalLogLoss !== null ? ` → ${m.finalLogLoss.toFixed(5)}` : ''),
  );
}
for (const r of results) {
  console.log(
    `\n  Experimentos sobre ${r.key}/validation: ` +
      `${familySize({ sport: r.key as never, split: 'validation', n: r.pp.measured.n })}. ` +
      'Ver `npm run experiments`.',
  );
}

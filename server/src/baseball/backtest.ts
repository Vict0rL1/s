// CLI: `npm run backtest:bsb [-- --pitcher 0.55 --dispersion 4 --home 24]`
//
// Walk-forward test of the baseball model. Drives the same `replayGames` the app
// uses and reads the λ IT computed, so the numbers describe the shipped model
// rather than a copy of its arithmetic that has quietly drifted.
//
// WHAT IS BEING MEASURED, AND WHY THESE METRICS
//
// Accuracy is nearly useless in baseball. The best team in the league wins about
// 60% of its games and the worst wins 40%, so "pick the better team every time"
// scores around 57% and a model has perhaps three points of headroom above it.
// Brier and log loss measure whether the PROBABILITY is right, which is the only
// thing a 55/45 sport can be judged on.
//
// The run distribution gets its own metrics, because it drives the two markets
// people actually bet in baseball: the total (over/under) and the run line.
//
// Tunable, so each piece is measured rather than assumed:
//   --pitcher <w>       how much of a starter's rate reaches the score (0 = off)
//   --regression <n>    starts before a pitcher's own rate is trusted
//   --dispersion <r>    negative binomial r (1e9 = plain Poisson)
//   --home <elo>        home advantage (0 = none)
//   --k <n>             K-factor
//   --carryover <0..1>  rating surviving the winter
//   --sensitivity <n>   Elo → runs conversion
//   --share <n>         share of runs scored by the home side
//   --rundiff <w>       run-difference weighting on K (0 = win/loss only)
//   --extra <p>         home win rate in extra innings

import { baseballConfig } from '../config.ts';
import {
  impliedFromMoneyline,
  overProbability,
  runDistribution,
  runLine,
  winProbability,
  EXTRA_INNINGS_HOME,
  HOME_ADVANTAGE,
  HOME_RUN_SHARE,
  K_FACTOR,
  PITCHER_REGRESSION_STARTS,
  PITCHER_WEIGHT,
  RUN_DIFF_WEIGHT,
  RUN_DISPERSION,
  RUN_SENSITIVITY,
  SEASON_CARRYOVER,
} from './model.ts';
import { firstSeasonRunAverage, loadGames, replayGames } from './ratings.ts';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[a.slice(2)] = next;
      i++;
    } else args[a.slice(2)] = true;
  }
  return args;
}

const TOTAL_LINE = 8.5;

export interface BacktestTotals {
  n: number;
  brier: number;
  logLoss: number;
  accuracy: number;
  runMae: number;
  overAccuracy: number;
  /** Brier score on "the home team wins by 2 or more". Accuracy is degenerate
   * here: the answer is under 50% in nearly every game, so always saying "no"
   * scores 63% while knowing nothing. */
  runLineBrier: number;
  /** Mean predicted total minus mean actual total: bias, not error. */
  totalBias: number;
  extraPredicted: number;
  extraActual: number;
}

export function runBacktest(opts: {
  league?: string;
  fromSeason?: number;
  warmup?: number;
  homeAdvantage?: number;
  k?: number;
  carryover?: number;
  runDiffWeight?: number;
  runSensitivity?: number;
  homeRunShare?: number;
  pitcherWeight?: number;
  pitcherRegressionStarts?: number;
  pitcherCarryover?: number;
  dispersion?: number;
  extraHome?: number;
  /** Collect calibration bands as well. */
  bands?: Map<string, { n: number; pred: number; obs: number }>;
}): BacktestTotals {
  const warmup = opts.warmup ?? 60;
  const dispersion = opts.dispersion ?? RUN_DISPERSION;
  const extraHome = opts.extraHome ?? EXTRA_INNINGS_HOME;
  const leagues = baseballConfig.leagues
    .filter((l) => !opts.league || l.id === opts.league)
    .map((l) => l.id);

  let n = 0;
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  let runMae = 0;
  let overOk = 0;
  let lineBrier = 0;
  let predTotal = 0;
  let actualTotal = 0;
  let extraPredicted = 0;
  let extraActual = 0;

  for (const league of leagues) {
    const games = loadGames(league, opts.fromSeason ?? 0);
    if (games.length === 0) continue;
    const anchor = firstSeasonRunAverage(games);

    replayGames(games, {
      homeAdvantage: opts.homeAdvantage,
      k: opts.k,
      carryover: opts.carryover,
      runDiffWeight: opts.runDiffWeight,
      runSensitivity: opts.runSensitivity,
      homeRunShare: opts.homeRunShare,
      pitcherWeight: opts.pitcherWeight,
      pitcherRegressionStarts: opts.pitcherRegressionStarts,
      pitcherCarryover: opts.pitcherCarryover,
      runsAnchor: anchor,
      onGame: ({ game, home, away, lambda }) => {
        if (home.games < warmup || away.games < warmup) return;
        const dist = runDistribution(lambda.home, lambda.away, dispersion, undefined, extraHome);
        const win = winProbability(dist);
        const homeWon = game.home_runs > game.away_runs ? 1 : 0;

        n++;
        brier += (win.home - homeWon) ** 2;
        logLoss += -Math.log(Math.max(homeWon ? win.home : 1 - win.home, 1e-15));
        if ((win.home > 0.5 ? 1 : 0) === homeWon) correct++;

        const total = game.home_runs + game.away_runs;
        const expected = lambda.home + lambda.away;
        runMae += Math.abs(expected - total);
        predTotal += expected;
        actualTotal += total;

        const pOver = overProbability(dist, TOTAL_LINE);
        if (pOver > 0.5 === total > TOTAL_LINE) overOk++;

        const line = runLine(dist);
        const homeCovered = game.home_runs - game.away_runs >= 2 ? 1 : 0;
        lineBrier += (line.homeCovers - homeCovered) ** 2;

        extraPredicted += win.extraInnings;
        if (game.home_runs === game.away_runs) extraActual++;

        if (opts.bands) {
          const lo = Math.max(0.2, Math.min(0.75, Math.floor(win.home * 20) / 20));
          const key = `${(lo * 100).toFixed(0)}–${((lo + 0.05) * 100).toFixed(0)}%`;
          const b = opts.bands.get(key) ?? { n: 0, pred: 0, obs: 0 };
          b.n++;
          b.pred += win.home;
          b.obs += homeWon;
          opts.bands.set(key, b);
        }
      },
    });
  }

  return {
    n,
    brier: brier / Math.max(1, n),
    logLoss: logLoss / Math.max(1, n),
    accuracy: correct / Math.max(1, n),
    runMae: runMae / Math.max(1, n),
    overAccuracy: overOk / Math.max(1, n),
    runLineBrier: lineBrier / Math.max(1, n),
    totalBias: (predTotal - actualTotal) / Math.max(1, n),
    extraPredicted: extraPredicted / Math.max(1, n),
    extraActual: extraActual / Math.max(1, n),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const num = (k: string, d: number) => (args[k] !== undefined ? Number(args[k]) : d);

  const cfg = {
    league: typeof args.league === 'string' ? args.league : undefined,
    fromSeason: num('from', 0),
    warmup: num('warmup', 60),
    homeAdvantage: num('home', HOME_ADVANTAGE),
    k: num('k', K_FACTOR),
    carryover: num('carryover', SEASON_CARRYOVER),
    runDiffWeight: num('rundiff', RUN_DIFF_WEIGHT),
    runSensitivity: num('sensitivity', RUN_SENSITIVITY),
    homeRunShare: num('share', HOME_RUN_SHARE),
    pitcherWeight: num('pitcher', PITCHER_WEIGHT),
    pitcherRegressionStarts: num('regression', PITCHER_REGRESSION_STARTS),
    dispersion: num('dispersion', RUN_DISPERSION),
    extraHome: num('extra', EXTRA_INNINGS_HOME),
  };

  console.log(
    `Ventaja de campo: ${cfg.homeAdvantage} Elo · K: ${cfg.k} · arrastre: ${cfg.carryover}\n` +
      `Peso del abridor: ${cfg.pitcherWeight} (regresión ${cfg.pitcherRegressionStarts} aperturas) · ` +
      `dispersión: ${cfg.dispersion}\n` +
      `Sensibilidad Elo→carreras: ${cfg.runSensitivity} · cuota local: ${cfg.homeRunShare} · ` +
      `extra innings local: ${cfg.extraHome}`,
  );

  const bands = new Map<string, { n: number; pred: number; obs: number }>();
  const r = runBacktest({ ...cfg, bands });

  if (r.n === 0) {
    console.log('\nSin partidos evaluables. Corre `npm run update-data:bsb` primero.');
    return;
  }

  console.log(`\n=== BÉISBOL — backtest walk-forward ===`);
  console.log(`Partidos evaluados: ${r.n}`);
  console.log(`\nGanador:`);
  console.log(`  Brier: ${r.brier.toFixed(4)}   (0.25 = tirar una moneda)`);
  console.log(`  Log loss: ${r.logLoss.toFixed(4)}   (0.6931 = decir siempre 50%)`);
  console.log(
    `  Acierto: ${(r.accuracy * 100).toFixed(1)}%   (elegir siempre al local ≈ 54%)`,
  );
  console.log(`\nCarreras:`);
  console.log(`  Error absoluto medio del total: ${r.runMae.toFixed(2)} carreras`);
  console.log(
    `  Sesgo del total: ${r.totalBias >= 0 ? '+' : ''}${r.totalBias.toFixed(3)} carreras ` +
      `(0 = ni alto ni bajo de media)`,
  );
  console.log(`  Over/under ${TOTAL_LINE} acertado: ${(r.overAccuracy * 100).toFixed(1)}%`);
  console.log(`  Línea de carreras (±1.5), Brier: ${r.runLineBrier.toFixed(4)}`);
  // The database holds FINAL scores, so a tie is never observed and there is
  // nothing to compare against -- the figure is reported for sanity (MLB runs
  // ~8-9% extra-inning games) rather than scored.
  console.log(
    `\nProbabilidad media de entradas extra: ${(r.extraPredicted * 100).toFixed(1)}% ` +
      `(la referencia real de MLB ronda el 8-9%)`,
  );
  void r.extraActual;

  console.log('\nCalibración de la victoria local (predicho vs real):');
  [...bands.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([band, b]) => {
      if (b.n < 200) return;
      const pred = (b.pred / b.n) * 100;
      const obs = (b.obs / b.n) * 100;
      console.log(
        `  ${band.padEnd(9)} n=${String(b.n).padStart(6)}  predicho ${pred.toFixed(1)}%  ` +
          `real ${obs.toFixed(1)}%  (${obs - pred >= 0 ? '+' : ''}${(obs - pred).toFixed(1)} pp)`,
      );
    });

  console.log(
    '\nNota: mide rendimiento histórico con los abridores REALES de cada partido.\n' +
      'En vivo eso depende de que el feed de probables los haya anunciado.\n',
  );
  void impliedFromMoneyline;
}

if (process.argv[1]?.includes('backtest')) main();

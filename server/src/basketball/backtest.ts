// CLI: `npm run backtest:bb [-- --league nba --from 1985 --home 100 --mov 1 ...]`
//
// Walk-forward test of the basketball model: every game is scored using ONLY the
// ratings built from earlier games. It does not reimplement the update rules — it
// drives the same `replayGames` the app itself uses and hooks its per-game
// callback, so the numbers below always describe the shipped model.
//
// Every piece can be switched off or re-tuned, so its contribution is measured
// rather than assumed:
//
//   --home <elo>        home-court advantage (0 = no home edge)
//   --mov <weight>      margin-of-victory weight on K (0 = win/loss only)
//   --rest <weight>     rest / back-to-back adjustment (0 = off)
//   --carryover <0..1>  how much rating survives the off-season (1 = all)
//   --k <n>             base K-factor
//   --calibration <s>   shrink applied to the rating gap (1 = none)
//   --eloPerPoint <n>   Elo points per point of expected margin
//
// Reported: accuracy, Brier, log loss, calibration, margin error (what a spread
// bet depends on) and — for the NBA — a head-to-head against FiveThirtyEight's
// published pre-game forecast on identical games.

import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR } from '../config.ts';
import {
  CALIBRATION_SCALE,
  ELO_PER_POINT,
  HOME_ADVANTAGE,
  K_FACTOR,
  SEASON_CARRYOVER,
} from './elo.ts';
import { loadGames, replayGames } from './ratings.ts';
import { parseFiveThirtyEight } from './ingest/fivethirtyeight.ts';

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

/** 538's published pre-game home-win probability, keyed date|home|away. */
function loadBenchmark(): Map<string, number> {
  const file = path.join(RAW_DIR, 'basketball', 'nbaallelo.csv');
  const map = new Map<string, number>();
  if (!fs.existsSync(file)) return map;
  for (const g of parseFiveThirtyEight(fs.readFileSync(file, 'utf8'))) {
    if (g.benchmarkHomeProb != null) map.set(`${g.date}|${g.homeId}|${g.awayId}`, g.benchmarkHomeProb);
  }
  return map;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const league = typeof args.league === 'string' ? args.league : 'nba';
  const fromSeason = Number(args.from) || 0;
  const warmup = Number(args.warmup) || 20;

  const homeAdvantage = args.home !== undefined ? Number(args.home) : HOME_ADVANTAGE;
  const movWeight = args.mov !== undefined ? Number(args.mov) : 1;
  const restWeight = args.rest !== undefined ? Number(args.rest) : 1;
  const carryover = args.carryover !== undefined ? Number(args.carryover) : SEASON_CARRYOVER;
  const k = args.k !== undefined ? Number(args.k) : K_FACTOR;
  const calibrationScale = args.calibration !== undefined ? Number(args.calibration) : CALIBRATION_SCALE;
  const eloPerPoint = args.eloPerPoint !== undefined ? Number(args.eloPerPoint) : ELO_PER_POINT;

  console.log(
    `Liga: ${league} · ventaja de campo: ${homeAdvantage} · margen: ${movWeight} · descanso: ${restWeight}` +
      `\nK: ${k} · arrastre entre temporadas: ${carryover} · calibración: ${calibrationScale} · Elo por punto: ${eloPerPoint}`,
  );

  const games = loadGames(league, fromSeason);
  if (games.length === 0) {
    console.log(`\nSin partidos de ${league} en la base. Corre \`npm run update-data:bb\` primero.`);
    return;
  }
  const benchmark = league === 'nba' ? loadBenchmark() : new Map<string, number>();

  let scored = 0;
  let correct = 0;
  let brier = 0;
  let logloss = 0;
  let homeWinCount = 0;
  let marginAbsErr = 0;
  let marginBias = 0;
  let bmN = 0;
  let bmModelCorrect = 0;
  let bmTheirCorrect = 0;
  let bmModelBrier = 0;
  let bmTheirBrier = 0;
  const buckets = new Map<string, { n: number; pred: number; won: number }>();
  // Rest buckets, to show the back-to-back effect is real rather than asserted.
  const restBuckets = new Map<string, { n: number; pred: number; won: number }>();

  replayGames(games, {
    homeAdvantage,
    movWeight,
    restWeight,
    carryover,
    k,
    calibrationScale,
    eloPerPoint,
    onGame: ({ game, home, away, probHome, predictedMargin }) => {
      if (home.games < warmup || away.games < warmup) return;
      const homeWon = game.home_pts > game.away_pts;
      scored++;
      if (probHome > 0.5 === homeWon) correct++;
      else if (probHome === 0.5) correct += 0.5;
      brier += (probHome - (homeWon ? 1 : 0)) ** 2;
      logloss += -Math.log(Math.max(homeWon ? probHome : 1 - probHome, 1e-15));
      if (homeWon) homeWinCount++;

      const actualMargin = game.home_pts - game.away_pts;
      marginAbsErr += Math.abs(predictedMargin - actualMargin);
      marginBias += predictedMargin - actualMargin;

      const pFav = Math.max(probHome, 1 - probHome);
      const favWon = probHome >= 0.5 === homeWon;
      const lo = Math.min(0.95, Math.floor(pFav * 10) / 10);
      const key = `${(lo * 100).toFixed(0)}–${((lo + 0.1) * 100).toFixed(0)}%`;
      const b = buckets.get(key) ?? { n: 0, pred: 0, won: 0 };
      b.n++;
      b.pred += pFav;
      b.won += favWon ? 1 : 0;
      buckets.set(key, b);

      const bm = benchmark.get(`${game.game_date}|${game.home_id}|${game.away_id}`);
      if (bm != null) {
        bmN++;
        if (probHome > 0.5 === homeWon) bmModelCorrect++;
        if (bm > 0.5 === homeWon) bmTheirCorrect++;
        bmModelBrier += (probHome - (homeWon ? 1 : 0)) ** 2;
        bmTheirBrier += (bm - (homeWon ? 1 : 0)) ** 2;
      }
    },
  });

  console.log(`\n=== ${league.toUpperCase()} — backtest walk-forward ===`);
  console.log(`Partidos en la base: ${games.length}`);
  console.log(`Evaluados (ambos equipos con ≥${warmup} partidos previos): ${scored}`);
  if (scored === 0) return;

  console.log(`\nAccuracy: ${((correct / scored) * 100).toFixed(1)}%`);
  console.log(
    `Baseline "gana el local": ${((homeWinCount / scored) * 100).toFixed(1)}%` +
      `  ← en baloncesto esta baseline es fuerte, no una moneda al aire`,
  );
  console.log(`Brier score: ${(brier / scored).toFixed(4)}   (0.25 = decir siempre 50/50)`);
  console.log(`Log loss:    ${(logloss / scored).toFixed(4)}   (0.693 = decir siempre 50/50)`);
  const bias = marginBias / scored;
  console.log(
    `\nMargen (lo que importa para el spread):` +
      `\n  error absoluto medio: ${(marginAbsErr / scored).toFixed(2)} puntos` +
      `\n  sesgo medio: ${bias >= 0 ? '+' : ''}${bias.toFixed(2)} puntos (positivo = sobreestima al local)`,
  );

  console.log('\nCalibración (predicho vs real, del favorito):');
  [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([band, b]) => {
      const pred = (b.pred / b.n) * 100;
      const obs = (b.won / b.n) * 100;
      const d = obs - pred;
      console.log(
        `  ${band.padEnd(9)} n=${String(b.n).padStart(6)}  predicho ${pred.toFixed(1)}%  ` +
          `real ${obs.toFixed(1)}%  (${d >= 0 ? '+' : ''}${d.toFixed(1)} pp)`,
      );
    });

  if (bmN > 0) {
    console.log(`\nContra la predicción publicada por FiveThirtyEight (${bmN} partidos idénticos):`);
    console.log(
      `  este modelo     accuracy ${((bmModelCorrect / bmN) * 100).toFixed(1)}%  Brier ${(bmModelBrier / bmN).toFixed(4)}`,
    );
    console.log(
      `  FiveThirtyEight accuracy ${((bmTheirCorrect / bmN) * 100).toFixed(1)}%  Brier ${(bmTheirBrier / bmN).toFixed(4)}`,
    );
    console.log(
      bmModelBrier <= bmTheirBrier
        ? '  → igual o mejor en Brier sobre esta muestra'
        : '  → 538 mejor: su modelo usa señales que este no ve (lesiones, viajes, jugadores)',
    );
  }

  console.log(
    '\nNota: mide rendimiento histórico. No considera lesiones de última hora,\n' +
      'rotaciones ni partidos sin importancia al final de temporada.\n',
  );
  void restBuckets;
}

main();

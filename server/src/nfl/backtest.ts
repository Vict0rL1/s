// npm run backtest:naf
//
// Walk-forward: every game is predicted from ratings that have seen only the
// games before it, using the SAME replay the app uses. Nothing here re-implements
// the model; the callback hands over the expected margin and total the shipped
// code computed, and this file only scores them.
//
// WHAT MAKES THIS ONE DIFFERENT
//
// The other four sports can only compare the model against itself, because no
// free archive of historical odds exists for them — a fact stated plainly in
// their docs rather than papered over. American football is the exception:
// nflverse carries the CLOSING spread and total on every game since 1999 and
// the moneylines since 2006. So this backtest answers the question the others
// cannot:
//
//     Is the model better than the price you could actually have bet?
//
// The answer, reported below rather than assumed, is no — and that is the
// expected and correct result. The NFL closing line is the sharpest number in
// sports; a model that claimed to beat it on 20 years of data would be
// announcing a bug, not an edge. What the model CAN do is get close to it, and
// "close to the closing line" is a meaningful standard to be held to.
//
// Flags, so every claim in docs/NFL.md is reproducible:
//   --from 2010          first season scored (ratings still warm up from 1999)
//   --key-numbers 0      turn the margin key-number weights off
//   --total-weights 0    turn the total weights off
//   --home <elo>         freeze the home advantage instead of tracking it
//   --mov 0              turn the margin-of-victory multiplier off
//   --carry 0.8          season carryover
//   --k 25               Elo K
//   --per-point 25       Elo points per point of margin

import { getDb } from '../db.ts';
import { nflConfig } from '../config.ts';
import { listGamesWithMarket } from './repo.ts';
import { replayGames, type ReplayGame } from './ratings.ts';
import {
  buildDistribution,
  coverProbability,
  marginProb,
  outcomeProbabilities,
  overProbability,
} from './model.ts';

interface Args {
  league: string;
  from: number;
  keyNumbers: boolean;
  totalWeights: boolean;
  home?: number;
  mov: boolean;
  carry?: number;
  k?: number;
  perPoint?: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string): number | undefined => {
    const v = get(flag);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    league: get('--league') ?? 'nfl',
    from: num('--from') ?? 2010,
    keyNumbers: get('--key-numbers') !== '0',
    totalWeights: get('--total-weights') !== '0',
    home: num('--home'),
    mov: get('--mov') !== '0',
    carry: num('--carry'),
    k: num('--k'),
    perPoint: num('--per-point'),
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** American odds → decimal. nflverse stores moneylines in American format. */
function americanToDecimal(a: number): number | null {
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

function main(): void {
  getDb();
  const args = parseArgs(process.argv.slice(2));
  const league = nflConfig.leagues.find((l) => l.id === args.league);
  if (!league?.nflverse) {
    console.error(`La liga "${args.league}" no tiene archivo histórico.`);
    process.exitCode = 1;
    return;
  }

  const rows = listGamesWithMarket(league.id);
  if (rows.length === 0) {
    console.error('No hay partidos. Ejecuta primero: npm run update-data:naf');
    process.exitCode = 1;
    return;
  }

  // --- accumulators ---------------------------------------------------------
  let n = 0;
  let logLoss = 0;
  let brier = 0;
  let hits = 0;
  const marginResid: number[] = [];
  const totalResid: number[] = [];
  let marginLL = 0;
  let scoreLL = 0;

  // market comparison
  let nMarket = 0;
  let marketLogLoss = 0;
  let marketBrier = 0;
  let modelLogLossOnMarket = 0;
  let modelBrierOnMarket = 0;
  const marketMarginResid: number[] = [];
  const marketTotalResid: number[] = [];
  let atsPlays = 0;
  let atsWins = 0;
  let atsPush = 0;
  let ouPlays = 0;
  let ouWins = 0;
  let ouPush = 0;

  // calibration buckets on the model's home win probability
  const buckets = new Map<number, { n: number; p: number; won: number }>();

  const games: ReplayGame[] = rows.map((r) => ({
    season: r.season,
    week: r.week,
    game_date: r.game_date,
    home_id: r.home_id,
    away_id: r.away_id,
    home_points: r.home_points,
    away_points: r.away_points,
    neutral: r.neutral,
    playoff: r.playoff,
    home_rest: r.home_rest,
    away_rest: r.away_rest,
    // Dropping these here silently disabled the quarterback split and the
    // conditions adjustment for the whole backtest: the replay is shared, but it
    // can only use the columns it is handed.
    home_qb_id: r.home_qb_id,
    away_qb_id: r.away_qb_id,
    home_qb_name: r.home_qb_name,
    away_qb_name: r.away_qb_name,
    roof: r.roof,
    wind: r.wind,
  }));
  const marketByKey = new Map(
    rows.map((r) => [`${r.season}|${r.week}|${r.home_id}|${r.away_id}`, r]),
  );

  replayGames(games, {
    k: args.k,
    carryover: args.carry,
    eloPerPoint: args.perPoint,
    homeAdvantage: args.home,
    mov: args.mov,
    onGame: ({ game, expectedMargin, expectedTotal }) => {
      if (game.season < args.from) return;

      const d = buildDistribution(expectedMargin, expectedTotal, {
        marginWeights: args.keyNumbers,
        totalWeights: args.totalWeights,
      });
      const o = outcomeProbabilities(d);
      const margin = game.home_points - game.away_points;
      const total = game.home_points + game.away_points;
      const actual = margin > 0 ? 1 : margin === 0 ? 0.5 : 0;

      // Two-way, because a moneyline is void on a tie and the market prices it
      // that way. Comparing a three-outcome model to a two-way price without
      // this makes the model look worse than it is.
      const pHome = o.home / (o.home + o.away);

      n++;
      logLoss -= actual * Math.log(Math.max(pHome, 1e-9)) + (1 - actual) * Math.log(Math.max(1 - pHome, 1e-9));
      brier += (pHome - actual) ** 2;
      if ((pHome > 0.5 && margin > 0) || (pHome < 0.5 && margin < 0)) hits++;

      marginResid.push(margin - expectedMargin);
      totalResid.push(total - expectedTotal);
      marginLL += Math.log(Math.max(marginProb(d, margin), 1e-12));
      // A final score is a margin and a total together; the parity constraint
      // means only half the (margin, total) pairs are reachable, hence the ×2.
      const tp = total >= 0 && total <= 110 ? d.total[total] : 0;
      scoreLL += Math.log(Math.max(marginProb(d, margin) * tp * 2, 1e-12));

      const b = Math.floor(pHome * 20) / 20;
      const cell = buckets.get(b) ?? { n: 0, p: 0, won: 0 };
      cell.n++;
      cell.p += pHome;
      cell.won += actual;
      buckets.set(b, cell);

      // --- against the closing line ----------------------------------------
      const row = marketByKey.get(`${game.season}|${game.week}|${game.home_id}|${game.away_id}`);
      if (!row) return;

      if (row.close_spread != null) {
        marketMarginResid.push(margin - row.close_spread);
        // Bet the side the model likes at the market's own line, and see.
        const line = -row.close_spread; // bookmaker sign: home line
        const q = coverProbability(d, line);
        const takeHome = q.cover > q.fail;
        const covered = margin + line;
        if (covered === 0) atsPush++;
        else {
          atsPlays++;
          if ((takeHome && covered > 0) || (!takeHome && covered < 0)) atsWins++;
        }
      }
      if (row.close_total != null) {
        marketTotalResid.push(total - row.close_total);
        const q = overProbability(d, row.close_total);
        const takeOver = q.over > q.under;
        if (total === row.close_total) ouPush++;
        else {
          ouPlays++;
          if ((takeOver && total > row.close_total) || (!takeOver && total < row.close_total)) ouWins++;
        }
      }
      if (row.close_ml_home != null && row.close_ml_away != null) {
        const dh = americanToDecimal(row.close_ml_home);
        const da = americanToDecimal(row.close_ml_away);
        if (dh && da) {
          const rawH = 1 / dh;
          const rawA = 1 / da;
          const mHome = rawH / (rawH + rawA);
          nMarket++;
          marketLogLoss -=
            actual * Math.log(Math.max(mHome, 1e-9)) + (1 - actual) * Math.log(Math.max(1 - mHome, 1e-9));
          marketBrier += (mHome - actual) ** 2;
          modelLogLossOnMarket -=
            actual * Math.log(Math.max(pHome, 1e-9)) + (1 - actual) * Math.log(Math.max(1 - pHome, 1e-9));
          modelBrierOnMarket += (pHome - actual) ** 2;
        }
      }
    },
  });

  if (n === 0) {
    console.error('Ningún partido en la ventana de evaluación.');
    process.exitCode = 1;
    return;
  }

  // --- report ---------------------------------------------------------------
  console.log(`\n🏈 Backtest ${league.name} — temporadas ${args.from}+`);
  console.log('='.repeat(62));
  console.log(`Partidos evaluados: ${n}`);
  console.log(
    'Configuración: ' +
      [
        `nº clave ${args.keyNumbers ? 'ON' : 'OFF'}`,
        `pesos del total ${args.totalWeights ? 'ON' : 'OFF'}`,
        `margen de victoria ${args.mov ? 'ON' : 'OFF'}`,
        args.home != null ? `campo FIJO ${args.home}` : 'campo adaptativo',
      ].join(' · '),
  );

  console.log('\nGanador (dos vías, el empate anula como en el mercado):');
  console.log(`  Acierto      ${pct(hits / n)}`);
  console.log(`  Log loss     ${(logLoss / n).toFixed(4)}   (0.6931 = moneda al aire)`);
  console.log(`  Brier        ${(brier / n).toFixed(4)}`);

  console.log('\nMargen y total:');
  console.log(`  Error del margen: sd ${sd(marginResid).toFixed(2)}  ·  medio ${mean(marginResid).toFixed(2)} (0 = sin sesgo)`);
  console.log(`  Error del total:  sd ${sd(totalResid).toFixed(2)}  ·  medio ${mean(totalResid).toFixed(2)}`);
  console.log(`  Log-verosimilitud del margen exacto: ${(marginLL / n).toFixed(4)} por partido`);
  console.log(`  Log-verosimilitud del marcador exacto: ${(scoreLL / n).toFixed(4)} por partido`);

  if (marketMarginResid.length > 0) {
    console.log('\n' + '─'.repeat(62));
    console.log('CONTRA LA LÍNEA DE CIERRE REAL');
    console.log('─'.repeat(62));
    console.log(
      `  Margen — modelo sd ${sd(marginResid).toFixed(2)}  ·  mercado sd ${sd(marketMarginResid).toFixed(2)}` +
        `   (${(sd(marginResid) - sd(marketMarginResid)).toFixed(2)} peor)`,
    );
    console.log(
      `  Total  — modelo sd ${sd(totalResid).toFixed(2)}  ·  mercado sd ${sd(marketTotalResid).toFixed(2)}` +
        `   (${(sd(totalResid) - sd(marketTotalResid)).toFixed(2)} peor)`,
    );
    if (nMarket > 0) {
      console.log(
        `  Ganador — modelo log loss ${(modelLogLossOnMarket / nMarket).toFixed(4)}  ·  ` +
          `mercado ${(marketLogLoss / nMarket).toFixed(4)}   (n=${nMarket})`,
      );
      console.log(
        `  Ganador — modelo Brier    ${(modelBrierOnMarket / nMarket).toFixed(4)}  ·  ` +
          `mercado ${(marketBrier / nMarket).toFixed(4)}`,
      );
    }
    const atsPctVal = atsPlays > 0 ? atsWins / atsPlays : 0;
    console.log(
      `\n  Contra el hándicap: ${atsWins}-${atsPlays - atsWins}` +
        (atsPush ? ` (${atsPush} nulos)` : '') +
        ` = ${pct(atsPctVal)}`,
    );
    console.log(
      `  Over/under:         ${ouWins}-${ouPlays - ouWins}` +
        (ouPush ? ` (${ouPush} nulos)` : '') +
        ` = ${pct(ouPlays > 0 ? ouWins / ouPlays : 0)}`,
    );
    console.log(
      '\n  El umbral para ganar dinero con la comisión habitual (-110) es 52.4%.\n' +
        '  La línea de cierre de la NFL es el precio más afinado del deporte: que el\n' +
        '  modelo NO la bata es el resultado correcto, y verlo escrito es la razón de\n' +
        '  que la app no venda sus "posibles value" como si fueran dinero seguro.',
    );
  }

  console.log('\nCalibración de la victoria local (predicho vs real):');
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const c = buckets.get(b)!;
    if (c.n < 40) continue;
    const predicted = c.p / c.n;
    const real = c.won / c.n;
    console.log(
      `  ${(b * 100).toFixed(0)}-${((b + 0.05) * 100).toFixed(0)}%  n=${String(c.n).padStart(5)}` +
        `  predicho ${pct(predicted)}  real ${pct(real)}  (${((real - predicted) * 100).toFixed(1)} pp)`,
    );
  }
  console.log('');
}

main();

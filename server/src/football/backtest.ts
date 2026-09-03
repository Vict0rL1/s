// CLI: `npm run backtest:fb [-- --league epl --home 65 --sensitivity 0.42 --rho 0.08]`
//
// Walk-forward test of the football model. Drives the same `replayMatches` the app
// uses, hooking its per-match callback, so the numbers describe the shipped model
// rather than a copy that drifted.
//
// ===========================================================================
// QUÉ MODELO MIDE (`--model dc` por defecto)
// ===========================================================================
// Desde que producción predice con el Dixon-Coles jerárquico, medir solo el camino de
// Elo sería publicar el número de un código que ya no corre. Así que el backtest hace
// lo MISMO que `predict.ts`: si el ajuste conoce a los dos equipos, λ sale del
// Dixon-Coles; si no —un recién ascendido, por ejemplo— cae al camino de Elo, que es
// el que sabe del salto de división.
//
// El reajuste periódico usa `DcWalkForward`, el mismo objeto que usa `study:dc`: ningún
// partido se puntúa con parámetros que lo hayan visto. Con `--model elo` se mide el
// camino viejo, que es lo que hace falta para comparar los dos.
//
// ===========================================================================
// EL HOLDOUT NO SE PUNTÚA
// ===========================================================================
// Este script llevaba sumando las temporadas reservadas al total —3.691 partidos de
// 24.223— y ese total es el que se cita en la ficha de honestidad de la app. Un holdout
// que entra en el número que publicas no es un holdout. Ahora se excluye de la
// PUNTUACIÓN; los partidos siguen alimentando la reproducción de ratings, que va en
// orden cronológico y por tanto nunca deja que un partido influya en otro anterior.
// Para abrirlo de verdad: `--unlock "motivo"`, que queda escrito en el registro.
//
// THE METRIC IS RPS, NOT ACCURACY.
// "Accuracy" is close to meaningless in football: a model that never predicts a
// draw can still look respectable, while being useless for the outcome that
// happens a quarter of the time. The Ranked Probability Score respects the
// ordering home / draw / away, so being one step wrong beats being two steps
// wrong — which is why it is the standard measure for 1X2 forecasts.
//
// Tunable, so each piece's contribution is measured rather than assumed:
//   --home <elo>          home advantage (0 = none)
//   --sensitivity <n>     how strongly the Elo gap tilts expected goals
//   --rho <n>             Dixon-Coles low-score correction (0 = plain Poisson)
//   --share <n>           share of league goals scored by the home side
//   --k <n>               base K-factor
//   --carryover <0..1>    rating surviving the off-season
//   --goals <weight>      goal-difference weighting on K (0 = result only)
//   --attack <alpha>      attack/defence learning rate (0 = pure Elo → goals)
//   --shrink <n>          matches before attack/defence is trusted fully
//   --momentum <elo>      Elo worth of recent form (0 = off)
//   --rest <elo>          Elo lost at full fixture congestion (0 = off)

import { footballConfig } from '../config.ts';
import {
  impliedFrom1X2,
  outcomeProbabilities,
  overProbability,
  rankedProbabilityScore,
  scoreDistribution,
  DIXON_COLES_RHO,
  GOAL_SENSITIVITY,
  HOME_ADVANTAGE,
  HOME_GOAL_SHARE,
  K_FACTOR,
  SEASON_CARRYOVER,
} from './model.ts';
import { STRENGTH_ALPHA, STRENGTH_SHRINK_MATCHES } from './strength.ts';
import { CONGESTION_ELO, MOMENTUM_ELO } from './momentum.ts';
import { DC_HYPER, firstSeasonGoalAverage, loadMatches, replayMatches } from './ratings.ts';
import { expectedGoalsDc, type DcMatch } from './bayes/dixonColes.ts';
import { DcWalkForward } from './bayes/walkforward.ts';
import { splitOf, unlockFinalHoldout, FINAL_HOLDOUT_FROM } from '../experiments/holdout.ts';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    // Both forms. `--flag=value` used to be swallowed whole: the key became
    // "flag=value", nothing ever looked it up, and the flag silently did nothing —
    // which reads exactly like the feature being broken.
    const eq = a.indexOf('=');
    if (eq > 2) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[a.slice(2)] = next;
      i++;
    } else args[a.slice(2)] = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const onlyLeague = typeof args.league === 'string' ? args.league : null;
  const fromSeason = Number(args.from) || 0;
  const warmup = Number(args.warmup) || 20;

  const homeAdvantage = args.home !== undefined ? Number(args.home) : HOME_ADVANTAGE;
  const goalSensitivity =
    args.sensitivity !== undefined ? Number(args.sensitivity) : GOAL_SENSITIVITY;
  const rho = args.rho !== undefined ? Number(args.rho) : DIXON_COLES_RHO;
  const homeGoalShare = args.share !== undefined ? Number(args.share) : HOME_GOAL_SHARE;
  const k = args.k !== undefined ? Number(args.k) : K_FACTOR;
  const carryover = args.carryover !== undefined ? Number(args.carryover) : SEASON_CARRYOVER;
  const goalWeight = args.goals !== undefined ? Number(args.goals) : 1;
  const strengthAlpha = args.attack !== undefined ? Number(args.attack) : STRENGTH_ALPHA;
  const strengthShrink =
    args.shrink !== undefined ? Number(args.shrink) : STRENGTH_SHRINK_MATCHES;
  const momentumWeight = args.momentum !== undefined ? Number(args.momentum) : MOMENTUM_ELO;
  const restWeight = args.rest !== undefined ? Number(args.rest) : CONGESTION_ELO;
  const useDc = args.model !== 'elo';
  if (typeof args.unlock === 'string') unlockFinalHoldout(args.unlock);
  const holdoutOpen = typeof args.unlock === 'string';

  console.log(
    `Ventaja de campo: ${homeAdvantage} · sensibilidad Elo→goles: ${goalSensitivity} · ` +
      `rho (Dixon-Coles): ${rho}\nCuota de goles del local: ${homeGoalShare} · K: ${k} · ` +
      `arrastre: ${carryover} · peso de la diferencia de goles: ${goalWeight}\n` +
      `Ataque/defensa: α=${strengthAlpha} (shrink ${strengthShrink}) · ` +
      `momento: ${momentumWeight} Elo · congestión: ${restWeight} Elo\n` +
      `Modelo: ${useDc ? 'Dixon-Coles jerárquico (el que publica la app)' : 'solo Elo → λ'} · ` +
      `holdout ${holdoutOpen ? 'ABIERTO' : `cerrado (${FINAL_HOLDOUT_FROM.football}+ no se puntúa)`}`,
  );

  const leagues = footballConfig.leagues
    .filter((l) => !onlyLeague || l.id === onlyLeague)
    .map((l) => l.id);

  // Totals across every league, so one summary line describes the whole model.
  let allScored = 0;
  let allRps = 0;
  let allLogLoss = 0;
  let allCorrect = 0;
  let allDrawsPredicted = 0;
  let allDrawsActual = 0;
  let allOverCorrect = 0;
  let allOverScored = 0;
  let allGoalErr = 0;
  // Against the real market, where the source carried odds.
  let mkN = 0;
  let mkModelRps = 0;
  let mkMarketRps = 0;
  let mkModelCorrect = 0;
  let mkMarketCorrect = 0;
  // Cuántos partidos puntuó cada camino. Sin esto, «medido con el Dixon-Coles» puede
  // querer decir que el 90 % de los partidos los resolvió el Elo de respaldo.
  let viaDc = 0;
  let viaElo = 0;
  let skippedHoldout = 0;
  const drawBands = new Map<string, { n: number; pred: number; obs: number }>();

  for (const league of leagues) {
    const matches = loadMatches(league, fromSeason);
    if (matches.length === 0) continue;

    // The goals anchor must be known BEFORE the walk-forward, and it must not
    // come from the future: the league's average over the earliest season
    // present, which is information available at the start.
    const anchor = firstSeasonGoalAverage(matches);

    // El mismo reajuste periódico que usa `study:dc`. Se construye por liga porque los
    // parámetros son por liga: la Bundesliga marca 1,38 goles de base y la Segunda
    // española 0,98, y un ajuste común los mediaría a un número que no describe a
    // ninguna de las dos.
    const dcRows: DcMatch[] = matches.map((m) => ({
      date: m.match_date,
      homeId: m.home_id,
      awayId: m.away_id,
      homeGoals: m.home_goals,
      awayGoals: m.away_goals,
    }));
    const wf = useDc ? new DcWalkForward(dcRows, DC_HYPER) : null;

    let scored = 0;
    let rps = 0;
    let logloss = 0;
    let correct = 0;
    let drawsPredicted = 0;
    let drawsActual = 0;

    replayMatches(matches, {
      homeAdvantage,
      k,
      carryover,
      goalWeight,
      goalsAnchor: anchor,
      goalSensitivity,
      homeGoalShare,
      strengthAlpha,
      strengthShrink,
      momentumWeight,
      restWeight,
      // λ comes FROM the replay, not from a second call to expectedGoals here:
      // the backtest must score the arithmetic the app runs, not a copy of it.
      onMatch: ({ match, home, away, lambda }) => {
        if (home.matches < warmup || away.matches < warmup) return;
        // El holdout alimenta los ratings —la reproducción es cronológica, así que un
        // partido nunca influye en otro anterior— pero no entra en el número.
        if (!holdoutOpen && splitOf('football', Number(match.season)) === 'holdout') {
          skippedHoldout++;
          return;
        }

        // Lo mismo que hace `predict.ts`: Dixon-Coles cuando conoce a los dos, y si no,
        // el camino de Elo, que es el que tiene medido el salto de división.
        const dc = wf?.paramsFor(match.match_date) ?? null;
        const dcUsable = !!dc && dc.attack.has(match.home_id) && dc.attack.has(match.away_id);
        let lam = lambda;
        let useRho = rho;
        if (dc && dcUsable) {
          lam = expectedGoalsDc(dc, match.home_id, match.away_id);
          useRho = dc.rho;
          viaDc++;
        } else viaElo++;

        const dist = scoreDistribution(lam.home, lam.away, useRho);
        const probs = outcomeProbabilities(dist);
        const actual = match.result as 'H' | 'D' | 'A';

        scored++;
        rps += rankedProbabilityScore(probs, actual);
        const pActual = actual === 'H' ? probs.home : actual === 'D' ? probs.draw : probs.away;
        logloss += -Math.log(Math.max(pActual, 1e-15));
        const top =
          probs.home >= probs.draw && probs.home >= probs.away
            ? 'H'
            : probs.draw >= probs.away
              ? 'D'
              : 'A';
        if (top === actual) correct++;
        if (top === 'D') drawsPredicted++;
        if (actual === 'D') drawsActual++;

        // Draw calibration: the outcome a football model most often gets wrong.
        const lo = Math.min(0.45, Math.floor(probs.draw * 20) / 20);
        const key = `${(lo * 100).toFixed(0)}–${((lo + 0.05) * 100).toFixed(0)}%`;
        const b = drawBands.get(key) ?? { n: 0, pred: 0, obs: 0 };
        b.n++;
        b.pred += probs.draw;
        b.obs += actual === 'D' ? 1 : 0;
        drawBands.set(key, b);

        // Over/under 2.5 — the most traded goals market.
        const pOver = overProbability(dist, 2.5);
        const wasOver = match.home_goals + match.away_goals > 2.5;
        allOverScored++;
        if (pOver > 0.5 === wasOver) allOverCorrect++;
        allGoalErr += Math.abs(lam.home + lam.away - (match.home_goals + match.away_goals));

        if (match.odds_home && match.odds_draw && match.odds_away) {
          const implied = impliedFrom1X2(match.odds_home, match.odds_draw, match.odds_away);
          if (implied) {
            mkN++;
            mkModelRps += rankedProbabilityScore(probs, actual);
            mkMarketRps += rankedProbabilityScore(implied, actual);
            if (top === actual) mkModelCorrect++;
            const mTop =
              implied.home >= implied.draw && implied.home >= implied.away
                ? 'H'
                : implied.draw >= implied.away
                  ? 'D'
                  : 'A';
            if (mTop === actual) mkMarketCorrect++;
          }
        }
      },
    });

    if (scored === 0) continue;
    allScored += scored;
    allRps += rps;
    allLogLoss += logloss;
    allCorrect += correct;
    allDrawsPredicted += drawsPredicted;
    allDrawsActual += drawsActual;
    console.log(
      `\n  ${league.padEnd(14)} n=${String(scored).padStart(6)}  ` +
        `RPS ${(rps / scored).toFixed(4)}  acierto ${((correct / scored) * 100).toFixed(1)}%  ` +
        `empates predichos ${drawsPredicted} vs ${drawsActual} reales`,
    );
  }

  if (allScored === 0) {
    console.log('\nSin partidos evaluables. Corre `npm run update-data:fb` primero.');
    return;
  }

  console.log(`\n=== FÚTBOL — backtest walk-forward ===`);
  console.log(`Partidos evaluados: ${allScored}`);
  if (useDc) {
    const pct = ((viaDc / Math.max(1, viaDc + viaElo)) * 100).toFixed(1);
    console.log(
      `  ${viaDc} con Dixon-Coles (${pct} %) · ${viaElo} con el respaldo de Elo ` +
        '(equipos que el ajuste no conocía)',
    );
  }
  if (skippedHoldout > 0) {
    console.log(
      `  ${skippedHoldout} partidos de ${FINAL_HOLDOUT_FROM.football}+ NO se han ` +
        'puntuado: son el holdout final y el candado está cerrado.',
    );
  }
  console.log(`\nRPS (Ranked Probability Score): ${(allRps / allScored).toFixed(4)}`);
  console.log(`  referencia: predecir siempre la media de la liga ≈ 0.2230`);
  console.log(`Log loss: ${(allLogLoss / allScored).toFixed(4)}   (1.0986 = decir siempre 1/3)`);
  console.log(`Acierto del resultado más probable: ${((allCorrect / allScored) * 100).toFixed(1)}%`);
  console.log(
    `Empates: el modelo elige empate en ${allDrawsPredicted} partidos; ` +
      `hubo ${allDrawsActual} (${((allDrawsActual / allScored) * 100).toFixed(1)}%)`,
  );
  console.log(
    `\nGoles:\n  over/under 2.5 acertado: ${((allOverCorrect / Math.max(1, allOverScored)) * 100).toFixed(1)}%` +
      `\n  error absoluto medio del total: ${(allGoalErr / Math.max(1, allOverScored)).toFixed(2)} goles`,
  );

  console.log('\nCalibración del empate (predicho vs real):');
  [...drawBands.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([band, b]) => {
      if (b.n < 100) return;
      const pred = (b.pred / b.n) * 100;
      const obs = (b.obs / b.n) * 100;
      console.log(
        `  ${band.padEnd(9)} n=${String(b.n).padStart(6)}  predicho ${pred.toFixed(1)}%  ` +
          `real ${obs.toFixed(1)}%  (${obs - pred >= 0 ? '+' : ''}${(obs - pred).toFixed(1)} pp)`,
      );
    });

  if (mkN > 0) {
    console.log(`\nContra el mercado real (${mkN} partidos con cuotas 1X2):`);
    console.log(
      `  modelo   RPS ${(mkModelRps / mkN).toFixed(4)}  acierto ${((mkModelCorrect / mkN) * 100).toFixed(1)}%`,
    );
    console.log(
      `  mercado  RPS ${(mkMarketRps / mkN).toFixed(4)}  acierto ${((mkMarketCorrect / mkN) * 100).toFixed(1)}%`,
    );
    console.log(
      mkModelRps <= mkMarketRps
        ? '  → el modelo iguala o mejora al mercado en RPS sobre esta muestra'
        : '  → el mercado es mejor: incorpora lesiones, alineaciones y dinero informado',
    );
  }

  console.log(
    '\nNota: mide rendimiento histórico. No considera lesiones, alineaciones,\n' +
      'rotaciones por competición europea ni partidos sin nada en juego.\n',
  );
}

main();

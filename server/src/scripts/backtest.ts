// CLI: `npm run backtest [-- --tour atp --from 2015]`
//
// Measures how accurate the model actually is, instead of taking its
// probabilities on faith. This is a walk-forward (out-of-sample) test: matches
// are replayed in chronological order and every match is predicted using ONLY
// the ratings/form built from earlier matches, then the ratings are updated.
// No future information leaks in.
//
// Metrics reported:
//   • Accuracy   — share of matches where the favourite actually won.
//   • Brier score— mean squared error of the probability (0 = perfect,
//                  0.25 = always saying 50/50). Lower is better.
//   • Log loss   — penalises confident mistakes harshly. Lower is better.
//   • Calibration— for each probability band, predicted vs observed win rate.
//                  A well-calibrated model wins ~70% of matches it calls at 70%.
//
// Baselines are printed alongside so the numbers mean something.

import { getDb } from '../db.ts';
import { toursConfig } from '../config.ts';
import {
  calibratedExpectedScore,
  expectedScore,
  kFactor,
  surfaceKey,
  CALIBRATION_SCALE,
  INITIAL_ELO,
} from '../model/elo.ts';
import { computeForm, type FormResult } from '../model/form.ts';
import { computeReliability } from '../model/reliability.ts';

interface Row {
  id: number;
  tourney_date: string;
  surface: string | null;
  winner_id: number;
  loser_id: number;
  winner_rank: number | null;
  loser_rank: number | null;
}

interface State {
  overall: number;
  hard: number;
  clay: number;
  grass: number;
  nOverall: number;
  nHard: number;
  nClay: number;
  nGrass: number;
  recent: FormResult[]; // most recent first
  lastDate: string | null; // date of their previous match, for staleness
}

const SURFACE_WEIGHT = 0.7; // must match model/predict.ts
const FORM_WEIGHT = 1;
const H2H_MAX = 35;
const H2H_SHRINK = 4;

function fresh(): State {
  return {
    overall: INITIAL_ELO,
    hard: INITIAL_ELO,
    clay: INITIAL_ELO,
    grass: INITIAL_ELO,
    nOverall: 0,
    nHard: 0,
    nClay: 0,
    nGrass: 0,
    recent: [],
    lastDate: null,
  };
}

/** Whole days between two YYYYMMDD strings (0 if either is unusable). */
function daysBetween(fromYmd: string | null, toYmd: string): number {
  if (!fromYmd || fromYmd.length < 8 || toYmd.length < 8) return 0;
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(4, 6) - 1, +fromYmd.slice(6, 8));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(4, 6) - 1, +toYmd.slice(6, 8));
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[a.slice(2)] = next;
        i++;
      } else args[a.slice(2)] = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const onlyTour = typeof args.tour === 'string' ? args.tour : null;
  const fromYear = Number(args.from) || 0;
  const warmup = Number(args.warmup) || 20; // matches per player before scoring
  // `--calibration 1` measures the raw (uncalibrated) curve, for comparison.
  const scale = args.calibration !== undefined ? Number(args.calibration) : CALIBRATION_SCALE;
  console.log(`Factor de calibración: ${scale}${scale === 1 ? ' (curva Elo cruda)' : ''}`);

  const db = getDb();
  const tours = toursConfig.tours.filter((t) => !onlyTour || t.id === onlyTour);

  for (const tour of tours) {
    const rows = db
      .prepare(
        `SELECT id, tourney_date, surface, winner_id, loser_id, winner_rank, loser_rank
         FROM matches WHERE tour = ? AND tourney_date >= ?
         ORDER BY tourney_date ASC, id ASC`,
      )
      .all(tour.id, String(fromYear ? `${fromYear}0101` : '0')) as unknown as Row[];

    if (rows.length === 0) {
      console.log(`\n${tour.name}: sin partidos en la base de datos.`);
      continue;
    }

    const states = new Map<number, State>();
    const h2h = new Map<string, { a: number; b: number }>(); // key "lowId-highId"
    const get = (id: number) => {
      let s = states.get(id);
      if (!s) {
        s = fresh();
        states.set(id, s);
      }
      return s;
    };
    const h2hKey = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);

    let scored = 0;
    let correct = 0;
    let brier = 0;
    let logloss = 0;
    // Baseline: "the higher-ranked player wins". The betting market is usually a
    // bit sharper than the ranking, so this is a floor to compare against — not a
    // stand-in for the market itself (we have no historical odds).
    let rankScored = 0;
    let rankCorrect = 0;
    // How often the model and the ranking pick different winners, and who is
    // right when they do — the quantitative version of "it disagrees with odds".
    let disagreements = 0;
    let modelRightOnDisagreement = 0;
    // Calibration buckets by predicted probability of the *predicted winner*.
    const buckets = new Map<string, { n: number; pred: number; won: number }>();
    // Does the reliability tier shown in the UI mean anything? Score each tier
    // separately: if the label is informative, "low" must be measurably worse.
    const tiers = new Map<string, { n: number; correct: number; brier: number; margin: number }>();

    for (const m of rows) {
      const w = get(m.winner_id);
      const l = get(m.loser_id);
      const sk = surfaceKey(m.surface);

      // ---- PREDICT (using only past information) ----
      const eligible = w.nOverall >= warmup && l.nOverall >= warmup;
      if (eligible) {
        const effOf = (s: State) =>
          sk ? SURFACE_WEIGHT * s[sk] + (1 - SURFACE_WEIGHT) * s.overall : s.overall;
        const formDelta = (s: State) => computeForm(s.recent).delta * FORM_WEIGHT;

        const key = h2hKey(m.winner_id, m.loser_id);
        const rec = h2h.get(key) ?? { a: 0, b: 0 };
        // `a` counts wins for the lower id
        const lowIsWinner = Math.min(m.winner_id, m.loser_id) === m.winner_id;
        const winnerH2H = lowIsWinner ? rec.a : rec.b;
        const loserH2H = lowIsWinner ? rec.b : rec.a;
        const total = winnerH2H + loserH2H;
        let h2hDeltaForWinner = 0;
        if (total > 0) {
          const rate = winnerH2H / total;
          h2hDeltaForWinner =
            (rate - 0.5) * (H2H_MAX * 2) * (total / (total + H2H_SHRINK));
        }

        const adjW = effOf(w) + formDelta(w) + h2hDeltaForWinner;
        const adjL = effOf(l) + formDelta(l) - h2hDeltaForWinner;
        // Calibrated probability — the same one the app reports. Note the rating
        // UPDATES below deliberately use the raw curve (that's the Elo system).
        const pWinnerWins = calibratedExpectedScore(adjW, adjL, scale);

        scored++;
        if (pWinnerWins > 0.5) correct++;
        else if (pWinnerWins === 0.5) correct += 0.5;
        brier += (1 - pWinnerWins) ** 2;
        logloss += -Math.log(Math.max(pWinnerWins, 1e-15));

        // Calibration on the favourite's probability.
        const pFav = Math.max(pWinnerWins, 1 - pWinnerWins);
        const favWon = pWinnerWins >= 0.5 ? 1 : 0;
        const lo = Math.min(0.95, Math.floor(pFav * 10) / 10);
        const bk = `${(lo * 100).toFixed(0)}–${((lo + 0.1) * 100).toFixed(0)}%`;
        const b = buckets.get(bk) ?? { n: 0, pred: 0, won: 0 };
        b.n++;
        b.pred += pFav;
        b.won += favWon;
        buckets.set(bk, b);

        // Reliability tier, computed from exactly what the app would know at
        // this point in time (matches so far, matches on this surface, days
        // since each player's previous match).
        const depthOf = (s: State) => ({
          matches: s.nOverall,
          surfaceMatches: sk ? (sk === 'hard' ? s.nHard : sk === 'clay' ? s.nClay : s.nGrass) : 0,
          daysStale: daysBetween(s.lastDate, m.tourney_date),
        });
        const rel = computeReliability(pWinnerWins, depthOf(w), depthOf(l), { p1: 'w', p2: 'l' });
        const t = tiers.get(rel.level) ?? { n: 0, correct: 0, brier: 0, margin: 0 };
        t.n++;
        t.correct += pWinnerWins > 0.5 ? 1 : pWinnerWins === 0.5 ? 0.5 : 0;
        t.brier += (1 - pWinnerWins) ** 2;
        t.margin += rel.marginPp;
        tiers.set(rel.level, t);

        // Ranking baseline + head-to-head against the model on the same matches.
        if (m.winner_rank != null && m.loser_rank != null && m.winner_rank !== m.loser_rank) {
          rankScored++;
          const rankPicksWinner = m.winner_rank < m.loser_rank; // lower rank = better
          if (rankPicksWinner) rankCorrect++;
          const modelPicksWinner = pWinnerWins > 0.5;
          if (modelPicksWinner !== rankPicksWinner) {
            disagreements++;
            if (modelPicksWinner) modelRightOnDisagreement++;
          }
        }
      }

      // ---- UPDATE (after predicting) ----
      const eW = expectedScore(w.overall, l.overall);
      w.overall += kFactor(w.nOverall) * (1 - eW);
      l.overall += kFactor(l.nOverall) * (0 - (1 - eW));
      w.nOverall++;
      l.nOverall++;
      if (sk) {
        const eWs = expectedScore(w[sk], l[sk]);
        const nW = sk === 'hard' ? w.nHard : sk === 'clay' ? w.nClay : w.nGrass;
        const nL = sk === 'hard' ? l.nHard : sk === 'clay' ? l.nClay : l.nGrass;
        w[sk] += kFactor(nW) * (1 - eWs);
        l[sk] += kFactor(nL) * (0 - (1 - eWs));
        if (sk === 'hard') {
          w.nHard++;
          l.nHard++;
        } else if (sk === 'clay') {
          w.nClay++;
          l.nClay++;
        } else {
          w.nGrass++;
          l.nGrass++;
        }
      }
      w.lastDate = m.tourney_date;
      l.lastDate = m.tourney_date;
      w.recent.unshift({ won: true, date: m.tourney_date });
      l.recent.unshift({ won: false, date: m.tourney_date });
      if (w.recent.length > 10) w.recent.pop();
      if (l.recent.length > 10) l.recent.pop();

      const key = h2hKey(m.winner_id, m.loser_id);
      const rec = h2h.get(key) ?? { a: 0, b: 0 };
      if (Math.min(m.winner_id, m.loser_id) === m.winner_id) rec.a++;
      else rec.b++;
      h2h.set(key, rec);
    }

    // ---- Report ----
    console.log(`\n=== ${tour.name} — backtest walk-forward ===`);
    console.log(`Partidos en la base: ${rows.length}`);
    console.log(`Partidos evaluados (ambos con ≥${warmup} partidos previos): ${scored}`);
    if (scored === 0) {
      console.log('No hay suficientes partidos para evaluar.');
      continue;
    }
    const acc = correct / scored;
    console.log(`\nAccuracy (acierta al favorito): ${(acc * 100).toFixed(1)}%`);
    if (rankScored > 0) {
      console.log(
        `Baseline "gana el mejor rankeado": ${((rankCorrect / rankScored) * 100).toFixed(1)}%` +
          ` (sobre ${rankScored} partidos con ranking)`,
      );
    }
    if (disagreements > 0) {
      const pct = (modelRightOnDisagreement / disagreements) * 100;
      console.log(
        `\nCuando el modelo NO coincide con el ranking (${disagreements} partidos, ` +
          `${((disagreements / rankScored) * 100).toFixed(1)}% del total):`,
      );
      console.log(`  el modelo acierta ${pct.toFixed(1)}% y el ranking ${(100 - pct).toFixed(1)}%`);
    }
    console.log(`Brier score: ${(brier / scored).toFixed(4)}   (0 = perfecto, 0.25 = 50/50 siempre)`);
    console.log(`Log loss:    ${(logloss / scored).toFixed(4)}   (0.693 = 50/50 siempre)`);
    console.log('\nCalibración (predicho vs real, del favorito):');
    [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([band, b]) => {
        const predicted = (b.pred / b.n) * 100;
        const observed = (b.won / b.n) * 100;
        const diff = observed - predicted;
        console.log(
          `  ${band.padEnd(9)} n=${String(b.n).padStart(5)}  ` +
            `predicho ${predicted.toFixed(1)}%  real ${observed.toFixed(1)}%  ` +
            `(${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pp)`,
        );
      });

    // Validates the reliability badge the UI shows on every match. The point is
    // the ORDER: "alta" must beat "baja" on Brier, otherwise the label is noise
    // and shouldn't be displayed as if it meant something.
    if (tiers.size > 0) {
      console.log('\nFiabilidad declarada (valida el semáforo que muestra la app):');
      for (const level of ['high', 'medium', 'low']) {
        const t = tiers.get(level);
        if (!t) continue;
        const es = level === 'high' ? 'alta' : level === 'medium' ? 'media' : 'baja';
        console.log(
          `  ${es.padEnd(6)} n=${String(t.n).padStart(6)}  ` +
            `accuracy ${((t.correct / t.n) * 100).toFixed(1)}%  ` +
            `Brier ${(t.brier / t.n).toFixed(4)}  ` +
            `banda media ±${(t.margin / t.n).toFixed(1)} pp`,
        );
      }
    }
  }

  console.log(
    '\nNota: el backtest mide el rendimiento histórico del modelo. No garantiza\n' +
      'resultados futuros y no considera lesiones, clima ni motivación.\n',
  );
}

main();

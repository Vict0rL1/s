// ¿Está calibrado el modelo de las dos mitades?
//
// The facts are measured (see _ht.ts) and the model is written. This asks the only
// question that decides whether it ships: does it produce probabilities that come
// true at the rate it claims — WALK-FORWARD, on matches it was not fitted on?
//
// The known weakness is stated up front so the numbers can be read against it: the
// model treats the halves as independent, and game state says they are not (1.743
// second-half goals after a level first half, 1.539 after a one-goal lead). If that
// matters, it will show up here as a miscalibrated "gana alguna mitad" — the market
// that depends most on the joint behaviour of the two halves — while the pure
// first-half markets stay fine.

import { getDb } from '../db.ts';
import {
  halfDistributions,
  scoreDistribution,
  outcomeProbabilities,
  overProbability,
  winsEitherHalf,
} from '../football/model.ts';
import { loadMatches, replayMatches } from '../football/ratings.ts';

interface Obs {
  season: number;
  pHtHome: number;
  pHtDraw: number;
  pHtAway: number;
  pEitherHome: number;
  pEitherAway: number;
  pHtOver05: number;
  pHtOver15: number;
  pOver15: number;
  pOver35: number;
  pCsHome: number;
  pCsAway: number;
  pWinToNilHome: number;
  /** Actuals. */
  htHome: boolean;
  htDraw: boolean;
  htAway: boolean;
  eitherHome: boolean;
  eitherAway: boolean;
  htOver05: boolean;
  htOver15: boolean;
  over15: boolean;
  over35: boolean;
  csHome: boolean;
  csAway: boolean;
  winToNilHome: boolean;
}

const db = getDb();
const ht = new Map<string, { hh: number; ha: number; fg: number; fa: number }>();
for (const r of db
  .prepare(
    `SELECT league, match_date, home_id, away_id, home_goals fg, away_goals fa,
            ht_home_goals hh, ht_away_goals ha
     FROM fb_matches WHERE ht_home_goals IS NOT NULL AND ht_away_goals IS NOT NULL
       AND home_goals >= ht_home_goals AND away_goals >= ht_away_goals`,
  )
  .all() as unknown as any[]) {
  ht.set(`${r.league}|${r.match_date}|${r.home_id}|${r.away_id}`, r);
}

const obs: Obs[] = [];
const WARMUP = 10;
// Swept from the command line so the diagnosis can be tested rather than argued.
const RHO = process.env.HT_RHO !== undefined ? Number(process.env.HT_RHO) : -0.1;
const SHARE = process.env.HT_SHARE !== undefined ? Number(process.env.HT_SHARE) : 0.4461;
console.log(`rho=${RHO}  share=${SHARE}`);
for (const league of ['epl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'eredivisie', 'primeira', 'championship', 'ligamx', 'argentina']) {
  const matches = loadMatches(league, 0);
  if (matches.length === 0) continue;
  replayMatches(matches, {
    onMatch: ({ match, home, away, lambda }: any) => {
      if (home.matches < WARMUP || away.matches < WARMUP) return;
      const key = `${league}|${match.match_date}|${match.home_id}|${match.away_id}`;
      const a = ht.get(key);
      if (!a) return;

      const halves = halfDistributions(lambda.home, lambda.away, SHARE, RHO);
      const o1 = outcomeProbabilities(halves.first);
      // Candidate FULL-MATCH markets the app computes but never offers as a pick.
      const full = scoreDistribution(lambda.home, lambda.away);
      let csHome = 0; // home concedes nothing
      let csAway = 0;
      let winToNilHome = 0;
      for (let h = 0; h < full.grid.length; h++) {
        for (let a = 0; a < full.grid[h].length; a++) {
          const pr = full.grid[h][a];
          if (a === 0) csHome += pr;
          if (h === 0) csAway += pr;
          if (a === 0 && h > 0) winToNilHome += pr;
        }
      }
      const h2h = a.fg - a.hh;
      const h2a = a.fa - a.ha;
      obs.push({
        season: Number(String(match.match_date).slice(0, 4)),
        pHtHome: o1.home,
        pHtDraw: o1.draw,
        pHtAway: o1.away,
        pEitherHome: winsEitherHalf(halves, 'home'),
        pEitherAway: winsEitherHalf(halves, 'away'),
        pHtOver05: overProbability(halves.first, 0.5),
        pHtOver15: overProbability(halves.first, 1.5),
        pOver15: overProbability(full, 1.5),
        pOver35: overProbability(full, 3.5),
        pCsHome: csHome,
        pCsAway: csAway,
        pWinToNilHome: winToNilHome,
        htHome: a.hh > a.ha,
        htDraw: a.hh === a.ha,
        htAway: a.hh < a.ha,
        eitherHome: a.hh > a.ha || h2h > h2a,
        eitherAway: a.hh < a.ha || h2h < h2a,
        htOver05: a.hh + a.ha >= 1,
        htOver15: a.hh + a.ha >= 2,
        over15: a.fg + a.fa >= 2,
        over35: a.fg + a.fa >= 4,
        csHome: a.fa === 0,
        csAway: a.fg === 0,
        winToNilHome: a.fa === 0 && a.fg > 0,
      });
    },
  } as any);
}
console.log(`${obs.length} partidos evaluables (ambos equipos con ≥${WARMUP} previos)\n`);
if (obs.length === 0) {
  console.log('sin datos');
  process.exit(0);
}

/** Predicted average against realised rate — the only calibration that matters. */
function line(label: string, p: (o: Obs) => number, hit: (o: Obs) => boolean, rows: Obs[]): void {
  const pred = rows.reduce((s, o) => s + p(o), 0) / rows.length;
  const real = rows.filter(hit).length / rows.length;
  let brier = 0;
  for (const o of rows) brier += (p(o) - (hit(o) ? 1 : 0)) ** 2;
  const gap = (real - pred) * 100;
  console.log(
    `  ${label.padEnd(30)} modelo ${(pred * 100).toFixed(2).padStart(6)} %  ` +
      `real ${(real * 100).toFixed(2).padStart(6)} %  ` +
      `dif ${(gap >= 0 ? '+' : '') + gap.toFixed(2)} pp   Brier ${(brier / rows.length).toFixed(4)}`,
  );
}

function report(label: string, rows: Obs[]): void {
  console.log(`${label} (${rows.length} partidos)`);
  line('descanso: gana el local', (o) => o.pHtHome, (o) => o.htHome, rows);
  line('descanso: empate', (o) => o.pHtDraw, (o) => o.htDraw, rows);
  line('descanso: gana el visitante', (o) => o.pHtAway, (o) => o.htAway, rows);
  line('el local gana alguna mitad', (o) => o.pEitherHome, (o) => o.eitherHome, rows);
  line('el visitante gana alguna mitad', (o) => o.pEitherAway, (o) => o.eitherAway, rows);
  line('descanso: más de 0.5 goles', (o) => o.pHtOver05, (o) => o.htOver05, rows);
  line('descanso: más de 1.5 goles', (o) => o.pHtOver15, (o) => o.htOver15, rows);
  console.log('  — candidatos de partido completo —');
  line('más de 1.5 goles', (o) => o.pOver15, (o) => o.over15, rows);
  line('más de 3.5 goles', (o) => o.pOver35, (o) => o.over35, rows);
  line('el local deja la portería a 0', (o) => o.pCsHome, (o) => o.csHome, rows);
  line('el visitante deja la portería a 0', (o) => o.pCsAway, (o) => o.csAway, rows);
  line('gana el local sin encajar', (o) => o.pWinToNilHome, (o) => o.winToNilHome, rows);
  console.log();
}

report('TODO EL ARCHIVO', obs);
// Walk-forward in the only sense available here: the ratings that produced these λ
// were built from earlier matches only (replayMatches is the same engine the
// backtest uses), so every row is already out-of-sample. Splitting by season shows
// whether the calibration holds in the seasons nobody tuned anything on.
report('SOLO 2025-2026', obs.filter((o) => o.season >= 2025));
getDb();

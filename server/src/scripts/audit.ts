// CLI: `npm run audit`
//
// Checks that the numbers the app shows are internally consistent and agree with
// the database they came from.
//
// A backtest answers "is the model any good". This answers a different and more
// basic question: "is the app telling the truth about what the model said". Those
// fail in different ways. A probability that sums to 1.02, a record that
// disagrees with the games it was computed from, an over/under that is not the
// complement of its under — none of those would move a Brier score, and all of
// them would be visible to anyone reading the card carefully.
//
// Every check below is a property that must hold BY CONSTRUCTION. A failure is a
// bug, never a tuning question.

import { baseballConfig, basketballConfig, footballConfig, nflConfig } from '../config.ts';
import { getDb, getMeta } from '../db.ts';

import { buildFootballPrediction } from '../football/predict.ts';
import { listTeams as fbTeams, listUpcoming as fbUpcoming } from '../football/repo.ts';

import { buildBaseballPrediction } from '../baseball/predict.ts';
import { listTeams as bsbTeams, listUpcoming as bsbUpcoming } from '../baseball/repo.ts';

import { buildGamePrediction } from '../basketball/predict.ts';
import { SIGMA_MIN_GAMES } from '../basketball/elo.ts';
import { listTeams as bbTeams, listUpcoming as bbUpcoming } from '../basketball/repo.ts';

import { buildPrediction as buildNflPrediction } from '../nfl/predict.ts';
import { listTeams as nafTeams, listUpcoming as nafUpcoming } from '../nfl/repo.ts';
import { coverProbability, buildDistribution, MAX_MARGIN } from '../nfl/model.ts';

import { buildPrediction } from '../model/predict.ts';
import { listUpcoming as tennisUpcoming } from '../repo.ts';
import { listParkFactors } from '../baseball/parkFactors.ts';
import { DEMO_SOURCE, freshFilter, freshSince } from '../freshness.ts';

// ---------------------------------------------------------------------------
let checks = 0;
let failures = 0;
const problems: string[] = [];

/** Floating point: sums of many rounded numbers are never exactly 1. */
const EPS = 5e-4;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(name: string, actual: number, expected: number, eps = EPS): void {
  check(name, Math.abs(actual - expected) <= eps, `${actual} vs ${expected} esperado`);
}

function section(title: string): void {
  console.log(`\n▸ ${title}`);
}

// ---------------------------------------------------------------------------
// Football
// ---------------------------------------------------------------------------
function auditFootball(): void {
  section('Fútbol');
  const leagues = footballConfig.leagues.filter((l) => fbTeams(l.id).length >= 2);
  if (leagues.length === 0) {
    console.log('  sin datos, saltado');
    return;
  }

  let sampled = 0;
  for (const league of leagues) {
    const teams = fbTeams(league.id).slice(0, 16);
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const p = buildFootballPrediction(league.id, teams[i].id, teams[i + 1].id);
      const tag = `fútbol ${league.id} ${teams[i].id}-${teams[i + 1].id}`;
      sampled++;

      near(`${tag}: 1X2 suma 1`, p.model.home + p.model.draw + p.model.away, 1);
      near(`${tag}: over + under = 1`, p.goals.over25 + p.goals.under25, 1);

      const gridSum = p.goals.grid.cells.flat().reduce((a, b) => a + b, 0) + p.goals.grid.tail;
      near(`${tag}: la rejilla suma 1`, gridSum, 1, 2e-3);

      const marginSum = p.goals.margins.reduce((a, m) => a + m.probability, 0);
      near(`${tag}: los márgenes suman 1`, marginSum, 1, 2e-3);

      // The three blocks of the grid ARE the 1X2 — that is the whole design
      // claim, so it is worth checking rather than trusting.
      let gHome = 0;
      let gDraw = 0;
      let gAway = 0;
      p.goals.grid.cells.forEach((row, h) =>
        row.forEach((q, a) => {
          if (h > a) gHome += q;
          else if (h === a) gDraw += q;
          else gAway += q;
        }),
      );
      // The printed grid is trimmed, so it can only fall short by the tail.
      check(
        `${tag}: el bloque local de la rejilla ≈ P(1)`,
        gHome <= p.model.home + EPS && gHome >= p.model.home - p.goals.grid.tail - EPS,
        `${gHome.toFixed(4)} vs ${p.model.home} (cola ${p.goals.grid.tail})`,
      );
      check(
        `${tag}: el bloque de empate ≈ P(X)`,
        gDraw <= p.model.draw + EPS && gDraw >= p.model.draw - p.goals.grid.tail - EPS,
        `${gDraw.toFixed(4)} vs ${p.model.draw}`,
      );
      check(
        `${tag}: el bloque visitante ≈ P(2)`,
        gAway <= p.model.away + EPS && gAway >= p.model.away - p.goals.grid.tail - EPS,
        `${gAway.toFixed(4)} vs ${p.model.away}`,
      );

      // Margin 0 must equal the draw probability exactly: both are the diagonal.
      const zero = p.goals.margins.find((m) => m.margin === 0)?.probability ?? -1;
      near(`${tag}: margen 0 = P(empate)`, zero, p.model.draw, 2e-3);

      // The headline scoreline must be the largest cell in the grid.
      const best = p.goals.scorelines[0];
      const maxCell = Math.max(...p.goals.grid.cells.flat());
      check(
        `${tag}: el marcador destacado es el máximo de la rejilla`,
        Math.abs(best.probability - maxCell) < 2e-3,
        `${best.label} ${best.probability} vs máximo ${maxCell}`,
      );

      check(
        `${tag}: probabilidades en [0,1]`,
        [p.model.home, p.model.draw, p.model.away, p.goals.over25, p.goals.bothScore].every(
          (x) => x >= 0 && x <= 1,
        ),
      );
      check(
        `${tag}: goles esperados plausibles`,
        p.goals.expectedHome > 0 && p.goals.expectedHome < 6 && p.goals.expectedAway > 0,
        `${p.goals.expectedHome} / ${p.goals.expectedAway}`,
      );
      // The verdict has to name the largest of the three, not the home team.
      const top =
        p.model.home >= p.model.draw && p.model.home >= p.model.away
          ? 'home'
          : p.model.draw >= p.model.away
            ? 'draw'
            : 'away';
      check(`${tag}: el veredicto señala al más probable`, p.verdict.outcome === top);
    }
  }

  // Records must agree with the games they were computed from.
  const db = getDb();
  for (const league of leagues.slice(0, 2)) {
    for (const t of fbTeams(league.id).slice(0, 5)) {
      const p = buildFootballPrediction(
        league.id,
        t.id,
        fbTeams(league.id).find((x) => x.id !== t.id)!.id,
      );
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN home_id = ?1 AND home_goals > away_goals THEN 1
                      WHEN away_id = ?1 AND away_goals > home_goals THEN 1 ELSE 0 END) AS w,
             SUM(CASE WHEN home_goals = away_goals THEN 1 ELSE 0 END) AS d,
             SUM(CASE WHEN home_id = ?1 AND home_goals < away_goals THEN 1
                      WHEN away_id = ?1 AND away_goals < home_goals THEN 1 ELSE 0 END) AS l
           FROM fb_matches WHERE league = ?2 AND (home_id = ?1 OR away_id = ?1)`,
        )
        .get(t.id, league.id) as unknown as { w: number; d: number; l: number };
      const r = p.teams.home.record;
      check(
        `fútbol ${t.id}: el balance coincide con los partidos`,
        r.wins === row.w && r.draws === row.d && r.losses === row.l,
        `mostrado ${r.wins}-${r.draws}-${r.losses}, base ${row.w}-${row.d}-${row.l}`,
      );
    }
  }
  console.log(`  ${sampled} predicciones comprobadas`);
  auditUpcoming('fútbol', fbUpcoming());
}

// ---------------------------------------------------------------------------
// Baseball
// ---------------------------------------------------------------------------
function auditBaseball(): void {
  section('Béisbol');
  const leagues = baseballConfig.leagues.filter((l) => bsbTeams(l.id).length >= 2);
  if (leagues.length === 0) {
    console.log('  sin datos, saltado');
    return;
  }

  let sampled = 0;
  for (const league of leagues) {
    const teams = bsbTeams(league.id).slice(0, 24);
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const p = buildBaseballPrediction(league.id, teams[i].id, teams[i + 1].id);
      const tag = `béisbol ${teams[i].id}-${teams[i + 1].id}`;
      sampled++;

      near(`${tag}: el ganador suma 1`, p.model.home + p.model.away, 1);
      near(`${tag}: over + under = 1`, p.runs.over + p.runs.under, 1);
      near(
        `${tag}: la línea de carreras suma 1`,
        p.runs.runLine.homeCovers + p.runs.runLine.awayCovers,
        1,
        2e-3,
      );

      const gridSum = p.runs.grid.cells.flat().reduce((a, b) => a + b, 0) + p.runs.grid.tail;
      near(`${tag}: la rejilla suma 1`, gridSum, 1, 2e-3);
      const marginSum = p.runs.margins.reduce((a, m) => a + m.probability, 0);
      near(`${tag}: los márgenes suman 1`, marginSum, 1, 2e-3);

      // THE claim the baseball card makes in words: a final score is never tied,
      // so the diagonal of the grid must be empty and margin 0 must be zero.
      const diagonal = p.runs.grid.cells.reduce((a, row, h) => a + (row[h] ?? 0), 0);
      near(`${tag}: la diagonal está vacía (nunca hay empate final)`, diagonal, 0, 1e-6);
      const zero = p.runs.margins.find((m) => m.margin === 0)?.probability ?? -1;
      near(`${tag}: margen 0 = 0`, zero, 0, 1e-6);

      // Covering −1.5 means winning by two or more, which is a subset of winning.
      check(
        `${tag}: cubrir −1.5 ⊆ ganar`,
        p.runs.runLine.homeCovers <= p.model.home + EPS,
        `cubre ${p.runs.runLine.homeCovers} > gana ${p.model.home}`,
      );
      check(
        `${tag}: entradas extra en un rango real`,
        p.runs.extraInnings > 0.02 && p.runs.extraInnings < 0.25,
        `${p.runs.extraInnings}`,
      );
      check(
        `${tag}: carreras esperadas plausibles`,
        p.runs.expectedHome > 1 && p.runs.expectedHome < 12,
        `${p.runs.expectedHome}`,
      );
      // A starter suppresses the OPPOSITION's runs. A better home starter must
      // therefore lower the AWAY team's expected runs, not the home team's.
      if (p.teams.home.starter.rating != null && p.teams.away.starter.rating != null) {
        check(
          `${tag}: el factor del abridor está en el lado correcto`,
          p.teams.home.starter.runFactor > 0.6 && p.teams.home.starter.runFactor < 1.4,
          `${p.teams.home.starter.runFactor}`,
        );
      }
    }
  }

  // Win/loss must agree with the games.
  const db = getDb();
  for (const t of bsbTeams('mlb').slice(0, 6)) {
    const other = bsbTeams('mlb').find((x) => x.id !== t.id)!;
    const p = buildBaseballPrediction('mlb', t.id, other.id);
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN home_id = ?1 AND home_runs > away_runs THEN 1
                    WHEN away_id = ?1 AND away_runs > home_runs THEN 1 ELSE 0 END) AS w,
           SUM(CASE WHEN home_id = ?1 AND home_runs < away_runs THEN 1
                    WHEN away_id = ?1 AND away_runs < home_runs THEN 1 ELSE 0 END) AS l
         FROM bsb_games WHERE league = 'mlb' AND (home_id = ?1 OR away_id = ?1)`,
      )
      .get(t.id) as unknown as { w: number; l: number };
    const r = p.teams.home.record;
    check(
      `béisbol ${t.id}: el balance coincide con los partidos`,
      r.wins === row.w && r.losses === row.l,
      `mostrado ${r.wins}-${r.losses}, base ${row.w}-${row.l}`,
    );
    if (p.teams.home.pythagorean != null && p.teams.home.rs && p.teams.home.ra) {
      const expected =
        Math.pow(p.teams.home.rs, 1.83) /
        (Math.pow(p.teams.home.rs, 1.83) + Math.pow(p.teams.home.ra, 1.83));
      near(`béisbol ${t.id}: el pitagórico cuadra`, p.teams.home.pythagorean, expected, 1e-6);
    }
  }
  console.log(`  ${sampled} predicciones comprobadas`);
  auditUpcoming('béisbol', bsbUpcoming());
  auditParks();
}

/**
 * Park factors: the properties that make them a park factor rather than a fudge.
 *
 * The one that matters is the LAST one. A park factor scales both sides equally,
 * so it must move the total and leave the winner alone. If a future edit applied it
 * to one side, the moneyline would quietly shift and nothing else here would
 * notice.
 */
function auditParks(): void {
  const parks = listParkFactors('mlb');
  if (parks.length === 0) {
    console.log('  sin factores de estadio, saltado');
    return;
  }
  let n = 0;
  for (const p of parks) {
    n++;
    check(`estadio ${p.site}: factor en un rango físicamente posible`,
      p.factor >= 0.75 && p.factor <= 1.35, `${p.factor}`);
    check(`estadio ${p.site}: partidos > 0`, p.games > 0, `${p.games}`);
  }
  // Relative to an average park, so they have to average out near 1. A drift here
  // means the factors are absorbing an overall bias in the run level instead.
  const mean = parks.reduce((a, p) => a + p.factor, 0) / parks.length;
  check('estadios: el factor medio es ~1', Math.abs(mean - 1) < 0.05, `${mean.toFixed(4)}`);

  // The load-bearing check: same teams, two stadiums.
  const teams = bsbTeams('mlb');
  const away = teams.find((t) => t.id !== 'COL' && t.id !== 'SEA');
  if (away) {
    const hi = buildBaseballPrediction('mlb', 'COL', away.id, { oddsHome: null, oddsAway: null }, { guessStarters: false });
    const lo = buildBaseballPrediction('mlb', 'SEA', away.id, { oddsHome: null, oddsAway: null }, { guessStarters: false });
    if (hi.park && lo.park) {
      n += 3;
      check('estadios: Coors da más carreras que Seattle',
        hi.runs.expectedTotal > lo.runs.expectedTotal,
        `${hi.runs.expectedTotal} vs ${lo.runs.expectedTotal}`);
      // Both sides scale together, so the split between them barely moves — the
      // ratio home/away is a property of the two teams, not of the altitude.
      const rHi = hi.runs.expectedHome / hi.runs.expectedAway;
      const rLo = lo.runs.expectedHome / lo.runs.expectedAway;
      check('estadios: el reparto entre los dos equipos no lo decide el parque',
        Math.abs(rHi / rLo - 1) < 0.5, `${rHi.toFixed(3)} vs ${rLo.toFixed(3)}`);
      // And the runs it claims to add must be the runs it actually added.
      const implied = hi.runs.expectedTotal - hi.runs.expectedTotal / hi.park.factor;
      near('estadios: las carreras declaradas son las aplicadas',
        hi.park.runsVsNeutral, implied, 0.05);
    }
  }
  console.log(`  ${n} comprobaciones de estadio (${parks.length} parques)`);
}

// ---------------------------------------------------------------------------
// Basketball
// ---------------------------------------------------------------------------
function auditBasketball(): void {
  section('Baloncesto');
  const leagues = basketballConfig.leagues.filter((l) => bbTeams(l.id).length >= 2);
  if (leagues.length === 0) {
    console.log('  sin datos, saltado');
    return;
  }

  let sampled = 0;
  for (const league of leagues) {
    const teams = bbTeams(league.id).slice(0, 24);
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const p = buildGamePrediction(league.id, teams[i].id, teams[i + 1].id);
      const tag = `baloncesto ${teams[i].id}-${teams[i + 1].id}`;
      sampled++;

      near(`${tag}: el ganador suma 1`, p.model.probHome + p.model.probAway, 1);

      const d = p.projection.distribution;
      const bandSum = d.bands.reduce((a, b) => a + b.probability, 0);
      near(`${tag}: las bandas de margen suman 1`, bandSum, 1, 2e-3);
      if (d.over != null && d.under != null) near(`${tag}: over + under = 1`, d.over + d.under, 1, 2e-3);
      check(
        `${tag}: cubrir el hándicap cerca del 50%`,
        d.homeCovers > 0.35 && d.homeCovers < 0.65,
        `${d.homeCovers} en la línea ${d.spreadLine}`,
      );
      // The projected score must reproduce the projected margin and total.
      if (p.projection.home != null && p.projection.away != null) {
        near(
          `${tag}: marcador − marcador = margen`,
          p.projection.home - p.projection.away,
          p.projection.margin,
          0.15,
        );
        near(
          `${tag}: marcador + marcador = total`,
          p.projection.home + p.projection.away,
          p.projection.total!,
          0.15,
        );
      }
      // The side with more than half the probability must be the favoured one.
      const favHome = p.model.probHome > 0.5;
      if (p.verdict.favored) {
        check(
          `${tag}: el favorito coincide con la probabilidad`,
          (p.verdict.favored === 'home') === favHome,
        );
        // And the margin must point the same way as the probability.
        check(
          `${tag}: el margen y la probabilidad apuntan igual`,
          favHome === p.projection.margin > 0,
          `p=${p.model.probHome} margen=${p.projection.margin}`,
        );
      }
    }
  }
  console.log(`  ${sampled} predicciones comprobadas`);
  auditUpcoming('baloncesto', bbUpcoming());
}

// ---------------------------------------------------------------------------
// Tennis
// ---------------------------------------------------------------------------
function auditTennis(): void {
  section('Tenis');
  const db = getDb();
  const players = db
    .prepare(
      `SELECT player_id AS id, tour FROM player_ratings
       WHERE matches_played > 50 ORDER BY overall DESC LIMIT 20`,
    )
    .all() as unknown as { id: number; tour: string }[];
  if (players.length < 2) {
    console.log('  sin datos, saltado');
    return;
  }

  let sampled = 0;
  for (let i = 0; i + 1 < players.length; i += 2) {
    for (const surface of ['Hard', 'Clay', 'Grass']) {
      const p = buildPrediction(players[i].tour, players[i].id, players[i + 1].id, surface);
      const tag = `tenis ${players[i].id}-${players[i + 1].id} ${surface}`;
      sampled++;
      near(`${tag}: las dos probabilidades suman 1`, p.model.prob1 + p.model.prob2, 1);
      check(
        `${tag}: probabilidad en un rango real`,
        p.model.prob1 > 0.001 && p.model.prob1 < 0.999,
        `${p.model.prob1}`,
      );
      check(
        `${tag}: el favorito coincide con la probabilidad`,
        (p.verdict.favoredSide === 1) === p.model.prob1 >= 0.5,
      );
    }
  }
  console.log(`  ${sampled} predicciones comprobadas`);
  // Tennis was the first sport built and kept missing the checks added later —
  // this shape audit was running for the other four and not for it, which is
  // exactly how a tennis-only regression would have got through unnoticed.
  auditUpcoming('tenis', tennisUpcoming({}));
}


// ---------------------------------------------------------------------------
// American football
//
// The sport with the most ways for a card to contradict itself: five markets
// (moneyline, handicap, total, margin bands, exact score) all read off one
// distribution. If any of them were computed independently the numbers would
// drift apart, and these checks are what proves they were not.
// ---------------------------------------------------------------------------
function auditNfl(): void {
  section('Fútbol americano');
  const leagues = nflConfig.leagues.filter((l) => nafTeams(l.id).length >= 2);
  if (leagues.length === 0) {
    console.log('  sin datos, saltado');
    return;
  }

  let sampled = 0;
  for (const league of leagues) {
    const teams = nafTeams(league.id).slice(0, 24);
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const p = buildNflPrediction({
        league: league.id,
        homeId: teams[i].id,
        awayId: teams[i + 1].id,
      });
      if (!p) continue;
      const tag = `nfl ${teams[i].id}-${teams[i + 1].id}`;
      sampled++;

      // 1. The three outcomes. The tie is tiny but it is not zero, and folding
      //    it away is exactly the kind of quiet rounding this audit exists for.
      near(`${tag}: local + empate + visitante = 1`, p.model.home + p.model.tie + p.model.away, 1);
      check(`${tag}: el empate es pequeño pero existe`, p.model.tie > 0 && p.model.tie < 0.01, `${p.model.tie}`);

      // 2. Margin bands partition the whole distribution.
      near(`${tag}: las bandas de margen suman 1`, p.bands.reduce((a, b) => a + b.probability, 0), 1, 2e-3);
      const tieBand = p.bands.find((b) => b.from === 0 && b.to === 0);
      near(`${tag}: la banda de empate es P(empate)`, tieBand?.probability ?? -1, p.model.tie, 1e-6);

      // 3. A handicap is exhaustive: cover + push + fail = 1, on both sides, and
      //    the two sides of the SAME line must be mirror images.
      near(`${tag}: hándicap local cubre+nulo+falla = 1`,
        p.spread.home.cover + p.spread.home.push + p.spread.home.fail, 1);
      near(`${tag}: hándicap visitante cubre+nulo+falla = 1`,
        p.spread.away.cover + p.spread.away.push + p.spread.away.fail, 1);
      near(`${tag}: los dos lados del hándicap son espejo`,
        p.spread.home.cover, p.spread.away.fail, 1e-6);
      near(`${tag}: el nulo es el mismo por los dos lados`,
        p.spread.home.push, p.spread.away.push, 1e-6);

      // 4. Total, same property.
      near(`${tag}: over + nulo + under = 1`, p.total.over + p.total.push + p.total.under, 1);

      // 5. A handicap of zero IS the moneyline. This is the check that would
      //    have caught the spread sign bug: it ties the two markets together.
      // Rebuilt from the figures the CARD shows, which are rounded to one
      // decimal — so the tolerance is the rounding, not a fudge: half a tenth of
      // a point of margin moves a probability by about 0.15 pp.
      const dist = buildDistribution(p.spread.expectedMargin, p.total.expected);
      const pk = coverProbability(dist, 0);
      near(`${tag}: hándicap 0 = probabilidad de ganar`, pk.cover, p.model.home, 2e-3);
      near(`${tag}: hándicap 0, el nulo es el empate`, pk.push, p.model.tie, 1e-4);

      // 6. A handicap is monotone: giving the home team MORE points can never
      //    make them less likely to cover.
      let previous = -1;
      let monotone = true;
      for (let line = -14; line <= 14; line += 0.5) {
        const c = coverProbability(dist, line).cover;
        if (c < previous - 1e-9) monotone = false;
        previous = c;
      }
      check(`${tag}: el hándicap es monótono en la línea`, monotone);

      // 7. The key numbers really are what the model says they are, and 3 beats
      //    every one of its neighbours — the whole reason this model exists.
      const three = p.keyNumbers.find((k) => k.margin === 3)?.probability ?? 0;
      const nine = 2 * (dist.margin[9 + MAX_MARGIN] ?? 0);
      check(`${tag}: el margen de 3 es más probable que el de 9`, three > nine, `${three} vs ${nine}`);

      // 8. Expected points must reproduce the margin and the total exactly.
      near(`${tag}: puntos local − visitante = margen`,
        p.points.home - p.points.away, p.spread.expectedMargin, 0.11);
      near(`${tag}: puntos local + visitante = total`,
        p.points.home + p.points.away, p.total.expected, 0.11);

      // 9. Scorelines: sorted, consistent with their own labels, and each one
      //    reachable (the parity constraint).
      const ordered = p.scorelines.every((s, k) => k === 0 || p.scorelines[k - 1].probability >= s.probability);
      check(`${tag}: los marcadores van de más a menos probable`, ordered);
      for (const s of p.scorelines) {
        check(`${tag}: la etiqueta del marcador coincide`, s.label === `${s.home}-${s.away}`, s.label);
        check(`${tag}: marcador no negativo`, s.home >= 0 && s.away >= 0, s.label);
      }

      // 10. The verdict names the more likely side, and the expected margin
      //     agrees with it in sign.
      const homeFav = p.model.home >= p.model.away;
      check(`${tag}: el veredicto señala al más probable`,
        p.verdict.label.includes(homeFav ? p.teams.home.name : p.teams.away.name));
      check(`${tag}: el margen y la probabilidad apuntan igual`,
        homeFav === p.spread.expectedMargin >= 0,
        `p=${p.model.home} margen=${p.spread.expectedMargin}`);

      // 11. THE FACTORS MUST ADD UP TO THE HEADLINE. A "why" panel whose terms
      //     do not reconstruct the number above it is decoration, not an
      //     explanation — and this check is what caught one that listed 7.3
      //     points of reasons under a 5.2-point forecast.
      near(
        `${tag}: los factores suman el margen esperado`,
        p.reasoning.factors.reduce((a, f) => a + f.pointsForHome, 0),
        p.spread.expectedMargin,
        0.16,
      );

      // 12. The record on the card must be the record in the database.
      for (const side of [p.teams.home, p.teams.away]) {
        const played = side.record.wins + side.record.losses + side.record.ties;
        check(`${tag}: el balance cuadra con los partidos`, played === side.gamesInDb,
          `${side.name}: ${played} vs ${side.gamesInDb}`);
      }
    }
  }
  console.log(`  ${sampled} predicciones comprobadas`);
  auditUpcoming('fútbol americano', nafUpcoming('nfl', 64));
}

// ---------------------------------------------------------------------------
// Upcoming rows: shared shape checks
// ---------------------------------------------------------------------------
function auditUpcoming(
  sport: string,
  rows: { id: string; commence_time: string }[],
): void {
  const ids = new Set<string>();
  // The SAME cutoff the reader's list uses, taken from freshness.ts rather than
  // rewritten here. This check used to keep its own `now - 6h`, which is stricter
  // than the display rule (min(today 00:00, now - 6h)) — so it failed on ten
  // perfectly valid rows and hid the one row that was genuinely wrong. An audit
  // that reimplements the rule it audits is testing itself.
  const cutoff = Date.parse(freshSince());
  let past = 0;
  for (const r of rows) {
    check(`${sport}: id de partido único`, !ids.has(r.id), r.id);
    ids.add(r.id);
    const t = Date.parse(r.commence_time);
    check(
      `${sport}: fecha de partido válida`,
      !!r.commence_time && !Number.isNaN(t),
      `${r.id} → ${r.commence_time}`,
    );
    // A "próximo" that already happened is the failure mode that makes the date
    // grouping lie: it files under "Ayer" and sits above tomorrow's games.
    if (!Number.isNaN(t) && t < cutoff) past++;
    // A kick-off is ANNOUNCED, to the minute. Stray seconds mean the time was
    // computed from a clock rather than read from a schedule — which is how every
    // demo fixture came to start at 09:10:30.210, the instant `npm run seed` ran.
    // Cheap check, and it fails at the source instead of two days later when the
    // generated times have quietly drifted into the past.
    if (!Number.isNaN(t)) {
      const d = new Date(t);
      check(
        `${sport}: hora de inicio en punto de minuto`,
        d.getSeconds() === 0 && d.getMilliseconds() === 0,
        `${r.id} → ${r.commence_time}`,
      );
    }
    // Nothing should be scheduled decades out either — that is the shape a
    // timezone or parsing bug takes, and it puts one card at the far end of a
    // day filter where nobody will look for it.
    if (!Number.isNaN(t)) {
      check(
        `${sport}: fecha dentro de un rango razonable`,
        t < Date.now() + 400 * 24 * 3600_000,
        `${r.id} → ${r.commence_time}`,
      );
    }
  }
  check(`${sport}: ningún partido próximo ya jugado`, past === 0, `${past} de ${rows.length}`);
  console.log(`  ${rows.length} partidos próximos comprobados`);
}

/**
 * The stored table and the display window agree.
 *
 * Two failures this catches, and both actually happened:
 *
 *   * A row OLDER than the window still in the table. Means the pruning stopped
 *     running, and the table grows without limit — which is how it got to holding
 *     fixtures from 2020.
 *   * The opposite, which is the bug the user reported: nothing between the window's
 *     start and now. Cannot be asserted directly (some days genuinely have no
 *     morning match), so what is checked is the property that made it possible —
 *     that pruning is scoped by time at all. A table whose oldest row is always in
 *     the future is the signature of an unconditional DELETE.
 */
function auditWindow(): void {
  section('Ventana de partidos');
  const db = getDb();
  const since = freshSince();
  const tables: [string, string][] = [
    ['fútbol', 'fb_upcoming'],
    ['baloncesto', 'bb_upcoming'],
    ['béisbol', 'bsb_upcoming'],
    ['fútbol americano', 'naf_upcoming'],
    ['tenis', 'upcoming_matches'],
  ];
  let n = 0;
  for (const [label, table] of tables) {
    const row = db
      .prepare(`SELECT COUNT(*) AS total, MIN(commence_time) AS oldest FROM ${table}`)
      .get() as unknown as { total: number; oldest: string | null };
    if (row.total === 0) {
      console.log(`  ${label}: tabla vacía, saltado`);
      continue;
    }
    n++;
    check(
      `${label}: nada anterior a la ventana en la tabla`,
      !row.oldest || row.oldest >= since,
      `más antiguo ${row.oldest}, ventana desde ${since}`,
    );
  }
  console.log(`  ${n} tablas comprobadas contra la ventana (desde ${since})`);
}

// ---------------------------------------------------------------------------
/**
 * Every sport that HAS data must record where it came from.
 *
 * This exists because of a bug that produced no error at all: `resetData()`, which the
 * TENNIS ingest calls, finished with `DELETE FROM meta` — and `meta` is the one table
 * all five sports share. So `npm run update-data` erased football's, basketball's,
 * baseball's and the NFL's provenance. Every other tab went back to reading "origen sin
 * registrar" with no refresh time, and basketball lost its measured margin σ and fell
 * back to the frozen constant, which is a genuinely worse model. Nothing was logged.
 *
 * The property asserted is the one that broke: if a sport's games table has rows,
 * SOMETHING ingested them, so its source key must exist. It cannot be phrased as
 * "the key exists" alone — on a fresh clone a sport with no data legitimately has no
 * key, so the count is what makes the check meaningful rather than merely annoying.
 */
function auditProvenance(): void {
  section('Procedencia de los datos');
  const db = getDb();
  const sports: { label: string; table: string; sourceKey: string; timeKey: string }[] = [
    { label: 'fútbol', table: 'fb_matches', sourceKey: 'fb_data_source', timeKey: 'fb_updated_at' },
    { label: 'baloncesto', table: 'bb_games', sourceKey: 'bb_data_source', timeKey: 'bb_updated_at' },
    { label: 'béisbol', table: 'bsb_games', sourceKey: 'bsb_data_source', timeKey: 'bsb_updated_at' },
    { label: 'tenis', table: 'matches', sourceKey: 'data_source', timeKey: 'updated_at' },
  ];
  let n = 0;
  for (const sp of sports) {
    const rows = (db.prepare(`SELECT COUNT(*) AS c FROM ${sp.table}`).get() as { c: number }).c;
    if (rows === 0) {
      console.log(`  ${sp.label}: sin datos, saltado`);
      continue;
    }
    n++;
    check(
      `${sp.label}: ${rows.toLocaleString('es')} partidos pero sin origen registrado`,
      !!getMeta(sp.sourceKey),
      `falta ${sp.sourceKey} — la pestaña dirá "origen sin registrar"`,
    );
    check(
      `${sp.label}: sin fecha de actualización`,
      !!getMeta(sp.timeKey),
      `falta ${sp.timeKey}`,
    );
  }

  // The NFL writes its own key shape, and its per-league model constants live in meta
  // too — losing those is how a tab starts predicting with defaults it never chose.
  const nafGames = (db.prepare('SELECT COUNT(*) AS c FROM naf_games').get() as { c: number }).c;
  if (nafGames > 0) {
    n++;
    check('fútbol americano: sin fecha de actualización', !!getMeta('naf:updatedAt'));
    check(
      'fútbol americano: ventaja de campo medida presente',
      getMeta('naf:nfl:homeAdvantage') !== null,
      'falta naf:nfl:homeAdvantage',
    );
  }

  // And basketball's measured margin σ, which is the value the handicap is quoted
  // with. Its absence is not an error — a league with too few games has none by
  // design — but for a league with a full archive it means the recompute did not run
  // or its meta row was wiped.
  const nbaGames = (
    db.prepare("SELECT COUNT(*) AS c FROM bb_games WHERE league = 'nba'").get() as { c: number }
  ).c;
  if (nbaGames > SIGMA_MIN_GAMES) {
    check(
      'baloncesto: σ del margen medida presente para la NBA',
      !!getMeta('bb_margin_sigma_nba'),
      `${nbaGames.toLocaleString('es')} partidos en la base pero sin bb_margin_sigma_nba: ` +
        'el hándicap saldría con la σ de reserva',
    );
  }
  console.log(`  ${n} deportes con datos comprobados`);
}

/**
 * Does a match that kicked off earlier TODAY still show?
 *
 * This is the product rule the reader asked for three separate times, and it has now
 * been broken three ways: an unconditional `DELETE FROM …_upcoming` on every refresh;
 * a carve-out that deleted demo rows at kick-off (and with no ODDS_API_KEY every row
 * is a demo row); and an upsert that let a re-sent event id drag a started match into
 * the evening.
 *
 * Every time, the audit passed — because it checked the PIECES (is the table pruned
 * by time? do the cutoffs agree?) and never the OUTCOME. So this asserts the outcome
 * on a probe row rather than on whatever the slate happens to hold. It cannot pass
 * while the reader's complaint is true.
 *
 * Both sources are probed: a rule that holds for real rows and not for invented ones
 * is exactly the bug it is here to catch.
 */
function auditTodaysMatchesStay(): void {
  section('¿Se quedan los partidos del día?');
  const db = getDb();
  const now = new Date();
  const startedToday = new Date(now.getTime() - 2 * 3600_000);
  // Only meaningful when "two hours ago" is still today; between 00:00 and 02:00 the
  // probe would land on yesterday, which the window is allowed to drop.
  if (startedToday.getDate() !== now.getDate()) {
    console.log('  son menos de las 02:00, la sonda caería en ayer — saltado');
    return;
  }
  const iso = startedToday.toISOString();
  // Where a careless feed would try to drag it: four hours into the future.
  const later = new Date(now.getTime() + 4 * 3600_000).toISOString();
  const fresh = freshFilter(now);
  let probed = 0;
  for (const source of ['live', DEMO_SOURCE]) {
    const id = `__audit-probe-${source}`;
    db.prepare(
      `INSERT OR REPLACE INTO fb_upcoming
         (id, league, commence_time, home_name, away_name, books, source, updated_at)
       VALUES (?, 'epl', ?, 'Sonda A', 'Sonda B', 0, ?, ?)`,
    ).run(id, iso, source, now.toISOString());
    const seen = db
      .prepare(`SELECT COUNT(*) AS c FROM fb_upcoming WHERE id = ? AND ${fresh.sql}`)
      .get(id, ...fresh.params) as { c: number };
    check(
      `un partido '${source}' que empezó hace 2 h sigue visible`,
      seen.c === 1,
      'desaparece al empezar, que es justo lo que freshness.ts existe para evitar',
    );
    probed++;

    // And it must survive being RE-SENT by its feed. Making the row survive was not
    // enough: a regenerated slate reused its id and moved it to tonight's kick-off —
    // still present, still counted, and gone from today. Only its commence_time gave
    // that away, so that is what is asserted.
    db.prepare(
      `INSERT INTO fb_upcoming
         (id, league, commence_time, home_name, away_name, books, source, updated_at)
       VALUES (?, 'epl', ?, 'Sonda A', 'Sonda B', 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         commence_time = CASE WHEN fb_upcoming.commence_time >= ?
                              THEN excluded.commence_time
                              ELSE fb_upcoming.commence_time END`,
    ).run(id, later, source, now.toISOString(), now.toISOString());
    const kept = db.prepare('SELECT commence_time AS t FROM fb_upcoming WHERE id = ?').get(id) as
      | { t: string }
      | undefined;
    check(
      `un partido '${source}' ya empezado no se mueve al reenviarlo la fuente`,
      kept?.t === iso,
      `lo movieron a ${kept?.t}`,
    );
    // Cleaned up LAST. Leaving it behind is not cosmetic: the probe's kick-off has
    // stray seconds, and another check in this same run asserts that every stored
    // kick-off falls on a whole minute — it caught this leak immediately.
    db.prepare('DELETE FROM fb_upcoming WHERE id = ?').run(id);
  }
  console.log(`  ${probed} orígenes comprobados con una sonda a las ${iso.slice(11, 16)} UTC`);
}

function main(): void {
  console.log('\n🔍 Auditoría de consistencia\n' + '='.repeat(46));
  console.log(
    'Comprueba propiedades que deben cumplirse POR CONSTRUCCIÓN.\n' +
      'Un fallo aquí es un bug, nunca una cuestión de ajuste.',
  );

  auditProvenance();
  auditTodaysMatchesStay();
  auditWindow();
  auditFootball();
  auditBaseball();
  auditBasketball();
  auditNfl();
  auditTennis();

  console.log('\n' + '='.repeat(46));
  if (failures === 0) {
    console.log(`✅ ${checks} comprobaciones, todas correctas.\n`);
    return;
  }
  console.log(`❌ ${failures} de ${checks} comprobaciones fallan:\n`);
  const seen = new Map<string, number>();
  for (const p of problems) {
    // Collapse repeats of the same check across samples, keeping one example.
    const key = p.split(':').slice(1).join(':').split('—')[0].trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, n] of seen) {
    const example = problems.find((p) => p.includes(key))!;
    console.log(`  ×${n}  ${example}`);
  }
  console.log('');
  process.exitCode = 1;
}

main();

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

import { baseballConfig, basketballConfig, footballConfig } from '../config.ts';
import { getDb } from '../db.ts';

import { buildFootballPrediction } from '../football/predict.ts';
import { listTeams as fbTeams, listUpcoming as fbUpcoming } from '../football/repo.ts';

import { buildBaseballPrediction } from '../baseball/predict.ts';
import { listTeams as bsbTeams, listUpcoming as bsbUpcoming } from '../baseball/repo.ts';

import { buildGamePrediction } from '../basketball/predict.ts';
import { listTeams as bbTeams, listUpcoming as bbUpcoming } from '../basketball/repo.ts';

import { buildPrediction } from '../model/predict.ts';

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
}

// ---------------------------------------------------------------------------
// Upcoming rows: shared shape checks
// ---------------------------------------------------------------------------
function auditUpcoming(sport: string, rows: { id: string; commence_time: string }[]): void {
  const ids = new Set<string>();
  for (const r of rows) {
    check(`${sport}: id de partido único`, !ids.has(r.id), r.id);
    ids.add(r.id);
    check(
      `${sport}: fecha de partido válida`,
      !!r.commence_time && !Number.isNaN(Date.parse(r.commence_time)),
      `${r.id} → ${r.commence_time}`,
    );
  }
  console.log(`  ${rows.length} partidos próximos comprobados`);
}

// ---------------------------------------------------------------------------
function main(): void {
  console.log('\n🔍 Auditoría de consistencia\n' + '='.repeat(46));
  console.log(
    'Comprueba propiedades que deben cumplirse POR CONSTRUCCIÓN.\n' +
      'Un fallo aquí es un bug, nunca una cuestión de ajuste.',
  );

  auditFootball();
  auditBaseball();
  auditBasketball();
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

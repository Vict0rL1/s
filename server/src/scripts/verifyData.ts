// CLI: `npm run verify:data`
//
// ===========================================================================
// IS THE DATA ITSELF RIGHT?
// ===========================================================================
// There are already two checks in this repo and neither answers this question.
// `npm run audit` asks whether the app reports faithfully what the model said.
// `npm run backtest:*` asks whether the model is any good. Both can pass on a
// database that is quietly missing a third of a season, or that has every game
// duplicated, or whose Elo table no longer matches the games it was computed from.
//
// So this checks the DATA, against facts about the sports that do not depend on any
// model:
//
//   * A season has a KNOWN number of games. The NFL plays 272 in a modern regular
//     season; MLB 2,430; the NBA 1,230; a 20-team league 380. A season that comes up
//     short is a download that half-failed — the single most likely real defect, and
//     the one nothing else here would notice.
//   * The home side wins a KNOWN share of the time, and it is a narrow band per
//     sport. A figure outside it means home and away have been swapped somewhere.
//   * Scores live in a plausible range. Nobody scores 71 goals.
//   * No duplicates: one (date, home, away) is one game.
//   * Every game points at teams that exist.
//   * The stored ratings REPRODUCE from the stored games. If a replay of the archive
//     does not land on the numbers in the ratings table, one of the two is stale and
//     the app is showing an Elo that its own history does not support.
//
// Exit code is non-zero on failure, so it can gate a data refresh.

import { getDb } from '../db.ts';
import { recomputeBaseballRatings } from '../baseball/ratings.ts';

let checks = 0;
let failures = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A value inside a band, reported with the band so a failure is self-explaining. */
function band(name: string, value: number, lo: number, hi: number, unit = ''): void {
  check(name, value >= lo && value <= hi, `${value.toFixed(3)}${unit} fuera de [${lo}, ${hi}]`);
}

interface SportSpec {
  label: string;
  games: string;
  teams: string;
  date: string;
  homeScore: string;
  awayScore: string;
  /** The league whose season lengths are checked for a half-failed download. */
  seasonLeague?: string;
  /**
   * Plausible share of home wins AMONG DECIDED GAMES.
   *
   * Among decided, not among all: the draw rate is a separate fact about the sport
   * and mixing it in makes the four bands incomparable. The first version of this
   * check set football's band from the all-games figure (45 %) and then measured the
   * decided one (61 %), so it failed on perfectly good data — 45 % home, 26 % draw,
   * 29 % away is textbook league football.
   */
  homeWinBand: [number, number];
  /** Plausible per-team score in one game. */
  scoreBand: [number, number];
}

const SPORTS: SportSpec[] = [
  {
    label: 'Fútbol',
    games: 'fb_matches',
    teams: 'fb_teams',
    date: 'match_date',
    homeScore: 'home_goals',
    awayScore: 'away_goals',
    seasonLeague: 'epl',
    // 46 % home / 26 % draw / 28 % away long-run → 62 % of the decided games.
    homeWinBand: [0.55, 0.68],
    scoreBand: [0, 12],
  },
  {
    label: 'Baloncesto',
    games: 'bb_games',
    teams: 'bb_teams',
    date: 'game_date',
    homeScore: 'home_pts',
    awayScore: 'away_pts',
    seasonLeague: 'nba',
    // The NBA's home-court edge is the strongest of the four: ~58-62 % historically,
    // drifting down toward 55 % in the modern game. Draws are impossible, so decided
    // and total are the same thing here.
    homeWinBand: [0.52, 0.68],
    // The floor is 15, not 50. The 1947-1953 BAA and early NBA really did play
    // 33-50 games — this check flagged 52 of them as impossible before the floor
    // was set from the archive's own era rather than from the modern game.
    scoreBand: [15, 200],
  },
  {
    label: 'Béisbol',
    games: 'bsb_games',
    teams: 'bsb_teams',
    date: 'game_date',
    homeScore: 'home_runs',
    awayScore: 'away_runs',
    seasonLeague: 'mlb',
    // Baseball's home edge is the weakest in major sport: 53-54 %, and ties in the
    // final score do not happen, so decided ≈ total.
    homeWinBand: [0.5, 0.58],
    scoreBand: [0, 30],
  },
  {
    label: 'Fútbol americano',
    games: 'naf_games',
    teams: 'naf_teams',
    date: 'game_date',
    homeScore: 'home_points',
    awayScore: 'away_points',
    seasonLeague: 'nfl',
    homeWinBand: [0.5, 0.62],
    scoreBand: [0, 75],
  },
];

function auditSport(s: SportSpec): void {
  const db = getDb();
  console.log(`\n▸ ${s.label}`);
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM ${s.games}`).get() as unknown as { c: number }
  ).c;
  if (total === 0) {
    console.log('  sin partidos, saltado');
    return;
  }

  // --- 1. Duplicates. One (date, home, away) is one game. -------------------
  // Baseball is the exception and it is a real one: doubleheaders mean two games
  // between the same clubs on the same day, which is why bsb_games carries a
  // game_number and why it joins the key here.
  const key =
    s.games === 'bsb_games'
      ? `${s.date}, home_id, away_id, game_number`
      : `${s.date}, home_id, away_id`;
  const dupes = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT ${key} FROM ${s.games} GROUP BY ${key} HAVING COUNT(*) > 1
       )`,
    )
    .get() as unknown as { c: number };
  check(`${s.label}: sin partidos duplicados`, dupes.c === 0, `${dupes.c} claves repetidas`);

  // --- 2. Every game points at teams that exist. ---------------------------
  const orphans = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${s.games} g
        WHERE NOT EXISTS (SELECT 1 FROM ${s.teams} t WHERE t.league = g.league AND t.id = g.home_id)
           OR NOT EXISTS (SELECT 1 FROM ${s.teams} t WHERE t.league = g.league AND t.id = g.away_id)`,
    )
    .get() as unknown as { c: number };
  check(`${s.label}: ningún equipo huérfano`, orphans.c === 0, `${orphans.c} partidos`);

  // --- 3. Nobody plays themselves, and scores are possible. ----------------
  const self = db
    .prepare(`SELECT COUNT(*) AS c FROM ${s.games} WHERE home_id = away_id`)
    .get() as unknown as { c: number };
  check(`${s.label}: nadie juega contra sí mismo`, self.c === 0, `${self.c} partidos`);

  const [lo, hi] = s.scoreBand;
  const wild = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${s.games}
        WHERE ${s.homeScore} < ? OR ${s.homeScore} > ? OR ${s.awayScore} < ? OR ${s.awayScore} > ?`,
    )
    .get(lo, hi, lo, hi) as unknown as { c: number };
  check(
    `${s.label}: marcadores dentro de lo posible (${lo}–${hi})`,
    wild.c === 0,
    `${wild.c} partidos fuera de rango`,
  );

  const nulls = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${s.games} WHERE ${s.homeScore} IS NULL OR ${s.awayScore} IS NULL`,
    )
    .get() as unknown as { c: number };
  check(`${s.label}: ningún marcador vacío`, nulls.c === 0, `${nulls.c} partidos`);

  // --- 4. The home-win rate, which catches a home/away swap. ---------------
  const hw = db
    .prepare(
      `SELECT
         SUM(CASE WHEN ${s.homeScore} > ${s.awayScore} THEN 1 ELSE 0 END) AS w,
         SUM(CASE WHEN ${s.homeScore} <> ${s.awayScore} THEN 1 ELSE 0 END) AS decided
       FROM ${s.games}`,
    )
    .get() as unknown as { w: number; decided: number };
  const rate = hw.decided > 0 ? hw.w / hw.decided : 0;
  band(
    `${s.label}: el local gana una fracción creíble`,
    rate,
    s.homeWinBand[0],
    s.homeWinBand[1],
  );
  console.log(
    `  ${total.toLocaleString('es')} partidos · el local gana el ${(rate * 100).toFixed(1)} % de los decididos`,
  );

  // --- 5. Season completeness — the check nothing else would make. ---------
  if (s.seasonLeague) auditSeasons(s.label, s.games, s.seasonLeague);
}

/**
 * Seasons that are genuinely short, and why.
 *
 * A hardcoded "a season has N games" cannot work across an archive that spans 1947
 * to today: the NBA grew from 350 games a year to 1,230, football leagues changed
 * size, and the modern NFL plays 17 games where it used to play 16. The first
 * version of this check flagged 54 NBA seasons as broken — every one of them real
 * history.
 *
 * So the metric is GAMES PER TEAM, compared against the median of its neighbours.
 * Per team is the part that matters: the 1947-48 BAA played 215 games where its
 * neighbours played 380, which reads as a broken download until you notice it had
 * EIGHT clubs instead of twelve — 54 games each, perfectly normal. League size
 * changes the total and not the schedule; a half-failed download changes both.
 *
 * These are the exceptions where a real season genuinely was short. Naming them is
 * the honest alternative to widening the tolerance until it catches nothing.
 */
const SHORT_SEASONS: Record<string, string> = {
  'mlb|1994': 'huelga de jugadores, temporada cancelada en agosto',
  'mlb|1995': 'la huelga recortó el calendario a 144 partidos',
  'mlb|2020': 'COVID: 60 partidos por equipo en vez de 162',
  'nba|1999': 'cierre patronal: 50 partidos por equipo',
  'nba|2012': 'cierre patronal: 66 partidos por equipo',
  'nba|2020': 'COVID: temporada suspendida y reanudada en una burbuja',
  'nba|2021': 'COVID: 72 partidos por equipo',
};

/** How far below its neighbours a season may fall before it looks half-downloaded. */
const SEASON_FLOOR = 0.7;

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function auditSeasons(label: string, table: string, league: string): void {
  const rows = (
    getDb()
      .prepare(
        `SELECT season, COUNT(*) AS games, COUNT(DISTINCT home_id) AS teams
           FROM ${table} WHERE league = ? GROUP BY season ORDER BY season`,
      )
      .all(league) as unknown as { season: number; games: number; teams: number }[]
  ).map((r) => ({ ...r, perTeam: r.teams > 0 ? (r.games * 2) / r.teams : 0 }));
  if (rows.length < 4) {
    console.log(`  ${league}: solo ${rows.length} temporadas, sin vecinas con las que comparar`);
    return;
  }

  const suspicious: string[] = [];
  const excused: string[] = [];
  // The newest season is skipped: it is either in progress or published late, so
  // being short is expected rather than suspicious.
  for (let i = 0; i < rows.length - 1; i++) {
    const neighbours = rows
      .slice(Math.max(0, i - 2), i + 3)
      .filter((_, k) => Math.max(0, i - 2) + k !== i)
      .map((r) => r.perTeam);
    if (neighbours.length < 2) continue;
    const expected = median(neighbours);
    if (rows[i].perTeam >= expected * SEASON_FLOOR) continue;
    const key = `${league}|${rows[i].season}`;
    const note = SHORT_SEASONS[key];
    if (note) excused.push(`${rows[i].season} (${note})`);
    else
      suspicious.push(
        `${rows[i].season}: ${rows[i].perTeam.toFixed(0)} partidos por equipo` +
          ` frente a ~${expected.toFixed(0)} de sus vecinas`,
      );
  }
  check(
    `${label}: ninguna temporada de ${league} parece descargada a medias`,
    suspicious.length === 0,
    suspicious.join(' · '),
  );
  const last = rows[rows.length - 1];
  console.log(
    `  ${league}: ${rows.length} temporadas, ${rows[0].season}–${last.season}` +
      ` · la última con ${last.games} partidos (${last.perTeam.toFixed(0)} por equipo)` +
      (excused.length ? `\n  cortas por motivos conocidos: ${excused.join(', ')}` : ''),
  );
}

/**
 * Do the stored ratings still follow from the stored games?
 *
 * Baseball only, because it is the one sport whose recompute is cheap enough to run
 * twice inside a check and whose replay is fully deterministic. If a replay of the
 * archive does not reproduce the ratings table, one of the two is stale — and the
 * app would be showing an Elo its own history does not support.
 */
function auditRatingsReproduce(): void {
  console.log('\n▸ ¿Los ratings salen de los partidos?');
  const db = getDb();
  const before = db
    .prepare('SELECT team_id, elo FROM bsb_team_ratings WHERE league = ? ORDER BY team_id')
    .all('mlb') as unknown as { team_id: string; elo: number }[];
  if (before.length === 0) {
    console.log('  sin ratings de béisbol, saltado');
    return;
  }
  recomputeBaseballRatings();
  const after = db
    .prepare('SELECT team_id, elo FROM bsb_team_ratings WHERE league = ? ORDER BY team_id')
    .all('mlb') as unknown as { team_id: string; elo: number }[];

  check('béisbol: el recálculo no cambia el número de equipos', before.length === after.length,
    `${before.length} → ${after.length}`);
  let worst = 0;
  let worstTeam = '';
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const d = Math.abs(before[i].elo - after[i].elo);
    if (d > worst) {
      worst = d;
      worstTeam = before[i].team_id;
    }
  }
  // 0.1 is the rounding the table stores at, so anything under it is the same number.
  check(
    'béisbol: los Elo guardados se reproducen desde los partidos',
    worst <= 0.1,
    `mayor diferencia ${worst.toFixed(2)} Elo en ${worstTeam}`,
  );
  console.log(`  ${after.length} equipos · mayor diferencia al recalcular: ${worst.toFixed(2)} Elo`);
}

function main(): void {
  console.log('\n🔎 Verificación de los datos\n' + '='.repeat(46));
  console.log(
    'Comprueba los DATOS contra hechos de cada deporte que no dependen de\n' +
      'ningún modelo: cuántos partidos tiene una temporada, cuánto gana el local,\n' +
      'qué marcadores son posibles.',
  );
  for (const s of SPORTS) auditSport(s);
  auditRatingsReproduce();

  console.log('\n' + '='.repeat(46));
  if (failures === 0) {
    console.log(`✅ ${checks} comprobaciones, todas correctas.`);
    return;
  }
  console.log(`❌ ${failures} de ${checks} comprobaciones fallan:\n`);
  for (const p of problems) console.log(`  × ${p}`);
  process.exitCode = 1;
}

main();

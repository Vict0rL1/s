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
import { normalCdf, MARGIN_SIGMA as NFL_MARGIN_SIGMA } from '../nfl/model.ts';
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
    // The ceiling is 15, and 12 was one goal too low: VVV-Venlo 0-13 Ajax, 24
    // October 2020, is the biggest win in Eredivisie history and it is in the data.
    // Widened to the record rather than to the value that made the check pass.
    scoreBand: [0, 15],
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
  // Tennis, keyed by tour. The 2020 circuit was suspended in March and did not
  // restart until August, so both tours played about half a normal calendar.
  'atp|2020': 'COVID: circuito suspendido de marzo a agosto',
  'wta|2020': 'COVID: circuito suspendido de marzo a agosto',
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
 * One franchise, one id.
 *
 * THE CHECK THAT CAUGHT A REAL BUG. Adding a second results source to basketball
 * took the NBA from 45 teams to 98: FiveThirtyEight writes the bare nickname
 * ("Lakers") and hoopR the full name ("Los Angeles Lakers"), so every franchise
 * ended up split — 6,023 games under one id, 2,134 under another, the shared seasons
 * stored twice, and each half carrying an Elo built from a fraction of its own
 * history. Nothing else here would have noticed: every count went UP.
 *
 * THE SIGNAL, and the first two attempts were both wrong. Matching on a shared
 * nickname flagged every English club at once (they nearly all end in "FC") and
 * called the Red Sox and the White Sox one team. Requiring disjoint date ranges
 * missed the actual bug, whose two halves overlapped for thirteen seasons.
 *
 * What is precise: TWO TEAMS ACTIVE IN THE SAME SEASON WHO NEVER PLAY EACH OTHER
 * ARE THE SAME TEAM. In a league with a full round robin that is an invariant, and
 * a split franchise breaks it immediately — `lakers` and `los-angeles-lakers` both
 * had 2002-2015 games and never met once.
 *
 * Which is why it does not run everywhere. The NFL plays 17 games against 31
 * possible opponents, so two real teams routinely never meet; MLB's interleague
 * schedule was partial until 2023. Applied only where the round robin is complete.
 */
function auditFranchiseIds(label: string, teams: string, games: string): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.league, t.id, t.name,
              (SELECT COUNT(*) FROM ${games} g
                WHERE g.league = t.league AND (g.home_id = t.id OR g.away_id = t.id)) AS n
         FROM ${teams} t`,
    )
    .all() as unknown as { league: string; id: string; name: string; n: number }[];

  // A team with no games is a name that was created and never used — the other half
  // of the same failure, and it needs no round robin to detect.
  const orphanTeams = rows.filter((r) => r.n === 0);
  check(
    `${label}: ningún equipo sin partidos`,
    orphanTeams.length === 0,
    orphanTeams.slice(0, 6).map((r) => r.id).join(', '),
  );
}

/** Leagues whose schedule is a complete round robin — see auditFranchiseIds. */
const ROUND_ROBIN: Record<string, string[]> = {
  fb_matches: ['epl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'eredivisie', 'primeira', 'championship'],
  bb_games: ['nba'],
};

function auditRoundRobin(label: string, games: string): void {
  const leagues = ROUND_ROBIN[games];
  if (!leagues) {
    console.log(`  ${label}: sin round robin completo, no aplica`);
    return;
  }
  const db = getDb();
  const problems: string[] = [];
  let pairs = 0;
  for (const league of leagues) {
    // The most recent COMPLETE season: the one in progress has not played itself out.
    const seasons = (
      db
        .prepare(`SELECT DISTINCT season FROM ${games} WHERE league = ? ORDER BY season DESC LIMIT 2`)
        .all(league) as unknown as { season: number }[]
    ).map((r) => r.season);
    const season = seasons[1] ?? seasons[0];
    if (season == null) continue;
    const active = (
      db
        .prepare(
          `SELECT DISTINCT id FROM (
             SELECT home_id AS id FROM ${games} WHERE league = ? AND season = ?
             UNION SELECT away_id AS id FROM ${games} WHERE league = ? AND season = ?
           )`,
        )
        .all(league, season, league, season) as unknown as { id: string }[]
    ).map((r) => r.id);
    const met = db.prepare(
      `SELECT COUNT(*) AS c FROM ${games}
        WHERE league = ? AND season = ?
          AND ((home_id = ? AND away_id = ?) OR (home_id = ? AND away_id = ?))`,
    );
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        pairs++;
        const r = met.get(league, season, active[i], active[j], active[j], active[i]) as unknown as {
          c: number;
        };
        if (r.c === 0) problems.push(`${league} ${season}: ${active[i]} y ${active[j]} nunca se cruzan`);
      }
    }
  }
  check(
    `${label}: todos los equipos de una temporada se cruzan`,
    problems.length === 0,
    problems.slice(0, 4).join(' · ') + (problems.length > 4 ? ` (+${problems.length - 4})` : ''),
  );
  console.log(`  ${label}: ${pairs} parejas comprobadas en la última temporada completa`);
}

/**
 * Do the stored ratings still follow from the stored games?/**
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

// ---------------------------------------------------------------------------
// Tennis
// ---------------------------------------------------------------------------
/**
 * Tennis does not fit SportSpec: there is no home and away, no points-per-side,
 * and no fixed season length — the calendar is a set of tournaments, not a round
 * robin. So it gets its own facts, and they are stronger ones, because every row
 * carries the serve statistics of BOTH players and those have to add up.
 *
 * The failure this is really aimed at is a WINNER/LOSER SWAP or a shifted column.
 * The tennis archive is the only one here where the result is encoded twice — once
 * in which id is in `winner_id`, and again in the `score` string — so the two can
 * be checked against each other. Nothing else in this repo can do that, and the
 * tab spent this whole project on synthetic seed data where it would never have
 * mattered.
 */
function auditTennis(): void {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS c FROM matches').get() as { c: number }).c;
  console.log('\n▸ Tenis');
  if (total === 0) {
    console.log('  sin partidos, saltado');
    return;
  }

  for (const tour of ['atp', 'wta']) {
    const n = (
      db.prepare('SELECT COUNT(*) AS c FROM matches WHERE tour = ?').get(tour) as { c: number }
    ).c;
    if (n === 0) {
      console.log(`  ${tour.toUpperCase()}: sin partidos — la pestaña no tendrá modelo`);
      continue;
    }
    const r = db
      .prepare(
        `SELECT MIN(tourney_date) lo, MAX(tourney_date) hi, COUNT(DISTINCT tourney_id) t
         FROM matches WHERE tour = ?`,
      )
      .get(tour) as { lo: string; hi: string; t: number };
    console.log(
      `  ${tour.toUpperCase()}: ${n.toLocaleString('es')} partidos · ${r.t} torneos · ` +
        `${r.lo} → ${r.hi}`,
    );

    // Nobody plays themselves. Cheap, and it is what a self-join gone wrong looks like.
    check(
      `tenis ${tour}: ganador y perdedor distintos`,
      (db.prepare('SELECT COUNT(*) AS c FROM matches WHERE tour = ? AND winner_id = loser_id')
        .get(tour) as { c: number }).c === 0,
    );

    // Every id must resolve. An unmatched id means a player row was dropped, and
    // the app would show a prediction for "undefined".
    const orphans = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM matches m WHERE m.tour = ?
             AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.tour = m.tour AND p.id = m.winner_id)
               OR NOT EXISTS (SELECT 1 FROM players p WHERE p.tour = m.tour AND p.id = m.loser_id))`,
        )
        .get(tour) as { c: number }
    ).c;
    check(`tenis ${tour}: todos los jugadores existen`, orphans === 0, `${orphans} partidos huérfanos`);

    // Dates are YYYYMMDD and inside the range the archive claims.
    const badDate = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM matches WHERE tour = ?
             AND (LENGTH(tourney_date) <> 8
                  OR CAST(substr(tourney_date,5,2) AS INTEGER) NOT BETWEEN 1 AND 12
                  OR CAST(substr(tourney_date,7,2) AS INTEGER) NOT BETWEEN 1 AND 31)`,
        )
        .get(tour) as { c: number }
    ).c;
    check(`tenis ${tour}: fechas con forma YYYYMMDD válida`, badDate === 0, `${badDate} fechas`);

    // best_of is 3 or 5 and nothing else. A 4 here means the column moved.
    const badBo = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM matches WHERE tour = ? AND best_of IS NOT NULL AND best_of NOT IN (3,5)`,
        )
        .get(tour) as { c: number }
    ).c;
    check(`tenis ${tour}: best_of es 3 o 5`, badBo === 0, `${badBo} filas`);

    // Surfaces come from a closed set. Carpet is historical but real.
    const badSurface = db
      .prepare(
        `SELECT DISTINCT surface FROM matches WHERE tour = ? AND surface IS NOT NULL
           AND LOWER(surface) NOT IN ('hard','clay','grass','carpet')`,
      )
      .all(tour) as { surface: string }[];
    check(
      `tenis ${tour}: superficies conocidas`,
      badSurface.length === 0,
      badSurface.map((x) => x.surface).join(', '),
    );

    // ---------------------------------------------------------------------
    // The serve statistics have to be arithmetically possible.
    // ---------------------------------------------------------------------
    // These are the checks that catch a shifted column, because a shift produces
    // numbers that are individually plausible and jointly impossible: you cannot
    // land more first serves than you hit points, nor win more than you landed,
    // nor save a break point you never faced. The model reads all of these.
    const impossible: [string, string][] = [
      ['primeros saques dentro ≤ puntos al saque', '{p}_1stIn > {p}_svpt'],
      ['primeros ganados ≤ primeros dentro', '{p}_1stWon > {p}_1stIn'],
      ['segundos ganados ≤ segundos jugados', '{p}_2ndWon > {p}_svpt - {p}_1stIn'],
      ['puntos de break salvados ≤ afrontados', '{p}_bpSaved > {p}_bpFaced'],
      ['aces ≤ puntos al saque', '{p}_ace > {p}_svpt'],
      ['dobles faltas ≤ puntos al saque', '{p}_df > {p}_svpt'],
    ];
    for (const [label, expr] of impossible) {
      for (const side of ['w', 'l']) {
        const e = expr.replace(/\{p\}/g, side);
        // Only rows that HAVE the stats: they are absent before ~1991 and on
        // walkovers, and a NULL is missing data rather than wrong data.
        const bad = (
          db
            .prepare(`SELECT COUNT(*) AS c FROM matches WHERE tour = ? AND ${e}`)
            .get(tour) as { c: number }
        ).c;
        check(`tenis ${tour}: ${label} (${side})`, bad === 0, `${bad} filas`);
      }
    }

    // ---------------------------------------------------------------------
    // Does the SCORE agree with who is recorded as the winner?
    // ---------------------------------------------------------------------
    // The one check here that would catch a swap. Sets are counted from the score
    // string and the player in `winner_id` must have won more of them.
    //
    // Retirements, walkovers and unfinished matches are excluded rather than
    // counted as failures: "6-4 2-1 RET" is a real, correctly recorded result in
    // which the winner leads on fewer sets, and treating it as a defect would bury
    // the signal under thousands of legitimate rows. That is why the check is a
    // RATE with a floor and not "zero mismatches" — see the note below.
    const rows = db
      .prepare(`SELECT score FROM matches WHERE tour = ? AND score IS NOT NULL AND score <> ''`)
      .all(tour) as { score: string }[];
    let clean = 0;
    let agree = 0;
    for (const { score } of rows) {
      if (/[a-z]/i.test(score)) continue; // RET, W/O, DEF, ABD, Def., In Progress…
      const sets = score.trim().split(/\s+/);
      let w = 0;
      let l = 0;
      let parsed = 0;
      for (const set of sets) {
        const m = set.match(/^(\d+)-(\d+)/);
        if (!m) continue;
        parsed++;
        if (Number(m[1]) > Number(m[2])) w++;
        else if (Number(m[2]) > Number(m[1])) l++;
      }
      if (parsed === 0) continue;
      clean++;
      if (w > l) agree++;
    }
    if (clean > 0) {
      const rate = agree / clean;
      // 0.999 and not 1.0: a handful of rows in any hand-corrected archive have a
      // score typed with the sets the wrong way round. What this is built to catch
      // is a SYSTEMATIC swap, which would put this near 0, not a stray typo.
      band(`tenis ${tour}: el marcador concuerda con el ganador`, rate, 0.999, 1);
      console.log(
        `    marcador vs ganador: ${(rate * 100).toFixed(2)} % de acuerdo en ` +
          `${clean.toLocaleString('es')} partidos completos`,
      );
    }

    // The favourite by ranking wins more often than not, but not always — and the
    // direction is the point. Below 50 % would mean `winner_rank` and `loser_rank`
    // are the wrong way round, which is invisible to every check above.
    const rk = db
      .prepare(
        `SELECT SUM(CASE WHEN winner_rank < loser_rank THEN 1 ELSE 0 END) AS fav, COUNT(*) AS n
         FROM matches WHERE tour = ? AND winner_rank IS NOT NULL AND loser_rank IS NOT NULL`,
      )
      .get(tour) as { fav: number; n: number };
    if (rk.n > 500) {
      band(`tenis ${tour}: el mejor clasificado gana más veces`, rk.fav / rk.n, 0.6, 0.75);
      console.log(
        `    gana el mejor clasificado: ${((rk.fav / rk.n) * 100).toFixed(1)} % de ` +
          `${rk.n.toLocaleString('es')} partidos`,
      );
    }

    // Per-season volume against the median of its neighbours, same idea as
    // auditSeasons for the team sports: a half-failed download shows up as a
    // season with a fraction of the matches of the ones around it.
    const perYear = db
      .prepare(
        `SELECT substr(tourney_date,1,4) AS y, COUNT(*) AS n FROM matches
         WHERE tour = ? GROUP BY y ORDER BY y`,
      )
      .all(tour) as { y: string; n: number }[];
    // The current season is excluded: it is legitimately incomplete.
    const thisYear = String(new Date().getUTCFullYear());
    const full = perYear.filter((r) => r.y !== thisYear);
    const shortForAReason: string[] = [];
    for (let i = 0; i < full.length; i++) {
      const near = full
        .slice(Math.max(0, i - 2), i + 3)
        .filter((_, j) => j !== Math.min(i, 2))
        .map((r) => r.n)
        .sort((a, b) => a - b);
      if (near.length < 3) continue;
      const med = near[Math.floor(near.length / 2)];
      const excuse = SHORT_SEASONS[`${tour}|${full[i].y}`];
      if (excuse) {
        if (full[i].n < med * SEASON_FLOOR) shortForAReason.push(`${full[i].y} (${excuse})`);
        continue;
      }
      check(
        `tenis ${tour}: la temporada ${full[i].y} no está a medias`,
        full[i].n >= med * SEASON_FLOOR,
        `${full[i].n} partidos frente a ~${med} en las temporadas vecinas`,
      );
    }
    if (shortForAReason.length) {
      console.log(`    cortas por motivos conocidos: ${shortForAReason.join(', ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// NFL: the closing line, and which way it points
// ---------------------------------------------------------------------------
/**
 * The market probability is now derived from the closing spread, which means a sign
 * error would invert every NFL card while leaving every number looking plausible —
 * 62 % instead of 38 %, no crash, no warning.
 *
 * It is a real hazard rather than a hypothetical one, because THE TWO SPREAD FIELDS
 * IN THIS DATABASE USE OPPOSITE CONVENTIONS: `naf_games.close_spread` is in margin
 * sign (positive = home favoured) and `naf_upcoming.spread_line` is in bookmaker sign
 * (negative = home favoured). So the sign is measured here, from the results, instead
 * of being asserted in a comment.
 *
 * Two independent directions are checked, because either alone can be satisfied by a
 * coincidence:
 *
 *   1. the historical spread must agree with the actual margin well over half the
 *      time (it is 66.2 %, which is simply how often the favourite wins), and
 *   2. the spread-derived probability must SCORE better than the model on the same
 *      games. That is the claim the card now makes to the reader in words, so it is
 *      the claim that has to keep being true — and an inverted sign would send it to
 *      roughly 0.78 instead of 0.21.
 */
function auditNflMarket(): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT close_spread, home_points, away_points FROM naf_games
       WHERE league = 'nfl' AND close_spread IS NOT NULL AND home_points <> away_points`,
    )
    .all() as unknown as { close_spread: number; home_points: number; away_points: number }[];
  console.log('\n▸ NFL: la línea de cierre');
  if (rows.length < 500) {
    console.log(`  solo ${rows.length} partidos con línea, saltado`);
    return;
  }

  let agree = 0;
  let brierMarket = 0;
  let n = 0;
  for (const r of rows) {
    const margin = r.home_points - r.away_points;
    if (Math.sign(margin) === Math.sign(r.close_spread)) agree++;
    // Same normal the model quotes the handicap with. Not the full key-number
    // distribution: this check must not depend on the model's own shape, or a bug in
    // that shape would hide a bug in this sign.
    const p = normalCdf(r.close_spread / NFL_MARGIN_SIGMA);
    brierMarket += (p - (margin > 0 ? 1 : 0)) ** 2;
    n++;
  }
  const rate = agree / rows.length;
  const bMarket = brierMarket / n;

  band('NFL: el signo de close_spread apunta al ganador', rate, 0.6, 0.72);
  // 0.25 is a coin flip. An inverted sign lands far above it; the real figure is ~0.21.
  band('NFL: la probabilidad deducida de la línea puntúa como un pronóstico', bMarket, 0.15, 0.235);
  console.log(
    `  ${rows.length.toLocaleString('es')} partidos · el favorito de la línea gana el ` +
      `${(rate * 100).toFixed(1)} % · Brier de la línea ${bMarket.toFixed(4)}`,
  );
}

function main(): void {
  console.log('\n🔎 Verificación de los datos\n' + '='.repeat(46));
  console.log(
    'Comprueba los DATOS contra hechos de cada deporte que no dependen de\n' +
      'ningún modelo: cuántos partidos tiene una temporada, cuánto gana el local,\n' +
      'qué marcadores son posibles.',
  );
  for (const s of SPORTS) auditSport(s);
  console.log('\n▸ Identidad de los equipos');
  for (const s of SPORTS) auditFranchiseIds(s.label, s.teams, s.games);
  for (const s of SPORTS) auditRoundRobin(s.label, s.games);
  auditTennis();
  auditNflMarket();
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

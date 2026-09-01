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
import { normalizeTeamName } from '../football/ingest/teamNames.ts';
import { parseFootballTxt } from '../football/ingest/openfootballTxt.ts';
import { readRegistry } from '../experiments/registry.ts';
import { FINAL_HOLDOUT_FROM } from '../experiments/holdout.ts';
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
  //
  // EXCEPT a club just promoted, whose rating was transplanted from the division
  // below so its fixtures get a model before it has played here (promotion.ts).
  // Having no matches yet is the entire point of that row, and the marker is what
  // separates it from a genuine orphan: a name that was created and forgotten has
  // no `seeded_from`.
  const seededIds =
    teams === 'fb_teams'
      ? new Set(
          (
            getDb()
              .prepare(
                "SELECT league || '|' || team_id AS k FROM fb_team_ratings WHERE seeded_from IS NOT NULL",
              )
              .all() as unknown as { k: string }[]
          ).map((r) => r.k),
        )
      : new Set<string>();
  const orphanTeams = rows.filter((r) => r.n === 0 && !seededIds.has(`${r.league}|${r.id}`));
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
        // El corchete es del SÚPER TIE-BREAK: un tercer set a diez puntos se escribe
        // "[10-7]". Sin aceptarlo, el set que DECIDE el partido no se contaba, el
        // marcador quedaba 1-1 y la comprobación denunciaba un desacuerdo que no
        // existía — 38 partidos, todos ellos decididos así, todos correctos.
        // Aceptándolo quedan 13 desacuerdos en 30.852: erratas sueltas del archivo,
        // que es exactamente lo que el margen de abajo está puesto para tolerar.
        const m = set.match(/^\[?(\d+)-(\d+)/);
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

/**
 * Football: is any single SCORE going missing?
 *
 * A count that goes up looks like success. This is the check that would have caught
 * the openfootball parser dropping 178 matches of the 2025-26 season, every one of
 * them 0-0, because the file writes goalless draws as a bare `score: [0,0]` instead
 * of `score: { ft: [0,0] }`. The goalless-draw rate fell to 0.07 % — one match in
 * 1,438 — and nothing else in this repo noticed, because the totals still rose.
 *
 * The rate is checked PER SEASON, not overall: a whole-archive figure stays inside
 * any sane band while the newest season, which is the one the app predicts from,
 * is completely broken.
 *
 * 4-10 % is wide on purpose. The measured rate across the healthy seasons is
 * 5.9-7.1 %, low-scoring leagues sit at the top of that and Eredivisie at the
 * bottom; the band has to admit a genuinely defensive season without admitting a
 * parser that lost the result altogether.
 */
function auditGoallessDraws(): void {
  const rows = getDb()
    .prepare(
      `SELECT substr(match_date, 1, 4) AS y, COUNT(*) AS n,
              SUM(CASE WHEN home_goals = 0 AND away_goals = 0 THEN 1 ELSE 0 END) AS zeros
         FROM fb_matches GROUP BY y HAVING n >= 400 ORDER BY y`,
    )
    .all() as unknown as { y: string; n: number; zeros: number }[];
  console.log('\n▸ Fútbol: ¿se pierde algún resultado?');
  if (rows.length === 0) {
    console.log('  sin temporadas con muestra suficiente, saltado');
    return;
  }
  for (const r of rows) {
    band(`fútbol: proporción de 0-0 en ${r.y}`, r.zeros / r.n, 0.04, 0.1);
  }
  const worst = rows.reduce((a, b) => (a.zeros / a.n < b.zeros / b.n ? a : b));
  console.log(
    `  ${rows.length} temporadas · 0-0 entre ` +
      `${((Math.min(...rows.map((r) => r.zeros / r.n))) * 100).toFixed(2)} % (${worst.y}) y ` +
      `${((Math.max(...rows.map((r) => r.zeros / r.n))) * 100).toFixed(2)} %`,
  );
}

/**
 * Two team ids that look like the same club.
 *
 * The round-robin check next to this one catches a franchise split when both halves
 * are ACTIVE AT ONCE — two teams in the same season that never meet. It cannot catch
 * the other shape, and the other shape is what football had: openfootball wrote
 * 2019-20 with short names ("Manchester City") and every later season with the legal
 * form ("Manchester City FC"), so each club's halves sat in DISJOINT seasons and
 * never had the chance to not-meet. The Premier League held 40 team ids for ~29 real
 * clubs, and `manchester-city` kept 38 matches ending 2020-06-25 while
 * `manchester-city-fc` kept the other 228.
 *
 * What that costs is not cosmetic: every club that played the first season had that
 * season orphaned, so its Elo was built from six years instead of seven, and the
 * reliability chip on every card of the tab read "fiabilidad baja ±15 pp" — correctly,
 * about a team id that genuinely had 38 matches.
 *
 * The test is name-based and deliberately narrow: two ids in the same league whose
 * names are equal once the legal-form tokens are stripped. `slugify` already does
 * that stripping, so this asks whether slugify would map two DIFFERENT stored ids
 * onto the same one — which, after the fix, can only happen if an id was written by
 * an older build or a source this normalisation does not cover.
 */
// ===========================================================================
// EL REGISTRO DE EXPERIMENTOS SIGUE SIENDO VERDAD
// ===========================================================================
// Un registro que nadie comprueba se convierte en decoración: basta con que un script
// deje de llamar a recordExperiment para que el contador se quede corto, y un contador
// corto hace que Bonferroni sea más permisivo de lo que debe — o sea, exactamente el
// error que el registro existía para evitar, pero ahora con aspecto de rigor.
//
// Así que se comprueba lo que puede romperse en silencio: que las entradas están
// completas, que ningún experimento dice haberse medido sobre el holdout mientras el
// candado consta cerrado, y que las hipótesis no se repiten (dos entradas idénticas
// suelen ser un script corrido dos veces, y eso infla el denominador tanto como
// olvidarse infla al revés).
function auditExperimentRegistry(): void {
  console.log('\n▸ Registro de experimentos');
  const { experiments, unlocks } = readRegistry();
  if (experiments.length === 0) {
    console.log('  registro vacío, saltado');
    return;
  }
  console.log(`  ${experiments.length} experimentos · candado del holdout abierto ${unlocks.length} vez/veces`);

  let incompletos = 0;
  let pMalos = 0;
  let ciMalos = 0;
  for (const e of experiments) {
    if (!e.hypothesis || !e.baseline || !e.dataset?.sport || !e.metric) incompletos++;
    if (!(e.result.p >= 0 && e.result.p <= 1)) pMalos++;
    // El intervalo tiene que contener a su propia estimación. Suena obvio y no lo es:
    // un generador aleatorio roto produjo exactamente ese síntoma en este proyecto —
    // IC [87, 97] alrededor de un punto de 82— y pasó desapercibido hasta que alguien
    // se paró a mirarlo.
    if (e.result.delta < e.result.ciLo || e.result.delta > e.result.ciHi) ciMalos++;
  }
  check('experimentos: todos con hipótesis, baseline, deporte y métrica', incompletos === 0, `${incompletos} incompletos`);
  check('experimentos: todos los p entre 0 y 1', pMalos === 0, `${pMalos} fuera de rango`);
  check('experimentos: el intervalo contiene su estimación', ciMalos === 0, `${ciMalos} incoherentes`);

  const sobreHoldout = experiments.filter((e) => e.dataset.split === 'holdout');
  check(
    'experimentos: nadie ha medido sobre el holdout sin abrir el candado',
    sobreHoldout.length === 0 || unlocks.length > 0,
    `${sobreHoldout.length} entradas sobre el holdout y ninguna apertura registrada`,
  );

  const vistas = new Map<string, number>();
  for (const e of experiments) vistas.set(e.hypothesis, (vistas.get(e.hypothesis) ?? 0) + 1);
  const repes = [...vistas].filter(([, n]) => n > 1);
  check(
    'experimentos: sin hipótesis duplicadas',
    repes.length === 0,
    repes.map(([h, n]) => `${h} ×${n}`).join('; '),
  );
  console.log(
    `  holdout final: fútbol desde ${FINAL_HOLDOUT_FROM.football}, NFL desde ${FINAL_HOLDOUT_FROM.nfl}` +
      (unlocks.length === 0 ? ' · intacto' : ' · ⚠ YA ABIERTO'),
  );
}

/**
 * Huecos que la FUENTE no tiene, con el motivo, no huecos que toleramos.
 *
 * Una lista de excepciones es una alfombra debajo de la cual barrer cosas, así que
 * esta tiene dos defensas. La primera es que se imprime entera en cada ejecución, con
 * el motivo al lado. La segunda es que CADUCA SOLA: si una temporada exenta aparece
 * algún día en la base —porque la fuente la publicó, o porque encontramos otra—, la
 * comprobación falla pidiendo que se borre la excepción. Una lista así no puede
 * pudrirse en silencio, que es la única forma en que estas listas hacen daño.
 */
const KNOWN_SEASON_GAPS: Record<string, { seasons: number[]; why: string }> = {
  ligamx: {
    seasons: [2022, 2023, 2024],
    why: 'el mirror JSON no las publica y el repo de texto de México va por submódulos, que raw.githubusercontent no sirve',
  },
  ligue2: {
    seasons: [2022, 2023, 2024],
    why: 'igual que Liga MX: sin fr.2 en el mirror JSON esas temporadas y sin repo de texto alcanzable',
  },
};

// ===========================================================================
// ¿LE FALTA UNA TEMPORADA ENTERA A ALGUNA LIGA?
// ===========================================================================
// Este es el fallo que no se ve. Una fuente que se cae deja la liga vacía y salta a
// la vista; una fuente con HUECOS deja la liga llena, con miles de partidos, y sin
// tres temporadas de en medio. Nada falla, los recuentos suben, y el defecto solo
// aparece si alguien va a mirar.
//
// Pasó, y era caro: el mirror JSON de openfootball no tiene 2021-22, 2022-23 ni
// 2023-24 de es.2 e it.2 —el repo de texto sí—, así que LaLiga Hypermotion tenía
// 1.508 partidos en vez de 2.894 y Serie B 1.474 en vez de 2.641. Y no costaba solo
// precisión abajo: el salto de división se mide emparejando la temporada S de un club
// en Segunda con la S+1 en Primera, así que cada hueco abajo borra las promociones de
// ese año. España se medía con 9 clubes en vez de 14, Italia con 9 en vez de 17 y una
// desviación de 50 Elo en vez de 33.
//
// La propiedad es sencilla y no depende de ninguna fuente: entre la temporada más
// antigua y la más nueva de una liga NO PUEDE FALTAR NINGUNA. Una liga puede empezar
// tarde o acabar pronto en el archivo; lo que no puede es tener un agujero en medio.
function auditSeasonGaps(): void {
  const rows = getDb()
    .prepare(
      `SELECT league, season, COUNT(*) AS n FROM fb_matches
       GROUP BY league, season ORDER BY league, season`,
    )
    .all() as unknown as { league: string; season: number; n: number }[];
  console.log('\n▸ Fútbol: ¿alguna liga con temporadas salteadas?');
  if (rows.length === 0) {
    console.log('  sin partidos, saltado');
    return;
  }
  const byLeague = new Map<string, number[]>();
  for (const r of rows) byLeague.set(r.league, [...(byLeague.get(r.league) ?? []), r.season]);

  for (const [league, seasons] of [...byLeague].sort()) {
    const first = seasons[0];
    const last = seasons[seasons.length - 1];
    // Una liga de una sola temporada no puede tener huecos: no es un aprobado que
    // signifique nada, así que no se cuenta como comprobación.
    if (first === last) continue;
    const have = new Set(seasons);
    const missing: number[] = [];
    for (let y = first; y <= last; y++) if (!have.has(y)) missing.push(y);

    const known = KNOWN_SEASON_GAPS[league];
    const exempt = new Set(known?.seasons ?? []);
    const unexplained = missing.filter((y) => !exempt.has(y));
    check(
      `${league}: sin huecos entre ${first} y ${last}`,
      unexplained.length === 0,
      `faltan ${unexplained.join(', ')}`,
    );
    // La otra mitad: una excepción que ya no hace falta es una mentira sobre la
    // fuente, y se caza pidiendo que se borre.
    if (known) {
      const recovered = known.seasons.filter((y) => y >= first && y <= last && have.has(y));
      check(
        `${league}: la excepción documentada sigue haciendo falta`,
        recovered.length === 0,
        `${recovered.join(', ')} ya están en la base — quita esas temporadas de KNOWN_SEASON_GAPS`,
      );
    }
    const notes: string[] = [];
    if (unexplained.length) notes.push(`⚠ faltan ${unexplained.join(', ')}`);
    if (known && exempt.size) notes.push(`sin ${[...exempt].join(', ')}: ${known.why}`);
    console.log(
      `  ${league.padEnd(13)} ${first}–${last}  ${seasons.length} temporadas` +
        (notes.length ? `  ${notes.join(' · ')}` : ''),
    );
  }
}

// ===========================================================================
// EL PARSER DE FOOTBALL.TXT, CONTRA MUESTRAS FIJAS
// ===========================================================================
// El parser se verificó contra el mirror JSON en una temporada que existe en los dos
// formatos: 387 partidos, cero diferencias en goles y cero en descansos. Esa
// comprobación es la buena y no se puede repetir aquí, porque necesita red.
//
// Lo que sí se puede fijar son los dos casos que la primera versión falló, y no son
// hipotéticos: los descubrió esa comparación.
//
//   1. HAY DOS LAYOUTS. Los ficheros viejos ponen el marcador en medio; los nuevos
//      separan los equipos con `v` y lo ponen al final. La primera versión solo
//      entendía uno y sacaba 1 partido de 390.
//   2. EL AÑO NO SE CUENTA, SE DECIDE. Deducirlo sumando uno cada vez que el mes
//      retrocedía fallaba en 47 partidos de 390: un aplazado escrito fuera de orden
//      adelantaba el contador y el error se arrastraba hasta el final del fichero.
function auditFootballTxtParser(): void {
  console.log('\n▸ Fútbol: el parser de Football.TXT');

  // Layout viejo: marcador en medio. Incluye un club con año en el nombre
  // ("Parma Calcio 1913"), que es lo que obliga a exigir dos espacios.
  const viejo = [
    '= Italian Serie B 2022/23',
    '',
    '# Date       Fri Aug 12 2022 - Sun Jun 11 2023 (303d)',
    '',
    '▪ Matchday 1',
    'Fri Aug 12',
    '  20:45  Parma Calcio 1913        2-2 (2-2)  SSC Bari',
    'Sat Jan 14',
    '         Como 1907                1-0 (0-0)  Pisa SC',
  ].join('\n');
  const a = parseFootballTxt(viejo, '2022-23');
  check('TXT viejo: dos partidos', a.length === 2, `salieron ${a.length}`);
  check(
    'TXT viejo: club con año en el nombre',
    a[0]?.team1 === 'Parma Calcio 1913' && a[0]?.team2 === 'SSC Bari',
    `${a[0]?.team1} / ${a[0]?.team2}`,
  );
  check('TXT viejo: agosto es el año de inicio', a[0]?.date === '2022-08-12', a[0]?.date ?? '—');
  check('TXT viejo: enero es el año de fin', a[1]?.date === '2023-01-14', a[1]?.date ?? '—');
  check(
    'TXT viejo: descanso leído',
    JSON.stringify(a[0]?.score.ht) === '[2,2]',
    JSON.stringify(a[0]?.score.ht),
  );

  // Layout nuevo: separador `v`, marcador al final, fechas con sangría. Y las tres
  // trampas juntas: un aplazado sin marcador, un resultado por resolución de mesa, y
  // una fecha de abril escrita DESPUÉS de una de mayo, que es lo que descarrilaba al
  // contador de años.
  const nuevo = [
    '= Italian Serie B 2024/25',
    '',
    '# Date       Fri Aug 16 2024 - Sun Jun 1 2025 (289d)',
    '',
    '▪ Matchday 1',
    '  Fri Aug 16 2024',
    '    20:30  Brescia Calcio          v Palermo FC               1-0 (0-0)',
    '  Sat May 17',
    '           AS Cittadella           v Pisa SC                  0-3    [awarded]',
    '           US Salernitana 1919     v Frosinone Calcio         [postponed]',
    '  Sun Apr 6',
    '           Cesena FC               v Modena FC                2-1 (1-0)',
  ].join('\n');
  const b = parseFootballTxt(nuevo, '2024-25');
  check('TXT nuevo: tres partidos (el aplazado no cuenta)', b.length === 3, `salieron ${b.length}`);
  check(
    'TXT nuevo: equipos separados por v',
    b[0]?.team1 === 'Brescia Calcio' && b[0]?.team2 === 'Palermo FC',
    `${b[0]?.team1} / ${b[0]?.team2}`,
  );
  check('TXT nuevo: el año escrito manda', b[0]?.date === '2024-08-16', b[0]?.date ?? '—');
  check('TXT nuevo: [awarded] se guarda', b[1]?.date === '2025-05-17', b[1]?.date ?? '—');
  check(
    'TXT nuevo: abril tras mayo NO adelanta el año',
    b[2]?.date === '2025-04-06',
    b[2]?.date ?? '—',
  );
  check(
    'TXT nuevo: sin marcador no se inventa un 0-0',
    !b.some((m) => m.team2 === 'Frosinone Calcio'),
    'se coló el aplazado',
  );
  console.log(`  ${a.length + b.length} partidos de muestra, dos layouts`);
}

function auditClubNameSplits(): void {
  const rows = getDb()
    .prepare('SELECT league, id, name FROM fb_teams ORDER BY league, id')
    .all() as unknown as { league: string; id: string; name: string }[];
  console.log('\n▸ Fútbol: ¿algún club partido en dos ids?');
  if (rows.length === 0) {
    console.log('  sin equipos, saltado');
    return;
  }
  // normalizeTeamName, NOT slugify — and the difference is a whole class of bug this
  // check could not see. slugify strips the legal-form suffixes (FC, CF, SC…) and
  // caught "Manchester City" vs "Manchester City FC". It does not strip "Club" or
  // "de", so "Atlético Madrid" and "Club Atlético de Madrid" stayed two ids, 38
  // matches against 227, and this check passed while the split was in front of it.
  // The resolver's normalisation is the looser one and is what the ingest now uses,
  // so it is what the audit has to use too.
  const byKey = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    const key = `${r.league}|${normalizeTeamName(r.name)}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ id: r.id, name: r.name });
  }
  const split = [...byKey.entries()].filter(([, v]) => v.length > 1);
  check(
    'fútbol: ningún club aparece con dos ids distintos',
    split.length === 0,
    split
      .slice(0, 4)
      .map(([k, v]) => `${k} → ${v.map((x) => `${x.id} ("${x.name}")`).join(' + ')}`)
      .join('; '),
  );
  console.log(`  ${rows.length} equipos · ${byKey.size} clubes distintos tras normalizar el nombre`);
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
  auditGoallessDraws();
  auditClubNameSplits();
  auditSeasonGaps();
  auditFootballTxtParser();
  auditExperimentRegistry();
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

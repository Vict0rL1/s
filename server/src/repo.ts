// Read helpers over the SQLite store. Everything the API and the model need to
// query lives here so the model modules stay pure and testable.

import { getDb } from './db.ts';
import { freshFilter } from './freshness.ts';
import { INITIAL_ELO } from './model/elo.ts';
import type { FormResult } from './model/form.ts';
import type { H2HMeeting } from './model/h2h.ts';
import type {
  FitnessSignals,
  OfficialRanking,
  PlayerInfo,
  PlayerRow,
  TournamentHistory,
  RatingRow,
  ServeStats,
  SurfaceRecord,
  TourId,
  UpcomingRow,
} from './types.ts';

export interface PlayerProfile extends PlayerRow {
  rating: RatingRow;
  eloRank: number;
  ranking: OfficialRanking | null;
  age: number | null;
  serve: ServeStats;
  recent: RecentMatch[];
}

export interface RecentMatch {
  date: string;
  tourney_name: string | null;
  surface: string | null;
  round: string | null;
  score: string | null;
  won: boolean;
  opponent_id: number;
  opponent_name: string | null;
}

export function getPlayer(tour: TourId, id: number): PlayerRow | null {
  return (
    (getDb()
      .prepare('SELECT id, tour, name, hand, country, birthdate FROM players WHERE tour = ? AND id = ?')
      .get(tour, id) as unknown as PlayerRow | undefined) ?? null
  );
}

export function searchPlayers(
  tour: TourId,
  q: string,
  limit = 50,
  offset = 0,
): PlayerRow[] {
  const like = `%${q.toLowerCase()}%`;
  return getDb()
    .prepare(
      `SELECT p.id, p.tour, p.name, p.hand, p.country, p.birthdate
       FROM players p
       JOIN player_ratings r ON r.tour = p.tour AND r.player_id = p.id
       WHERE p.tour = ? AND (? = '' OR lower(p.name) LIKE ?)
       ORDER BY r.overall DESC
       LIMIT ? OFFSET ?`,
    )
    .all(tour, q, like, limit, offset) as unknown as PlayerRow[];
}

export function getRating(tour: TourId, id: number): RatingRow {
  const row = getDb()
    .prepare('SELECT * FROM player_ratings WHERE tour = ? AND player_id = ?')
    .get(tour, id) as unknown as RatingRow | undefined;
  if (row) return row;
  // Unknown / brand-new player → default rating.
  return {
    player_id: id,
    tour,
    overall: INITIAL_ELO,
    hard: INITIAL_ELO,
    clay: INITIAL_ELO,
    grass: INITIAL_ELO,
    matches_played: 0,
    last_date: null,
  };
}

/**
 * Recent win/loss outcomes for one player (most recent first).
 *
 * The two roles are fetched as separate indexed lookups and merged, instead of
 * `(winner_id = ? OR loser_id = ?)`. With the OR, SQLite walks the tour in date
 * order until it happens to find `limit` matches for this player — cheap for an
 * active player, very slow for anyone who stopped playing years ago. Two point
 * lookups plus a sort of a few hundred rows is fast for everyone.
 */
export function getRecentForm(tour: TourId, id: number, limit = 10): FormResult[] {
  return getDb()
    .prepare(
      `SELECT date, won FROM (
         SELECT tourney_date AS date, id AS mid, 1 AS won
           FROM matches WHERE tour = ? AND winner_id = ?
         UNION ALL
         SELECT tourney_date AS date, id AS mid, 0 AS won
           FROM matches WHERE tour = ? AND loser_id = ?
       )
       ORDER BY date DESC, mid DESC
       LIMIT ?`,
    )
    .all(tour, id, tour, id, limit)
    .map((r: any) => ({ date: String(r.date), won: !!r.won }));
}

/** Detailed recent matches for a player profile (most recent first). */
export function getRecentMatches(tour: TourId, id: number, limit = 10): RecentMatch[] {
  const rows = getDb()
    .prepare(
      // One indexed lookup per role, merged (see getRecentForm for why).
      `SELECT date, tourney_name, surface, round, score, won, opponent_id FROM (
         SELECT tourney_date AS date, id AS mid, tourney_name, surface, round, score,
                1 AS won, loser_id AS opponent_id
           FROM matches WHERE tour = ? AND winner_id = ?
         UNION ALL
         SELECT tourney_date AS date, id AS mid, tourney_name, surface, round, score,
                0 AS won, winner_id AS opponent_id
           FROM matches WHERE tour = ? AND loser_id = ?
       )
       ORDER BY date DESC, mid DESC
       LIMIT ?`,
    )
    .all(tour, id, tour, id, limit) as any[];

  const nameStmt = getDb().prepare('SELECT name FROM players WHERE tour = ? AND id = ?');
  return rows.map((r) => {
    const opp = nameStmt.get(tour, r.opponent_id) as unknown as { name: string } | undefined;
    return {
      date: String(r.date),
      tourney_name: r.tourney_name,
      surface: r.surface,
      round: r.round,
      score: r.score,
      won: !!r.won,
      opponent_id: r.opponent_id,
      opponent_name: opp?.name ?? null,
    };
  });
}

/** Every meeting between two players. */
export function getH2HMeetings(tour: TourId, p1: number, p2: number): H2HMeeting[] {
  // One indexed lookup per direction (see getRecentForm for why not one OR).
  //
  // Sorted in JS on purpose: with `ORDER BY tourney_date DESC` in the SQL,
  // SQLite prefers the date index — which sorts for free but scans every match
  // of the tour (41 ms) — over the far more selective player index (0.1 ms). Two
  // players meet a few dozen times at most, so sorting here costs nothing.
  const rows = getDb()
    .prepare(
      `SELECT date, winnerId, tourney_name, surface, round, score FROM (
         SELECT tourney_date AS date, winner_id AS winnerId, tourney_name, surface, round, score
           FROM matches WHERE tour = ? AND winner_id = ? AND loser_id = ?
         UNION ALL
         SELECT tourney_date AS date, winner_id AS winnerId, tourney_name, surface, round, score
           FROM matches WHERE tour = ? AND winner_id = ? AND loser_id = ?
       )`,
    )
    .all(tour, p1, p2, tour, p2, p1) as unknown as H2HMeeting[];
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Aggregated serve/return stats across all matches with recorded stats. */
export function getServeStats(tour: TourId, id: number): ServeStats {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*)      AS n,
         SUM(ace)      AS ace,
         SUM(df)       AS df,
         SUM(svpt)     AS svpt,
         SUM(in1)      AS in1,
         SUM(won1)     AS won1,
         SUM(won2)     AS won2,
         SUM(bpSaved)  AS bpSaved,
         SUM(bpFaced)  AS bpFaced
       FROM (
         SELECT w_ace ace, w_df df, w_svpt svpt, w_1stIn in1, w_1stWon won1,
                w_2ndWon won2, w_bpSaved bpSaved, w_bpFaced bpFaced
           FROM matches WHERE tour = ? AND winner_id = ? AND w_svpt IS NOT NULL
         UNION ALL
         SELECT l_ace, l_df, l_svpt, l_1stIn, l_1stWon,
                l_2ndWon, l_bpSaved, l_bpFaced
           FROM matches WHERE tour = ? AND loser_id = ? AND l_svpt IS NOT NULL
       )`,
    )
    .get(tour, id, tour, id) as unknown as {
    n: number;
    ace: number | null;
    df: number | null;
    svpt: number | null;
    in1: number | null;
    won1: number | null;
    won2: number | null;
    bpSaved: number | null;
    bpFaced: number | null;
  };

  const svpt = row.svpt ?? 0;
  const in1 = row.in1 ?? 0;
  const pct = (num: number | null, den: number): number | null =>
    den > 0 && num != null ? Math.round((num / den) * 1000) / 10 : null;

  return {
    matches: row.n ?? 0,
    acePct: pct(row.ace, svpt),
    dfPct: pct(row.df, svpt),
    firstInPct: pct(in1, svpt),
    firstWonPct: pct(row.won1, in1),
    secondWonPct: pct(row.won2, svpt - in1),
    bpSavedPct: pct(row.bpSaved, row.bpFaced ?? 0),
    acesPerMatch: row.n > 0 && row.ace != null ? Math.round((row.ace / row.n) * 10) / 10 : null,
  };
}

/**
 * Win/loss record on a specific surface.
 *
 * Written as two separate counts rather than `(winner_id = ? OR loser_id = ?)`:
 * an OR over two different columns leaves SQLite free to choose between a
 * multi-index union and a full scan of the tour, and it picks the scan often
 * enough to matter (measured: 96 ms vs 0.1 ms on 62k matches, and a prediction
 * issues six queries of this shape). Two point lookups can only be index reads.
 */
export function getSurfaceRecord(tour: TourId, id: number, surface: string): SurfaceRecord {
  const row = getDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM matches
           WHERE tour = ? AND winner_id = ? AND surface = ?) AS wins,
         (SELECT COUNT(*) FROM matches
           WHERE tour = ? AND loser_id  = ? AND surface = ?) AS losses`,
    )
    .get(tour, id, surface, tour, id, surface) as unknown as {
    wins: number | null;
    losses: number | null;
  };
  return { wins: row.wins ?? 0, losses: row.losses ?? 0 };
}

/** 1-based rank of a player by overall Elo within their tour (1 = highest). */
export function getEloRank(tour: TourId, id: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) + 1 AS rank
       FROM player_ratings
       WHERE tour = ? AND overall > (
         SELECT overall FROM player_ratings WHERE tour = ? AND player_id = ?
       )`,
    )
    .get(tour, tour, id) as unknown as { rank: number };
  return row.rank;
}

function ymdToUtc(ymd: string): number | null {
  if (!ymd || ymd.length < 8) return null;
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return Number.isNaN(t) ? null : t;
}

/** Whole days between two YYYYMMDD dates (null if either is unparseable). */
function daysBetweenYmd(fromYmd: string, toYmd: string): number | null {
  const a = ymdToUtc(fromYmd);
  const b = ymdToUtc(toYmd);
  if (a === null || b === null) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Physical-availability signals from results: retirements and walkovers (which
 * appear in the score text, e.g. "6-4 2-1 RET"), time since the last match, and
 * recent workload. Evidence of fitness problems, not a medical claim.
 */
export function getFitnessSignals(tour: TourId, id: number): FitnessSignals {
  const recent = getDb()
    .prepare(
      // One indexed lookup per role, merged (see getRecentForm for why).
      `SELECT date, score, lost FROM (
         SELECT tourney_date AS date, id AS mid, score, 0 AS lost
           FROM matches WHERE tour = ? AND winner_id = ?
         UNION ALL
         SELECT tourney_date AS date, id AS mid, score, 1 AS lost
           FROM matches WHERE tour = ? AND loser_id = ?
       )
       ORDER BY date DESC, mid DESC
       LIMIT 20`,
    )
    .all(tour, id, tour, id) as unknown as {
    date: string;
    score: string | null;
    lost: number;
  }[];

  let retirements = 0;
  let walkovers = 0;
  let lastIncidentDate: string | null = null;
  for (const m of recent) {
    const score = (m.score || '').toUpperCase();
    // Only counts against the player who could not continue (the loser).
    const isRet = /\bRET\b/.test(score);
    const isWo = /\bW\/?O\b|WALKOVER|DEF/.test(score);
    if (m.lost && (isRet || isWo)) {
      if (isRet) retirements++;
      else walkovers++;
      if (!lastIncidentDate) lastIncidentDate = String(m.date);
    }
  }

  const lastDate = recent[0]?.date ? String(recent[0].date) : null;
  // Measure the gap against the newest match in the DATASET, not today: if the
  // history lags behind (a source updated weekly/monthly), "days since last
  // match" would otherwise report the dataset's staleness as a player absence.
  const datasetLatest = (
    getDb().prepare('SELECT MAX(tourney_date) AS d FROM matches WHERE tour = ?').get(tour) as
      unknown as { d: string | null }
  ).d;
  const load = lastDate
    ? (() => {
        // Two indexed counts rather than an OR (see getSurfaceRecord).
        const from = shiftYmd(lastDate, -30);
        const r = getDb()
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM matches
                 WHERE tour = ? AND winner_id = ?
                   AND tourney_date < ? AND tourney_date >= ?) AS w,
               (SELECT COUNT(*) FROM matches
                 WHERE tour = ? AND loser_id = ?
                   AND tourney_date < ? AND tourney_date >= ?) AS l`,
          )
          .get(tour, id, lastDate, from, tour, id, lastDate, from) as unknown as {
          w: number;
          l: number;
        };
        return r.w + r.l;
      })()
    : 0;

  return {
    retirements,
    walkovers,
    lastIncidentDate,
    daysSinceLastMatch: lastDate && datasetLatest ? daysBetweenYmd(lastDate, datasetLatest) : null,
    matchesLast30Days: load,
  };
}

/** Shift a YYYYMMDD date by N days, returning YYYYMMDD. */
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** A player's record at a specific tournament (matched by name). */
export function getTournamentHistory(
  tour: TourId,
  id: number,
  tourneyName: string,
): TournamentHistory {
  if (!tourneyName) return { played: 0, wins: 0, losses: 0, titles: 0, finals: 0, bestRound: null };
  const like = `%${tourneyName.toLowerCase()}%`;
  // `LIKE '%name%'` can never use an index, so the player filter has to be the
  // one that narrows the search — as two indexed lookups, not an OR (which let
  // SQLite scan every match of the tour: measured 180 ms vs 0.1 ms). The name
  // filter then applies to that player's few hundred matches. Aggregating in JS
  // keeps it to a single query instead of two scans.
  const rows = getDb()
    .prepare(
      `SELECT won, round FROM (
         SELECT 1 AS won, round, tourney_name
           FROM matches WHERE tour = ? AND winner_id = ?
         UNION ALL
         SELECT 0 AS won, round, tourney_name
           FROM matches WHERE tour = ? AND loser_id = ?
       )
       WHERE lower(tourney_name) LIKE ?`,
    )
    .all(tour, id, tour, id, like) as unknown as { won: number; round: string | null }[];

  let wins = 0;
  let losses = 0;
  let titles = 0;
  let finals = 0;
  const seenRounds = new Set<string>();
  for (const r of rows) {
    if (r.won) wins++;
    else losses++;
    const round = (r.round ?? '').toUpperCase();
    if (round) seenRounds.add(round);
    if (round === 'F') {
      finals++;
      if (r.won) titles++;
    }
  }

  // Deepest round reached, ordered by how far it is in a draw.
  const ORDER = ['F', 'SF', 'QF', 'R16', 'R32', 'R64', 'R128', 'RR'];
  const best = ORDER.find((r) => seenRounds.has(r)) ?? null;

  return { played: rows.length, wins, losses, titles, finals, bestRound: best };
}

/** Latest official ATP/WTA ranking for a player (null if not ranked/unknown). */
export function getOfficialRanking(tour: TourId, id: number): OfficialRanking | null {
  const row = getDb()
    .prepare(
      'SELECT rank, points, ranking_date FROM player_rankings WHERE tour = ? AND player_id = ?',
    )
    .get(tour, id) as unknown as
    | { rank: number; points: number | null; ranking_date: string }
    | undefined;
  return row ? { rank: row.rank, points: row.points, date: row.ranking_date } : null;
}

function ageFromDob(dob: string | null): number | null {
  if (!dob || dob.length < 8) return null;
  const y = Number(dob.slice(0, 4));
  const m = Number(dob.slice(4, 6));
  const d = Number(dob.slice(6, 8));
  if (!y || !m || !d) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const beforeBirthday =
    now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) age--;
  return age > 0 && age < 100 ? age : null;
}

/**
 * Player facts that don't depend on the match history being complete: name,
 * country, hand, age and official ranking. Resolves by id when known, otherwise
 * by name — so a player the model can't rate can still be described.
 */
export function getPlayerInfo(
  tour: TourId,
  idOrName: number | string,
): PlayerInfo | null {
  const player =
    typeof idOrName === 'number'
      ? getPlayer(tour, idOrName)
      : ((getDb()
          .prepare('SELECT id, tour, name, hand, country, birthdate FROM players WHERE tour = ? AND lower(name) = ?')
          .get(tour, idOrName.toLowerCase()) as unknown as PlayerRow | undefined) ?? null);
  if (!player) return null;

  // Two indexed counts, NOT `(winner_id = ? OR loser_id = ?)` — the same rule this file
  // states twice above and this one call site missed. With the OR, SQLite cannot use
  // either of idx_matches_winner / idx_matches_loser and walks the whole tour.
  //
  // It cost nothing while the tennis tab ran on the 1,716-match demo seed. On the real
  // 61,682-match archive it is 89 ms, and the schedule endpoint calls it twice per
  // match: 27 matches took 4.9 SECONDS to load. Below 2 ms after this change.
  const played = getDb()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM matches WHERE tour = ? AND winner_id = ?)
            + (SELECT COUNT(*) FROM matches WHERE tour = ? AND loser_id = ?) AS c`,
    )
    .get(tour, player.id, tour, player.id) as unknown as { c: number };

  return {
    id: player.id,
    name: player.name,
    country: player.country,
    hand: player.hand,
    age: ageFromDob(player.birthdate),
    ranking: getOfficialRanking(tour, player.id),
    matchesInDb: played.c,
  };
}

export function getProfile(tour: TourId, id: number): PlayerProfile | null {
  const player = getPlayer(tour, id);
  if (!player) return null;
  return {
    ...player,
    rating: getRating(tour, id),
    eloRank: getEloRank(tour, id),
    ranking: getOfficialRanking(tour, id),
    age: ageFromDob(player.birthdate),
    serve: getServeStats(tour, id),
    recent: getRecentMatches(tour, id, 10),
  };
}

export function listUpcoming(filter: {
  tour?: string;
  tournament?: string;
}): UpcomingRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.tour) {
    clauses.push('tour = ?');
    params.push(filter.tour);
  }
  if (filter.tournament) {
    clauses.push('tournament_id = ?');
    params.push(filter.tournament);
  }
  // Finished matches are dropped here rather than in the interface: with the
  // schedule grouped by day, yesterday's match files under "Ayer" and sits above
  // tomorrow's. See freshness.ts for why the cutoff has slack.
  const fresh = freshFilter();
  clauses.push(fresh.sql);
  params.push(...fresh.params);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM upcoming_matches ${where} ORDER BY commence_time ASC`)
    .all(...params) as unknown as UpcomingRow[];
}

/** Distinct tournaments present in upcoming_matches (for dynamic/live events). */
export function getUpcomingTournaments(
  tour?: string,
): { tournament_id: string; tournament_name: string; surface: string; tour: string; count: number }[] {
  const where = tour ? 'WHERE tour = ?' : '';
  const params = tour ? [tour] : [];
  return getDb()
    .prepare(
      `SELECT tournament_id, tournament_name, surface, tour, COUNT(*) AS count
       FROM upcoming_matches ${where}
       GROUP BY tournament_id, tour
       ORDER BY MIN(commence_time) ASC`,
    )
    .all(...params) as unknown as {
    tournament_id: string;
    tournament_name: string;
    surface: string;
    tour: string;
    count: number;
  }[];
}

export function getUpcomingById(id: string): UpcomingRow | null {
  return (
    (getDb().prepare('SELECT * FROM upcoming_matches WHERE id = ?').get(id) as
      | UpcomingRow
      | undefined) ?? null
  );
}

export function countRows(table: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as unknown as {
    c: number;
  };
  return row.c;
}

// ===========================================================================
// LA CLASIFICACIÓN POR ELO
// ===========================================================================

export interface EloRankRow {
  id: number;
  name: string;
  country: string | null;
  elo: number;
  /** Elo por superficie. La comparación entre las tres es media utilidad de esto. */
  hard: number;
  clay: number;
  grass: number;
  matches: number;
  /** YYYYMMDD del último partido. Es lo que distingue «es bueno» de «era bueno». */
  lastDate: string | null;
  /** Días desde ese partido, para poder decir «hace 4 años» sin hacer cuentas fuera. */
  daysSince: number | null;
  /** Ranking oficial ATP/WTA, para contrastar el Elo con la lista de puntos. */
  officialRank: number | null;
  /**
   * De qué fecha es ese ranking, y si está desfasado respecto del snapshot más nuevo.
   *
   * ===========================================================================
   * POR QUÉ HACE FALTA LA FECHA Y NO BASTA EL NÚMERO
   * ===========================================================================
   * `player_rankings` guarda el snapshot más reciente DE CADA JUGADOR, y esos snapshots
   * NO son del mismo día. En este archivo hay tres jugadores con «rank 5»: Djokovic
   * (noviembre), Auger-Aliassime (enero) y Draper (agosto). Cada número es correcto en
   * su fecha y la columna entera es engañosa sin ella — dos «ATP#5» uno debajo del otro
   * se leen como un error de la app.
   *
   * No se arregla eligiendo uno: el dato que falta es el snapshot completo de un mismo
   * día, y eso lo tiene que traer la ingesta. Lo que sí se puede hacer, y se hace, es no
   * presentarlo como si fuera de hoy.
   */
  officialRankDate: string | null;
}

/**
 * Los mejores por Elo, con dos filtros que NO son cosméticos.
 *
 * ===========================================================================
 * POR QUÉ HAY QUE FILTRAR POR ACTIVIDAD
 * ===========================================================================
 * El Elo de un jugador se queda CONGELADO en su último partido. Sin filtro, la lista
 * de la ATP sale así:
 *
 *     4. Roger Federer   2091   último partido: 2021-06-28
 *     8. Rafael Nadal    2020   último partido: 2024-11-19
 *
 * Los dos números son correctos y la lista es inútil: preguntada «¿quién es mejor
 * ahora?», contesta con dos retirados. No es un dato erróneo, es un dato que responde a
 * otra pregunta — «quién llegó más alto» — y mezclarlas en la misma tabla sin decirlo
 * es la forma más fácil de que alguien analice una superficie basándose en un jugador
 * que no la pisa desde hace cuatro años.
 *
 * Así que el filtro existe, tiene un valor por defecto declarado, y se puede apagar
 * para ver la lista histórica a propósito.
 *
 * ===========================================================================
 * Y POR QUÉ FILTRAR POR PARTIDOS JUGADOS
 * ===========================================================================
 * Con 3 partidos, un Elo es ruido con tres decimales. En este archivo hay 1.275
 * jugadores valorados y solo 373 con 20 partidos o más; los de pocos partidos no
 * llegan arriba del todo, pero sí ensucian la parte media de la tabla con números que
 * nadie puede interpretar. El umbral se enseña, no se esconde.
 *
 * @param activeDays  null = sin filtro de actividad (la lista histórica)
 */
export function getEloRanking(
  tour: TourId,
  opts: { limit?: number; minMatches?: number; activeDays?: number | null } = {},
): EloRankRow[] {
  const limit = Math.min(opts.limit ?? 50, 500);
  const minMatches = opts.minMatches ?? 20;
  const activeDays = opts.activeDays === undefined ? 730 : opts.activeDays;

  const rows = getDb()
    .prepare(
      `SELECT p.id, p.name, p.country,
              r.overall AS elo, r.hard, r.clay, r.grass,
              r.matches_played AS matches, r.last_date AS lastDate,
              k.rank AS officialRank, k.ranking_date AS officialRankDate
       FROM player_ratings r
       JOIN players p ON p.tour = r.tour AND p.id = r.player_id
       LEFT JOIN player_rankings k ON k.tour = r.tour AND k.player_id = r.player_id
       WHERE r.tour = ? AND r.matches_played >= ?
       ORDER BY r.overall DESC`,
    )
    .all(tour, minMatches) as unknown as (Omit<EloRankRow, 'daysSince'> & {
    lastDate: string | null;
  })[];

  const today = new Date();
  const todayYmd =
    `${today.getUTCFullYear()}` +
    `${String(today.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(today.getUTCDate()).padStart(2, '0')}`;

  const withAge = rows.map((r) => ({
    ...r,
    daysSince: r.lastDate ? daysBetweenYmd(r.lastDate, todayYmd) : null,
  }));

  // Un jugador sin fecha NO se descarta al filtrar por actividad: no se sabe cuándo
  // jugó, y tratar «no lo sé» como «hace mucho» lo borraría de la lista con la misma
  // seguridad que si se supiera. Se deja y su columna de fecha lo dice.
  const active =
    activeDays == null
      ? withAge
      : withAge.filter((r) => r.daysSince == null || r.daysSince <= activeDays);

  return active.slice(0, limit);
}

/**
 * ¿Forma la columna de ranking oficial un snapshot coherente?
 *
 * ===========================================================================
 * UN DEFECTO DE LOS DATOS QUE NO SE PUEDE ARREGLAR AQUÍ, SOLO DECIR
 * ===========================================================================
 * `player_rankings` guarda el snapshot más reciente DE CADA JUGADOR, no el ranking
 * completo de un día. Esos snapshots son de fechas distintas, así que la columna mezcla
 * el ranking de agosto de uno con el de enero de otro — y en este archivo salen TRES
 * jugadores con «rank 5».
 *
 * Marcarlo fila a fila no sirve: comparando con la fecha más nueva, el 100 % de las
 * filas sale «desfasada» y una marca que aparece en todas partes no informa de nada. Lo
 * que sí informa es el rango: si los rankings van de agosto a enero, la columna no es
 * una foto de hoy y hay que leerla como lo que es.
 *
 * Arreglarlo de verdad es trabajo de la ingesta —traer el ranking completo de un día—,
 * no de la consulta.
 */
export function officialRankingCoherence(tour: TourId): {
  from: string | null;
  to: string | null;
  spanDays: number | null;
  coherent: boolean;
} {
  const row = getDb()
    .prepare(
      'SELECT MIN(ranking_date) AS a, MAX(ranking_date) AS b FROM player_rankings WHERE tour = ?',
    )
    .get(tour) as unknown as { a: string | null; b: string | null };
  if (!row.a || !row.b) return { from: null, to: null, spanDays: null, coherent: true };
  const spanDays = daysBetweenYmd(row.a, row.b);
  return {
    from: row.a,
    to: row.b,
    spanDays,
    // Una semana de margen: las listas oficiales se publican los lunes, así que un
    // par de días de diferencia es la misma lista, y un mes no lo es.
    coherent: spanDays != null && spanDays <= 7,
  };
}

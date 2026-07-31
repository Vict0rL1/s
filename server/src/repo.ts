// Read helpers over the SQLite store. Everything the API and the model need to
// query lives here so the model modules stay pure and testable.

import { getDb } from './db.ts';
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

  const played = getDb()
    .prepare(
      'SELECT COUNT(*) AS c FROM matches WHERE tour = ? AND (winner_id = ? OR loser_id = ?)',
    )
    .get(tour, player.id, player.id) as unknown as { c: number };

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

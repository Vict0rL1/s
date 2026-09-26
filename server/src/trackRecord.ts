// ===========================================================================
// TRACK RECORD = how the app has actually been doing, on YOUR matches
// ===========================================================================
// `npm run backtest` measures the model on history (2005–today). That is the
// right way to fit it, but it answers a different question from the one a user
// actually has: *has this thing been right about the matches I looked at?*
//
// So every prediction served for an upcoming match is written down at the moment
// it is shown — and never rewritten. When the real result later arrives in the
// history (each `update-data`), the stored prediction is matched to it and
// scored. Three properties make the resulting number trustworthy:
//
//   • Written BEFORE the match, so there is no hindsight.
//   • First value wins (INSERT OR IGNORE): a prediction can't be quietly
//     improved after the fact as odds move.
//   • Survives re-ingestion (see resetData in db.ts), so the record accumulates.
//
// It doubles as a health check on the data: if the history goes stale or breaks,
// accuracy falls and the dashboard shows it instead of failing silently.
// ===========================================================================

import { getDb } from './db.ts';
import type { Prediction } from './model/predict.ts';
import type { TourId, UpcomingRow } from './types.ts';

/** Tournament dates are START dates, so a match can be played weeks later. */
const RESOLVE_WINDOW_BEFORE_DAYS = 10; // fixture listed before the event's start date
const RESOLVE_WINDOW_AFTER_DAYS = 30; // match played this long after the start date

export interface TrackRecordBand {
  label: string;
  n: number;
  predicted: number; // mean probability the model gave
  observed: number; // share that actually won
}

export interface TrackRecordTier {
  level: string;
  n: number;
  accuracy: number | null;
  brier: number | null;
}

export interface TrackRecord {
  resolved: number;
  pending: number;
  /** Share of resolved predictions where the favoured player won (null if none). */
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  /** Predicted-vs-observed by probability band, for calibration. */
  calibration: TrackRecordBand[];
  /** Accuracy split by the reliability tier assigned at prediction time. */
  byReliability: TrackRecordTier[];
  /**
   * Head-to-head against the bookmakers on the SAME matches — the only fair
   * comparison, and the one the backtest can't make (no historical odds).
   */
  vsMarket: {
    n: number;
    modelAccuracy: number | null;
    marketAccuracy: number | null;
    modelBrier: number | null;
    marketBrier: number | null;
    /** Matches where model and market favoured different players. */
    disagreements: number;
    /** Of those, how often the model was the one that got it right. */
    modelRightOnDisagreement: number | null;
  } | null;
  /** Most recently resolved predictions, newest first (for a detail table). */
  recent: {
    tournament: string | null;
    surface: string | null;
    date: string | null;
    p1: string | null;
    p2: string | null;
    prob1: number;
    winnerIsP1: boolean;
    hit: boolean;
    reliability: string | null;
  }[];
}

/** Stable identity for a fixture, independent of which odds feed produced it. */
function matchKey(tour: TourId, p1: number, p2: number, commenceTime: string | null): string {
  const lo = Math.min(p1, p2);
  const hi = Math.max(p1, p2);
  return `${tour}|${lo}|${hi}|${ymdOf(commenceTime)}`;
}

/** ISO timestamp → YYYYMMDD (falls back to today when the feed omits it). */
function ymdOf(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const use = Number.isNaN(d.getTime()) ? new Date() : d;
  return (
    `${use.getUTCFullYear()}` +
    `${String(use.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(use.getUTCDate()).padStart(2, '0')}`
  );
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return (
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  );
}

/**
 * Record a prediction the app is about to show. Idempotent, and deliberately
 * write-once: the first probability served for a fixture is the one scored, so
 * the track record can't drift toward whatever the odds ended up saying.
 */
export function logPrediction(row: UpcomingRow, prediction: Prediction): void {
  if (row.p1_id == null || row.p2_id == null) return;
  const key = matchKey(row.tour, row.p1_id, row.p2_id, row.commence_time);
  try {
    getDb()
      .prepare(
        `INSERT INTO prediction_log (
           match_key, tour, upcoming_id, tournament_name, surface, commence_time,
           p1_id, p2_id, p1_name, p2_name, prob1, market_prob1, reliability, predicted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_key) DO NOTHING`,
      )
      .run(
        key,
        row.tour,
        row.id,
        row.tournament_name ?? null,
        row.surface ?? null,
        row.commence_time ?? null,
        row.p1_id,
        row.p2_id,
        prediction.players.p1.name,
        prediction.players.p2.name,
        prediction.model.prob1,
        prediction.market.market?.implied1 ?? null,
        prediction.reliability.level,
        new Date().toISOString(),
      );
  } catch {
    // Logging is a side benefit, never a reason to fail serving a prediction.
  }
}

/**
 * Match still-pending predictions against real results now present in the
 * history, and score them. Called after each ingest.
 *
 * A fixture's `commence_time` is the scheduled start of the MATCH, while
 * `matches.tourney_date` is the start of the TOURNAMENT, so they legitimately
 * differ by up to a couple of weeks at a Slam. Hence the asymmetric window plus
 * "closest date wins" rather than an exact-date join.
 */
export function resolvePredictions(): { resolved: number } {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT match_key, tour, p1_id, p2_id, commence_time
       FROM prediction_log WHERE resolved_at IS NULL`,
    )
    .all() as unknown as {
    match_key: string;
    tour: string;
    p1_id: number;
    p2_id: number;
    commence_time: string | null;
  }[];

  if (pending.length === 0) return { resolved: 0 };

  const find = db.prepare(
    `SELECT id, winner_id, tourney_date FROM matches
     WHERE tour = ?
       AND ((winner_id = ? AND loser_id = ?) OR (winner_id = ? AND loser_id = ?))
       AND tourney_date >= ? AND tourney_date <= ?
     ORDER BY ABS(CAST(tourney_date AS INTEGER) - CAST(? AS INTEGER)) ASC
     LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE prediction_log
     SET winner_id = ?, match_id = ?, resolved_at = ?
     WHERE match_key = ?`,
  );

  let resolved = 0;
  const now = new Date().toISOString();
  for (const p of pending) {
    const target = ymdOf(p.commence_time);
    const hit = find.get(
      p.tour,
      p.p1_id,
      p.p2_id,
      p.p2_id,
      p.p1_id,
      shiftYmd(target, -RESOLVE_WINDOW_AFTER_DAYS),
      shiftYmd(target, RESOLVE_WINDOW_BEFORE_DAYS),
      target,
    ) as unknown as { id: number; winner_id: number } | undefined;
    if (!hit) continue;
    update.run(hit.winner_id, hit.id, now, p.match_key);
    resolved++;
  }
  return { resolved };
}

interface ScoredRow {
  prob1: number;
  market_prob1: number | null;
  reliability: string | null;
  winner_id: number;
  p1_id: number;
  p2_id: number;
  p1_name: string | null;
  p2_name: string | null;
  tournament_name: string | null;
  surface: string | null;
  commence_time: string | null;
}

/** Accuracy over a set of (probability, outcome) pairs. A 50/50 call scores ½. */
function accuracyOf(pairs: { p: number; won: boolean }[]): number | null {
  if (pairs.length === 0) return null;
  let hits = 0;
  for (const { p, won } of pairs) {
    if (p === 0.5) hits += 0.5; // no pick was made; neither credit nor blame
    else if (p > 0.5 === won) hits += 1;
  }
  return round4(hits / pairs.length);
}

function brierOf(pairs: { p: number; won: boolean }[]): number | null {
  if (pairs.length === 0) return null;
  const sum = pairs.reduce((acc, { p, won }) => acc + (p - (won ? 1 : 0)) ** 2, 0);
  return round4(sum / pairs.length);
}

/** Compute the live track record, optionally restricted to one tour. */
export function getTrackRecord(tour?: string): TrackRecord {
  const db = getDb();
  const where = tour ? 'AND tour = ?' : '';
  const params = tour ? [tour] : [];

  const pending = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM prediction_log WHERE resolved_at IS NULL ${where}`)
      .get(...params) as unknown as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT prob1, market_prob1, reliability, winner_id, p1_id, p2_id, p1_name, p2_name,
              tournament_name, surface, commence_time
       FROM prediction_log
       WHERE resolved_at IS NOT NULL ${where}
       ORDER BY commence_time DESC`,
    )
    .all(...params) as unknown as ScoredRow[];

  const empty: TrackRecord = {
    resolved: 0,
    pending,
    accuracy: null,
    brier: null,
    logLoss: null,
    calibration: [],
    byReliability: [],
    vsMarket: null,
    recent: [],
  };
  if (rows.length === 0) return empty;

  // Everything below is expressed from p1's perspective, matching how prob1 was
  // stored, so a win for p2 is simply outcome = 0.
  const pairs = rows.map((r) => ({ p: r.prob1, won: r.winner_id === r.p1_id }));

  // Log loss with the probability clipped away from 0/1: a single 0-probability
  // hit would otherwise make the whole average infinite.
  const logLoss =
    pairs.reduce((acc, { p, won }) => {
      const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
      return acc - (won ? Math.log(q) : Math.log(1 - q));
    }, 0) / pairs.length;

  // Calibration: bucket by the confidence of the CALL (the favoured side), so
  // the bands read "when it says ~70%, does that side win ~70% of the time?".
  const bandDefs = [
    { label: '50–60%', lo: 0.5, hi: 0.6 },
    { label: '60–70%', lo: 0.6, hi: 0.7 },
    { label: '70–80%', lo: 0.7, hi: 0.8 },
    { label: '80–90%', lo: 0.8, hi: 0.9 },
    { label: '90–100%', lo: 0.9, hi: 1.01 },
  ];
  const calibration: TrackRecordBand[] = [];
  for (const b of bandDefs) {
    const inBand = pairs
      .map(({ p, won }) => (p >= 0.5 ? { p, won } : { p: 1 - p, won: !won })) // favourite's view
      .filter(({ p }) => p >= b.lo && p < b.hi);
    if (inBand.length === 0) continue;
    calibration.push({
      label: b.label,
      n: inBand.length,
      predicted: round4(inBand.reduce((a, x) => a + x.p, 0) / inBand.length),
      observed: round4(inBand.filter((x) => x.won).length / inBand.length),
    });
  }

  // Does the reliability tier mean anything? This is where it gets checked
  // against reality on live matches, not just in the backtest.
  const byReliability: TrackRecordTier[] = [];
  for (const level of ['high', 'medium', 'low']) {
    const subset = rows
      .filter((r) => r.reliability === level)
      .map((r) => ({ p: r.prob1, won: r.winner_id === r.p1_id }));
    if (subset.length === 0) continue;
    byReliability.push({
      level,
      n: subset.length,
      accuracy: accuracyOf(subset),
      brier: brierOf(subset),
    });
  }

  // Model vs market on identical matches — restricted to rows where odds existed
  // at prediction time, so neither side gets an easier set of matches.
  const withMarket = rows.filter((r) => r.market_prob1 != null);
  const vsMarket = withMarket.length
    ? (() => {
        const model = withMarket.map((r) => ({ p: r.prob1, won: r.winner_id === r.p1_id }));
        const market = withMarket.map((r) => ({
          p: r.market_prob1 as number,
          won: r.winner_id === r.p1_id,
        }));
        const disagree = withMarket.filter(
          (r) => r.prob1 > 0.5 !== (r.market_prob1 as number) > 0.5,
        );
        const modelRight = disagree.filter((r) => r.prob1 > 0.5 === (r.winner_id === r.p1_id));
        return {
          n: withMarket.length,
          modelAccuracy: accuracyOf(model),
          marketAccuracy: accuracyOf(market),
          modelBrier: brierOf(model),
          marketBrier: brierOf(market),
          disagreements: disagree.length,
          modelRightOnDisagreement: disagree.length
            ? round4(modelRight.length / disagree.length)
            : null,
        };
      })()
    : null;

  return {
    resolved: rows.length,
    pending,
    accuracy: accuracyOf(pairs),
    brier: brierOf(pairs),
    logLoss: round4(logLoss),
    calibration,
    byReliability,
    vsMarket,
    recent: rows.slice(0, 20).map((r) => {
      const winnerIsP1 = r.winner_id === r.p1_id;
      return {
        tournament: r.tournament_name,
        surface: r.surface,
        date: r.commence_time,
        p1: r.p1_name,
        p2: r.p2_name,
        prob1: r.prob1,
        winnerIsP1,
        hit: r.prob1 === 0.5 ? false : r.prob1 > 0.5 === winnerIsP1,
        reliability: r.reliability,
      };
    }),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// The American football track record: how the app has actually done on games YOU
// looked at, as opposed to how the model scores on history.
//
// Same contract as the other four sports: the prediction is written the FIRST
// time it is served, before kick-off, and never rewritten — so it cannot drift
// toward whatever the closing line ended up saying. `ON CONFLICT DO NOTHING` is
// what enforces that, not a convention someone has to remember.
//
// One column here that the others do not have: the market's own probability at
// the moment of the call. In every other sport that is a nice-to-have; in this
// one it is the point. The NFL closing line is the sharpest price in sports, so
// "how did the model do against it, on the games this app actually showed you"
// is the only version of the value question worth reporting.

import { getDb } from '../db.ts';
import type { NafPrediction } from './predict.ts';
import type { NafUpcomingRow } from './types.ts';

/** Kick-off can slip across time zones and weeks; allow a window. */
const RESOLVE_WINDOW_DAYS = 4;

export interface NflTrackRecord {
  resolved: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  /** Mean absolute error of the predicted margin, in points. */
  marginMae: number | null;
  /** Positive = the model expected the home team to win by more than it did. */
  marginBias: number | null;
  /** Mean absolute error of the predicted total. */
  totalMae: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  byReliability: { level: string; n: number; accuracy: number | null; brier: number | null }[];
  vsMarket: {
    n: number;
    modelAccuracy: number | null;
    marketAccuracy: number | null;
    modelBrier: number | null;
    marketBrier: number | null;
  } | null;
  recent: {
    league: string;
    date: string | null;
    home: string | null;
    away: string | null;
    probHome: number;
    homePoints: number | null;
    awayPoints: number | null;
    hit: boolean;
    reliability: string | null;
  }[];
}

export function matchKey(row: NafUpcomingRow): string {
  // Season and week rather than a date: a game can be moved (flexed to Sunday
  // night, or to a Tuesday after a storm) without becoming a different game, and
  // keying on the date would log it twice.
  const season = row.season ?? new Date(row.commence_time).getUTCFullYear();
  const week = row.week ?? 0;
  return `${row.league}|${season}|${week}|${row.away_id ?? row.away_name}|${row.home_id ?? row.home_name}`;
}

export function logNflPrediction(row: NafUpcomingRow, prediction: NafPrediction): void {
  // Demo rows are excluded: a record built on invented fixtures is not a record.
  if (row.source === 'fixture') return;
  if (!row.home_id || !row.away_id) return;

  getDb()
    .prepare(
      `INSERT INTO naf_prediction_log
         (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
          prob_home, market_prob_home, expected_margin, expected_total, reliability, predicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (match_key) DO NOTHING`,
    )
    .run(
      matchKey(row),
      row.league,
      row.id,
      row.commence_time,
      row.home_id,
      row.away_id,
      row.home_name,
      row.away_name,
      prediction.model.home,
      prediction.market.market?.home ?? null,
      prediction.spread.expectedMargin,
      prediction.total.expected,
      prediction.reliability.level,
      new Date().toISOString(),
    );
}

/** Match logged predictions to results that have since arrived. */
export function resolveNflPredictions(): { resolved: number } {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT match_key, league, home_id, away_id, commence_time
       FROM naf_prediction_log WHERE resolved_at IS NULL`,
    )
    .all() as unknown as {
    match_key: string;
    league: string;
    home_id: string;
    away_id: string;
    commence_time: string | null;
  }[];
  if (pending.length === 0) return { resolved: 0 };

  const find = db.prepare(
    `SELECT id, home_points, away_points, game_date
     FROM naf_games
     WHERE league = ? AND home_id = ? AND away_id = ? AND game_date BETWEEN ? AND ?
     ORDER BY game_date LIMIT 1`,
  );
  const mark = db.prepare(
    `UPDATE naf_prediction_log
     SET home_points = ?, away_points = ?, game_id = ?, resolved_at = ?
     WHERE match_key = ?`,
  );

  const ymd = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

  let resolved = 0;
  for (const p of pending) {
    const base = p.commence_time ? new Date(p.commence_time) : new Date();
    if (Number.isNaN(base.getTime())) continue;
    const from = new Date(base.getTime() - 24 * 3600_000);
    const to = new Date(base.getTime() + RESOLVE_WINDOW_DAYS * 24 * 3600_000);
    const row = find.get(p.league, p.home_id, p.away_id, ymd(from), ymd(to)) as unknown as
      | { id: number; home_points: number; away_points: number }
      | undefined;
    if (!row) continue;
    mark.run(row.home_points, row.away_points, row.id, new Date().toISOString(), p.match_key);
    resolved++;
  }
  return { resolved };
}

export function getNflTrackRecord(league?: string): NflTrackRecord {
  const db = getDb();
  const where = league ? 'WHERE league = ?' : '';
  const params = league ? [league] : [];

  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM naf_prediction_log ${where}${where ? ' AND' : 'WHERE'} resolved_at IS NULL`,
      )
      .get(...params) as unknown as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT league, commence_time, home_name, away_name, prob_home, market_prob_home,
              expected_margin, expected_total, reliability, home_points, away_points
       FROM naf_prediction_log ${where}${where ? ' AND' : 'WHERE'} resolved_at IS NOT NULL
       ORDER BY commence_time DESC`,
    )
    .all(...params) as unknown as {
    league: string;
    commence_time: string | null;
    home_name: string | null;
    away_name: string | null;
    prob_home: number;
    market_prob_home: number | null;
    expected_margin: number | null;
    expected_total: number | null;
    reliability: string | null;
    home_points: number;
    away_points: number;
  }[];

  const empty: NflTrackRecord = {
    resolved: 0,
    pending,
    accuracy: null,
    brier: null,
    logLoss: null,
    marginMae: null,
    marginBias: null,
    totalMae: null,
    calibration: [],
    byReliability: [],
    vsMarket: null,
    recent: [],
  };
  if (rows.length === 0) return empty;

  let hits = 0;
  let brier = 0;
  let logLoss = 0;
  let marginAbs = 0;
  let marginSigned = 0;
  let marginN = 0;
  let totalAbs = 0;
  let totalN = 0;

  const bands = [
    { label: '50-60%', lo: 0.5, hi: 0.6 },
    { label: '60-70%', lo: 0.6, hi: 0.7 },
    { label: '70-80%', lo: 0.7, hi: 0.8 },
    { label: '80-100%', lo: 0.8, hi: 1.01 },
  ].map((b) => ({ ...b, n: 0, predicted: 0, observed: 0 }));

  const byLevel = new Map<string, { n: number; hits: number; brier: number }>();
  let mN = 0;
  let mModelHits = 0;
  let mMarketHits = 0;
  let mModelBrier = 0;
  let mMarketBrier = 0;

  for (const r of rows) {
    // A tie scores as half a hit on both sides, the same convention the backtest
    // and the moneyline market use.
    const actual = r.home_points > r.away_points ? 1 : r.home_points === r.away_points ? 0.5 : 0;
    const hit = (r.prob_home >= 0.5 && actual >= 0.5) || (r.prob_home < 0.5 && actual <= 0.5);
    if (hit) hits++;
    brier += (r.prob_home - actual) ** 2;
    logLoss -=
      actual * Math.log(Math.max(r.prob_home, 1e-9)) +
      (1 - actual) * Math.log(Math.max(1 - r.prob_home, 1e-9));

    if (r.expected_margin != null) {
      const err = r.expected_margin - (r.home_points - r.away_points);
      marginAbs += Math.abs(err);
      marginSigned += err;
      marginN++;
    }
    if (r.expected_total != null) {
      totalAbs += Math.abs(r.expected_total - (r.home_points + r.away_points));
      totalN++;
    }

    // Calibration is measured on the FAVOURITE's probability, so an 80% call on
    // the away team counts in the same band as an 80% call on the home team.
    const pFav = Math.max(r.prob_home, 1 - r.prob_home);
    const favWon = r.prob_home >= 0.5 ? actual : 1 - actual;
    for (const b of bands) {
      if (pFav >= b.lo && pFav < b.hi) {
        b.n++;
        b.predicted += pFav;
        b.observed += favWon;
        break;
      }
    }

    const lvl = r.reliability ?? 'unknown';
    const cell = byLevel.get(lvl) ?? { n: 0, hits: 0, brier: 0 };
    cell.n++;
    if (hit) cell.hits++;
    cell.brier += (r.prob_home - actual) ** 2;
    byLevel.set(lvl, cell);

    if (r.market_prob_home != null) {
      mN++;
      if (hit) mModelHits++;
      const marketHit =
        (r.market_prob_home >= 0.5 && actual >= 0.5) || (r.market_prob_home < 0.5 && actual <= 0.5);
      if (marketHit) mMarketHits++;
      mModelBrier += (r.prob_home - actual) ** 2;
      mMarketBrier += (r.market_prob_home - actual) ** 2;
    }
  }

  const n = rows.length;
  return {
    resolved: n,
    pending,
    accuracy: hits / n,
    brier: Number((brier / n).toFixed(4)),
    logLoss: Number((logLoss / n).toFixed(4)),
    marginMae: marginN ? Number((marginAbs / marginN).toFixed(2)) : null,
    marginBias: marginN ? Number((marginSigned / marginN).toFixed(2)) : null,
    totalMae: totalN ? Number((totalAbs / totalN).toFixed(2)) : null,
    calibration: bands
      .filter((b) => b.n > 0)
      .map((b) => ({
        label: b.label,
        n: b.n,
        predicted: Number((b.predicted / b.n).toFixed(3)),
        observed: Number((b.observed / b.n).toFixed(3)),
      })),
    byReliability: [...byLevel.entries()].map(([level, c]) => ({
      level,
      n: c.n,
      accuracy: Number((c.hits / c.n).toFixed(3)),
      brier: Number((c.brier / c.n).toFixed(4)),
    })),
    vsMarket: mN
      ? {
          n: mN,
          modelAccuracy: Number((mModelHits / mN).toFixed(3)),
          marketAccuracy: Number((mMarketHits / mN).toFixed(3)),
          modelBrier: Number((mModelBrier / mN).toFixed(4)),
          marketBrier: Number((mMarketBrier / mN).toFixed(4)),
        }
      : null,
    recent: rows.slice(0, 10).map((r) => ({
      league: r.league,
      date: r.commence_time,
      home: r.home_name,
      away: r.away_name,
      probHome: r.prob_home,
      homePoints: r.home_points,
      awayPoints: r.away_points,
      hit:
        (r.prob_home >= 0.5 && r.home_points >= r.away_points) ||
        (r.prob_home < 0.5 && r.home_points <= r.away_points),
      reliability: r.reliability,
    })),
  };
}

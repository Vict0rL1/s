// The baseball track record: how the app has actually done on games YOU looked
// at, as opposed to how the model scores on history.
//
// Same contract as the other three sports: the prediction is written the FIRST
// time it is served, before the game, and never rewritten — so it cannot drift
// toward whatever the closing line ended up saying. Demo fixtures are excluded.
//
// Baseball needs one extra column the others do not: which STARTER the forecast
// assumed. A prediction made before the probables were announced is a different
// object from one made after, and lumping them together would hide the single
// biggest source of error the app has.

import { getDb } from '../db.ts';
import type { BsbPrediction } from './predict.ts';
import type { BsbUpcomingRow } from './types.ts';

/** Scheduled first pitch can slip a day across time zones; allow a window. */
const RESOLVE_WINDOW_DAYS = 3;

export interface BaseballTrackRecord {
  resolved: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  /** Mean absolute error of the predicted run total. */
  totalMae: number | null;
  /** Positive = the model expected more runs than were scored. */
  totalBias: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  byReliability: { level: string; n: number; accuracy: number | null; brier: number | null }[];
  /** Split by whether the starting pitchers were known when the call was made. */
  byStarterKnown: { known: boolean; n: number; accuracy: number | null; brier: number | null }[];
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
    homeRuns: number | null;
    awayRuns: number | null;
    hit: boolean;
    reliability: string | null;
  }[];
}

const ymdOf = (iso: string | null): string => {
  const d = iso ? new Date(iso) : new Date();
  const use = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${use.getUTCFullYear()}${String(use.getUTCMonth() + 1).padStart(2, '0')}${String(
    use.getUTCDate(),
  ).padStart(2, '0')}`;
};

export function matchKey(row: BsbUpcomingRow): string {
  return `${row.league}|${row.away_id}|${row.home_id}|${ymdOf(row.commence_time)}`;
}

/**
 * Record a prediction, once.
 *
 * ON CONFLICT DO NOTHING is the whole point: serving the same game twice must not
 * overwrite what was said the first time, or the track record becomes a record of
 * the app's most recent opinion rather than of its forecasts.
 */
export function logBaseballPrediction(row: BsbUpcomingRow, prediction: BsbPrediction): void {
  if (!row.home_id || !row.away_id) return;
  getDb()
    .prepare(
      `INSERT INTO bsb_prediction_log
         (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
          home_sp, away_sp, prob_home, market_prob_home, expected_home_runs, expected_away_runs,
          reliability, predicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_key) DO NOTHING`,
    )
    .run(
      matchKey(row),
      row.league,
      row.id,
      row.commence_time,
      row.home_id,
      row.away_id,
      prediction.teams.home.name,
      prediction.teams.away.name,
      prediction.teams.home.starter.id,
      prediction.teams.away.starter.id,
      prediction.model.home,
      prediction.market.market?.home ?? null,
      prediction.runs.expectedHome,
      prediction.runs.expectedAway,
      prediction.reliability.level,
      new Date().toISOString(),
    );
}

/** Attach real results to logged predictions once the games have been ingested. */
export function resolveBaseballPredictions(): { resolved: number } {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT match_key, league, home_id, away_id, commence_time
       FROM bsb_prediction_log WHERE resolved_at IS NULL`,
    )
    .all() as unknown as {
    match_key: string;
    league: string;
    home_id: string;
    away_id: string;
    commence_time: string | null;
  }[];

  const find = db.prepare(
    `SELECT id, game_date, home_runs, away_runs FROM bsb_games
     WHERE league = ? AND home_id = ? AND away_id = ?
       AND game_date BETWEEN ? AND ?
     ORDER BY game_date`,
  );
  const update = db.prepare(
    `UPDATE bsb_prediction_log
       SET home_runs = ?, away_runs = ?, game_id = ?, resolved_at = ?
     WHERE match_key = ?`,
  );

  const shift = (ymd: string, days: number): string => {
    const d = new Date(
      Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days),
    );
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
  };

  let resolved = 0;
  const now = new Date().toISOString();
  for (const p of pending) {
    const target = ymdOf(p.commence_time);
    const rows = find.all(
      p.league,
      p.home_id,
      p.away_id,
      shift(target, -1),
      shift(target, RESOLVE_WINDOW_DAYS),
    ) as unknown as { id: number; game_date: string; home_runs: number; away_runs: number }[];
    if (rows.length === 0) continue;
    // Closest to the scheduled date wins — doubleheaders and postponements mean
    // "the first row that matches" is not good enough.
    const best = rows.reduce((a, b) =>
      Math.abs(Number(a.game_date) - Number(target)) <= Math.abs(Number(b.game_date) - Number(target))
        ? a
        : b,
    );
    update.run(best.home_runs, best.away_runs, best.id, now, p.match_key);
    resolved++;
  }
  return { resolved };
}

export function getBaseballTrackRecord(league?: string): BaseballTrackRecord {
  const db = getDb();
  const where = league ? 'WHERE league = ?' : '';
  const params = league ? [league] : [];
  const rows = db
    .prepare(
      `SELECT league, commence_time, home_name, away_name, home_sp, away_sp,
              prob_home, market_prob_home, expected_home_runs, expected_away_runs,
              reliability, home_runs, away_runs, resolved_at
       FROM bsb_prediction_log ${where} ORDER BY commence_time DESC`,
    )
    .all(...params) as unknown as {
    league: string;
    commence_time: string | null;
    home_name: string | null;
    away_name: string | null;
    home_sp: string | null;
    away_sp: string | null;
    prob_home: number;
    market_prob_home: number | null;
    expected_home_runs: number | null;
    expected_away_runs: number | null;
    reliability: string | null;
    home_runs: number | null;
    away_runs: number | null;
    resolved_at: string | null;
  }[];

  const done = rows.filter((r) => r.resolved_at && r.home_runs != null && r.away_runs != null);
  const pending = rows.length - done.length;

  if (done.length === 0) {
    return {
      resolved: 0,
      pending,
      accuracy: null,
      brier: null,
      logLoss: null,
      totalMae: null,
      totalBias: null,
      calibration: [],
      byReliability: [],
      byStarterKnown: [],
      vsMarket: null,
      recent: rows.slice(0, 15).map((r) => ({
        league: r.league,
        date: r.commence_time,
        home: r.home_name,
        away: r.away_name,
        probHome: r.prob_home,
        homeRuns: r.home_runs,
        awayRuns: r.away_runs,
        hit: false,
        reliability: r.reliability,
      })),
    };
  }

  let hits = 0;
  let brier = 0;
  let logLoss = 0;
  let totalErr = 0;
  let totalSigned = 0;
  let totalN = 0;
  const bands = new Map<string, { n: number; pred: number; obs: number }>();
  const byRel = new Map<string, { n: number; hits: number; brier: number }>();
  const byStarter = new Map<string, { n: number; hits: number; brier: number }>();
  let mkN = 0;
  let mkModelHits = 0;
  let mkMarketHits = 0;
  let mkModelBrier = 0;
  let mkMarketBrier = 0;

  for (const r of done) {
    const homeWon = (r.home_runs as number) > (r.away_runs as number) ? 1 : 0;
    const p = r.prob_home;
    const hit = (p >= 0.5 ? 1 : 0) === homeWon;
    if (hit) hits++;
    brier += (p - homeWon) ** 2;
    logLoss += -Math.log(Math.max(homeWon ? p : 1 - p, 1e-15));

    if (r.expected_home_runs != null && r.expected_away_runs != null) {
      const expected = r.expected_home_runs + r.expected_away_runs;
      const actual = (r.home_runs as number) + (r.away_runs as number);
      totalErr += Math.abs(expected - actual);
      totalSigned += expected - actual;
      totalN++;
    }

    const lo = Math.max(0.25, Math.min(0.7, Math.floor(p * 10) / 10));
    const key = `${(lo * 100).toFixed(0)}–${((lo + 0.1) * 100).toFixed(0)}%`;
    const b = bands.get(key) ?? { n: 0, pred: 0, obs: 0 };
    b.n++;
    b.pred += p;
    b.obs += homeWon;
    bands.set(key, b);

    const rel = r.reliability ?? 'unknown';
    const rb = byRel.get(rel) ?? { n: 0, hits: 0, brier: 0 };
    rb.n++;
    if (hit) rb.hits++;
    rb.brier += (p - homeWon) ** 2;
    byRel.set(rel, rb);

    const known = r.home_sp && r.away_sp ? 'known' : 'unknown';
    const sb = byStarter.get(known) ?? { n: 0, hits: 0, brier: 0 };
    sb.n++;
    if (hit) sb.hits++;
    sb.brier += (p - homeWon) ** 2;
    byStarter.set(known, sb);

    if (r.market_prob_home != null) {
      mkN++;
      if ((p >= 0.5 ? 1 : 0) === homeWon) mkModelHits++;
      if ((r.market_prob_home >= 0.5 ? 1 : 0) === homeWon) mkMarketHits++;
      mkModelBrier += (p - homeWon) ** 2;
      mkMarketBrier += (r.market_prob_home - homeWon) ** 2;
    }
  }

  const n = done.length;
  return {
    resolved: n,
    pending,
    accuracy: hits / n,
    brier: brier / n,
    logLoss: logLoss / n,
    totalMae: totalN > 0 ? totalErr / totalN : null,
    totalBias: totalN > 0 ? totalSigned / totalN : null,
    calibration: [...bands.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, b]) => ({ label, n: b.n, predicted: b.pred / b.n, observed: b.obs / b.n })),
    byReliability: [...byRel.entries()].map(([level, b]) => ({
      level,
      n: b.n,
      accuracy: b.hits / b.n,
      brier: b.brier / b.n,
    })),
    byStarterKnown: [...byStarter.entries()].map(([k, b]) => ({
      known: k === 'known',
      n: b.n,
      accuracy: b.hits / b.n,
      brier: b.brier / b.n,
    })),
    vsMarket:
      mkN > 0
        ? {
            n: mkN,
            modelAccuracy: mkModelHits / mkN,
            marketAccuracy: mkMarketHits / mkN,
            modelBrier: mkModelBrier / mkN,
            marketBrier: mkMarketBrier / mkN,
          }
        : null,
    recent: rows.slice(0, 15).map((r) => ({
      league: r.league,
      date: r.commence_time,
      home: r.home_name,
      away: r.away_name,
      probHome: r.prob_home,
      homeRuns: r.home_runs,
      awayRuns: r.away_runs,
      hit:
        r.home_runs != null && r.away_runs != null
          ? (r.prob_home >= 0.5 ? 1 : 0) === (r.home_runs > r.away_runs ? 1 : 0)
          : false,
      reliability: r.reliability,
    })),
  };
}

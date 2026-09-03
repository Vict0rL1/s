// The basketball track record: how the app has actually done on games YOU looked
// at, as opposed to how the model scores on history.
//
// Same contract as the tennis version (see ../trackRecord.ts): the prediction is
// written the first time it is served, before the game, and never rewritten — so
// it cannot drift toward whatever the closing odds ended up saying. Demo fixtures
// are excluded, because scoring the app against games that will never be played
// would make the number meaningless.
//
// One thing this can measure that tennis cannot: SPREAD accuracy. Basketball
// predictions carry an expected margin, so once the final score arrives we can
// report how far off that margin was — the figure that matters if you look at
// the handicap rather than the moneyline.

import { getDb } from '../db.ts';
import type { GamePrediction } from './predict.ts';
import type { UpcomingGameRow } from './types.ts';

/** Scheduled tip-off can slip a day across time zones; allow a small window. */
const RESOLVE_WINDOW_DAYS = 3;

export interface BasketballTrackRecord {
  resolved: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  /** Mean absolute error of the predicted margin, in points. */
  marginMae: number | null;
  /** Mean signed error: positive means the home team was over-favoured. */
  marginBias: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  byReliability: { level: string; n: number; accuracy: number | null; brier: number | null }[];
  vsMarket: {
    n: number;
    modelAccuracy: number | null;
    marketAccuracy: number | null;
    modelBrier: number | null;
    marketBrier: number | null;
    disagreements: number;
    modelRightOnDisagreement: number | null;
  } | null;
  recent: {
    league: string;
    date: string | null;
    home: string | null;
    away: string | null;
    probHome: number;
    predictedMargin: number | null;
    homePts: number | null;
    awayPts: number | null;
    hit: boolean;
    reliability: string | null;
  }[];
}

const ymdOf = (iso: string | null): string => {
  const d = iso ? new Date(iso) : new Date();
  const use = Number.isNaN(d.getTime()) ? new Date() : d;
  return (
    `${use.getUTCFullYear()}` +
    `${String(use.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(use.getUTCDate()).padStart(2, '0')}`
  );
};

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  return (
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  );
}

/** Stable identity for a fixture, independent of the odds feed's event id. */
function gameKey(league: string, homeId: string, awayId: string, commence: string | null): string {
  return `${league}|${homeId}|${awayId}|${ymdOf(commence)}`;
}

/** Record a basketball prediction about to be shown. Write-once, idempotent. */
export function logGamePrediction(row: UpcomingGameRow, prediction: GamePrediction): void {
  if (!row.home_id || !row.away_id) return;
  try {
    getDb()
      .prepare(
        `INSERT INTO bb_prediction_log (
           game_key, league, upcoming_id, commence_time, home_id, away_id,
           home_name, away_name, prob_home, market_prob_home, predicted_margin,
           reliability, predicted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_key) DO NOTHING`,
      )
      .run(
        gameKey(row.league, row.home_id, row.away_id, row.commence_time),
        row.league,
        row.id,
        row.commence_time ?? null,
        row.home_id,
        row.away_id,
        prediction.teams.home.name,
        prediction.teams.away.name,
        prediction.model.probHome,
        prediction.market.market?.implied1 ?? null,
        prediction.projection.margin,
        prediction.reliability.level,
        new Date().toISOString(),
      );
  } catch {
    // Logging is a side benefit, never a reason to fail serving a prediction.
  }
}

/** Score pending predictions against results now present in bb_games. */
export function resolveGamePredictions(): { resolved: number } {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT game_key, league, home_id, away_id, commence_time
       FROM bb_prediction_log WHERE resolved_at IS NULL`,
    )
    .all() as unknown as {
    game_key: string;
    league: string;
    home_id: string;
    away_id: string;
    commence_time: string | null;
  }[];
  if (pending.length === 0) return { resolved: 0 };

  const find = db.prepare(
    `SELECT id, home_pts, away_pts FROM bb_games
     WHERE league = ? AND home_id = ? AND away_id = ?
       AND game_date >= ? AND game_date <= ?
     ORDER BY ABS(CAST(game_date AS INTEGER) - CAST(? AS INTEGER)) ASC
     LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE bb_prediction_log
     SET home_pts = ?, away_pts = ?, game_id = ?, resolved_at = ?
     WHERE game_key = ?`,
  );

  let resolved = 0;
  const now = new Date().toISOString();
  for (const p of pending) {
    const target = ymdOf(p.commence_time);
    const hit = find.get(
      p.league,
      p.home_id,
      p.away_id,
      shiftYmd(target, -RESOLVE_WINDOW_DAYS),
      shiftYmd(target, RESOLVE_WINDOW_DAYS),
      target,
    ) as unknown as { id: number; home_pts: number; away_pts: number } | undefined;
    if (!hit) continue;
    update.run(hit.home_pts, hit.away_pts, hit.id, now, p.game_key);
    resolved++;
  }
  return { resolved };
}

interface ScoredRow {
  league: string;
  commence_time: string | null;
  home_name: string | null;
  away_name: string | null;
  prob_home: number;
  market_prob_home: number | null;
  predicted_margin: number | null;
  reliability: string | null;
  home_pts: number;
  away_pts: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function accuracyOf(pairs: { p: number; won: boolean }[]): number | null {
  if (pairs.length === 0) return null;
  let hits = 0;
  for (const { p, won } of pairs) {
    if (p === 0.5) hits += 0.5;
    else if (p > 0.5 === won) hits += 1;
  }
  return round4(hits / pairs.length);
}

function brierOf(pairs: { p: number; won: boolean }[]): number | null {
  if (pairs.length === 0) return null;
  return round4(pairs.reduce((a, { p, won }) => a + (p - (won ? 1 : 0)) ** 2, 0) / pairs.length);
}

/** Live track record for basketball, optionally restricted to one league. */
export function getBasketballTrackRecord(league?: string): BasketballTrackRecord {
  const db = getDb();
  const where = league ? 'AND league = ?' : '';
  const params = league ? [league] : [];

  const pending = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM bb_prediction_log WHERE resolved_at IS NULL ${where}`)
      .get(...params) as unknown as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT league, commence_time, home_name, away_name, prob_home, market_prob_home,
              predicted_margin, reliability, home_pts, away_pts
       FROM bb_prediction_log
       WHERE resolved_at IS NOT NULL ${where}
       ORDER BY commence_time DESC`,
    )
    .all(...params) as unknown as ScoredRow[];

  const empty: BasketballTrackRecord = {
    resolved: 0,
    pending,
    accuracy: null,
    brier: null,
    logLoss: null,
    marginMae: null,
    marginBias: null,
    calibration: [],
    byReliability: [],
    vsMarket: null,
    recent: [],
  };
  if (rows.length === 0) return empty;

  const pairs = rows.map((r) => ({ p: r.prob_home, won: r.home_pts > r.away_pts }));

  const logLoss =
    pairs.reduce((acc, { p, won }) => {
      const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
      return acc - (won ? Math.log(q) : Math.log(1 - q));
    }, 0) / pairs.length;

  // Spread accuracy: only over rows that actually stored a predicted margin.
  const withMargin = rows.filter((r) => r.predicted_margin != null);
  const marginMae = withMargin.length
    ? round4(
        withMargin.reduce(
          (a, r) => a + Math.abs((r.predicted_margin as number) - (r.home_pts - r.away_pts)),
          0,
        ) / withMargin.length,
      )
    : null;
  const marginBias = withMargin.length
    ? round4(
        withMargin.reduce(
          (a, r) => a + ((r.predicted_margin as number) - (r.home_pts - r.away_pts)),
          0,
        ) / withMargin.length,
      )
    : null;

  const bandDefs = [
    { label: '50–60%', lo: 0.5, hi: 0.6 },
    { label: '60–70%', lo: 0.6, hi: 0.7 },
    { label: '70–80%', lo: 0.7, hi: 0.8 },
    { label: '80–90%', lo: 0.8, hi: 0.9 },
    { label: '90–100%', lo: 0.9, hi: 1.01 },
  ];
  const calibration: BasketballTrackRecord['calibration'] = [];
  for (const b of bandDefs) {
    const inBand = pairs
      .map(({ p, won }) => (p >= 0.5 ? { p, won } : { p: 1 - p, won: !won }))
      .filter(({ p }) => p >= b.lo && p < b.hi);
    if (inBand.length === 0) continue;
    calibration.push({
      label: b.label,
      n: inBand.length,
      predicted: round4(inBand.reduce((a, x) => a + x.p, 0) / inBand.length),
      observed: round4(inBand.filter((x) => x.won).length / inBand.length),
    });
  }

  const byReliability: BasketballTrackRecord['byReliability'] = [];
  for (const level of ['high', 'medium', 'low']) {
    const subset = rows
      .filter((r) => r.reliability === level)
      .map((r) => ({ p: r.prob_home, won: r.home_pts > r.away_pts }));
    if (subset.length === 0) continue;
    byReliability.push({
      level,
      n: subset.length,
      accuracy: accuracyOf(subset),
      brier: brierOf(subset),
    });
  }

  const withMarket = rows.filter((r) => r.market_prob_home != null);
  const vsMarket = withMarket.length
    ? (() => {
        const model = withMarket.map((r) => ({ p: r.prob_home, won: r.home_pts > r.away_pts }));
        const market = withMarket.map((r) => ({
          p: r.market_prob_home as number,
          won: r.home_pts > r.away_pts,
        }));
        const disagree = withMarket.filter(
          (r) => r.prob_home > 0.5 !== (r.market_prob_home as number) > 0.5,
        );
        const modelRight = disagree.filter((r) => r.prob_home > 0.5 === r.home_pts > r.away_pts);
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
    marginMae,
    marginBias,
    calibration,
    byReliability,
    vsMarket,
    recent: rows.slice(0, 20).map((r) => {
      const homeWon = r.home_pts > r.away_pts;
      return {
        league: r.league,
        date: r.commence_time,
        home: r.home_name,
        away: r.away_name,
        probHome: r.prob_home,
        predictedMargin: r.predicted_margin,
        homePts: r.home_pts,
        awayPts: r.away_pts,
        hit: r.prob_home === 0.5 ? false : r.prob_home > 0.5 === homeWon,
        reliability: r.reliability,
      };
    }),
  };
}

// The football track record: how the app has done on fixtures YOU looked at.
//
// Same write-once contract as the other two sports. What is different is the
// scoring: a 1X2 forecast must be judged with the Ranked Probability Score, not
// accuracy — a model that never predicts a draw can post a respectable "hit rate"
// while being useless about the outcome that happens a quarter of the time.

import { getDb } from '../db.ts';
import { rankedProbabilityScore, impliedFrom1X2 } from './model.ts';
import type { FbPrediction } from './predict.ts';
import type { FbUpcomingRow } from './types.ts';

const RESOLVE_WINDOW_DAYS = 3;

export interface FootballTrackRecord {
  resolved: number;
  pending: number;
  /** Share where the model's most likely outcome happened. */
  accuracy: number | null;
  rps: number | null;
  logLoss: number | null;
  /** Did the app call draws at the rate they actually occur? */
  draws: { predicted: number; actual: number; meanProbability: number | null } | null;
  byReliability: { level: string; n: number; accuracy: number | null; rps: number | null }[];
  vsMarket: {
    n: number;
    modelRps: number | null;
    marketRps: number | null;
    modelAccuracy: number | null;
    marketAccuracy: number | null;
  } | null;
  recent: {
    league: string;
    date: string | null;
    home: string | null;
    away: string | null;
    probs: { home: number; draw: number; away: number };
    homeGoals: number | null;
    awayGoals: number | null;
    hit: boolean;
    reliability: string | null;
  }[];
}

const ymdOf = (iso: string | null): string => {
  const d = iso ? new Date(iso) : new Date();
  const u = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${u.getUTCFullYear()}${String(u.getUTCMonth() + 1).padStart(2, '0')}${String(u.getUTCDate()).padStart(2, '0')}`;
};

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function logFootballPrediction(row: FbUpcomingRow, p: FbPrediction): void {
  if (!row.home_id || !row.away_id) return;
  const key = `${row.league}|${row.home_id}|${row.away_id}|${ymdOf(row.commence_time)}`;
  const implied =
    row.odds_home && row.odds_draw && row.odds_away
      ? impliedFrom1X2(row.odds_home, row.odds_draw, row.odds_away)
      : null;
  try {
    getDb()
      .prepare(
        `INSERT INTO fb_prediction_log (
           match_key, league, upcoming_id, commence_time, home_id, away_id,
           home_name, away_name, prob_home, prob_draw, prob_away,
           market_prob_home, market_prob_draw, market_prob_away,
           expected_home_goals, expected_away_goals, reliability, predicted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_key) DO NOTHING`,
      )
      .run(
        key, row.league, row.id, row.commence_time ?? null, row.home_id, row.away_id,
        p.teams.home.name, p.teams.away.name,
        p.model.home, p.model.draw, p.model.away,
        implied?.home ?? null, implied?.draw ?? null, implied?.away ?? null,
        p.goals.expectedHome, p.goals.expectedAway,
        p.reliability.level, new Date().toISOString(),
      );
  } catch {
    // Logging must never break serving a prediction.
  }
}

export function resolveFootballPredictions(): { resolved: number } {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT match_key, league, home_id, away_id, commence_time
       FROM fb_prediction_log WHERE resolved_at IS NULL`,
    )
    .all() as unknown as {
    match_key: string; league: string; home_id: string; away_id: string; commence_time: string | null;
  }[];
  if (pending.length === 0) return { resolved: 0 };

  const find = db.prepare(
    `SELECT id, home_goals, away_goals FROM fb_matches
     WHERE league = ? AND home_id = ? AND away_id = ?
       AND match_date >= ? AND match_date <= ?
     ORDER BY ABS(CAST(match_date AS INTEGER) - CAST(? AS INTEGER)) ASC LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE fb_prediction_log SET home_goals = ?, away_goals = ?, match_id = ?, resolved_at = ?
     WHERE match_key = ?`,
  );

  let resolved = 0;
  const now = new Date().toISOString();
  for (const p of pending) {
    const target = ymdOf(p.commence_time);
    const hit = find.get(
      p.league, p.home_id, p.away_id,
      shiftYmd(target, -RESOLVE_WINDOW_DAYS), shiftYmd(target, RESOLVE_WINDOW_DAYS), target,
    ) as unknown as { id: number; home_goals: number; away_goals: number } | undefined;
    if (!hit) continue;
    update.run(hit.home_goals, hit.away_goals, hit.id, now, p.match_key);
    resolved++;
  }
  return { resolved };
}

interface Row {
  league: string; commence_time: string | null; home_name: string | null; away_name: string | null;
  prob_home: number; prob_draw: number; prob_away: number;
  market_prob_home: number | null; market_prob_draw: number | null; market_prob_away: number | null;
  reliability: string | null; home_goals: number; away_goals: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const outcomeOf = (h: number, a: number): 'H' | 'D' | 'A' => (h > a ? 'H' : h === a ? 'D' : 'A');
const topOf = (p: { home: number; draw: number; away: number }): 'H' | 'D' | 'A' =>
  p.home >= p.draw && p.home >= p.away ? 'H' : p.draw >= p.away ? 'D' : 'A';

export function getFootballTrackRecord(league?: string): FootballTrackRecord {
  const db = getDb();
  const where = league ? 'AND league = ?' : '';
  const params = league ? [league] : [];

  const pending = (
    db.prepare(`SELECT COUNT(*) AS c FROM fb_prediction_log WHERE resolved_at IS NULL ${where}`)
      .get(...params) as unknown as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT league, commence_time, home_name, away_name, prob_home, prob_draw, prob_away,
              market_prob_home, market_prob_draw, market_prob_away, reliability,
              home_goals, away_goals
       FROM fb_prediction_log WHERE resolved_at IS NOT NULL ${where}
       ORDER BY commence_time DESC`,
    )
    .all(...params) as unknown as Row[];

  const empty: FootballTrackRecord = {
    resolved: 0, pending, accuracy: null, rps: null, logLoss: null, draws: null,
    byReliability: [], vsMarket: null, recent: [],
  };
  if (rows.length === 0) return empty;

  let correct = 0;
  let rps = 0;
  let logloss = 0;
  let drawsPredicted = 0;
  let drawsActual = 0;
  let drawProbSum = 0;
  for (const r of rows) {
    const probs = { home: r.prob_home, draw: r.prob_draw, away: r.prob_away };
    const actual = outcomeOf(r.home_goals, r.away_goals);
    const top = topOf(probs);
    if (top === actual) correct++;
    if (top === 'D') drawsPredicted++;
    if (actual === 'D') drawsActual++;
    drawProbSum += r.prob_draw;
    rps += rankedProbabilityScore(probs, actual);
    const pActual = actual === 'H' ? probs.home : actual === 'D' ? probs.draw : probs.away;
    logloss += -Math.log(Math.max(pActual, 1e-15));
  }

  const byReliability: FootballTrackRecord['byReliability'] = [];
  for (const level of ['high', 'medium', 'low']) {
    const subset = rows.filter((r) => r.reliability === level);
    if (subset.length === 0) continue;
    let c = 0;
    let s = 0;
    for (const r of subset) {
      const probs = { home: r.prob_home, draw: r.prob_draw, away: r.prob_away };
      const actual = outcomeOf(r.home_goals, r.away_goals);
      if (topOf(probs) === actual) c++;
      s += rankedProbabilityScore(probs, actual);
    }
    byReliability.push({
      level, n: subset.length, accuracy: round4(c / subset.length), rps: round4(s / subset.length),
    });
  }

  const withMarket = rows.filter((r) => r.market_prob_home != null);
  const vsMarket = withMarket.length
    ? (() => {
        let mr = 0; let kr = 0; let mc = 0; let kc = 0;
        for (const r of withMarket) {
          const probs = { home: r.prob_home, draw: r.prob_draw, away: r.prob_away };
          const mk = {
            home: r.market_prob_home as number,
            draw: r.market_prob_draw as number,
            away: r.market_prob_away as number,
          };
          const actual = outcomeOf(r.home_goals, r.away_goals);
          mr += rankedProbabilityScore(probs, actual);
          kr += rankedProbabilityScore(mk, actual);
          if (topOf(probs) === actual) mc++;
          if (topOf(mk) === actual) kc++;
        }
        const n = withMarket.length;
        return {
          n,
          modelRps: round4(mr / n), marketRps: round4(kr / n),
          modelAccuracy: round4(mc / n), marketAccuracy: round4(kc / n),
        };
      })()
    : null;

  return {
    resolved: rows.length,
    pending,
    accuracy: round4(correct / rows.length),
    rps: round4(rps / rows.length),
    logLoss: round4(logloss / rows.length),
    draws: {
      predicted: drawsPredicted,
      actual: drawsActual,
      meanProbability: round4(drawProbSum / rows.length),
    },
    byReliability,
    vsMarket,
    recent: rows.slice(0, 20).map((r) => {
      const probs = { home: r.prob_home, draw: r.prob_draw, away: r.prob_away };
      return {
        league: r.league,
        date: r.commence_time,
        home: r.home_name,
        away: r.away_name,
        probs,
        homeGoals: r.home_goals,
        awayGoals: r.away_goals,
        hit: topOf(probs) === outcomeOf(r.home_goals, r.away_goals),
        reliability: r.reliability,
      };
    }),
  };
}

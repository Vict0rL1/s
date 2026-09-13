// Park factors: how much the STADIUM moves the run total.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
// `site` had been sitting in bsb_games for all 37,262 games and nothing read it.
// The model's own disclaimer admitted the gap — "ni el clima ni las dimensiones
// del estadio" — while the column naming the stadium was right there. Same shape
// as the NFL quarterback: not new data to find, data already downloaded and unused.
//
// Baseball is the sport where the venue matters most, and it is not a small
// correction. Measured over the full archive, controlling for who plays there:
//
//     DEN02  Coors Field       ×1.228     +23 %
//     ARL02  Globe Life         ×1.115
//     BOS07  Fenway Park        ×1.081
//     ...
//     SAN02  Petco Park         ×0.916
//     STP01  Tropicana Field    ×0.914
//     SEA03  T-Mobile Park      ×0.904     −10 %
//
// 2.89 runs between the extremes, on a total of about 8.9 — and the over/under
// line moves in half-runs. The measurement recovers the known hierarchy of
// hitters' and pitchers' parks on its own, which is the strongest evidence that it
// is picking up the ballpark and not noise.
//
// ===========================================================================
// WHAT THE VALIDATION SAYS
// ===========================================================================
// Fitted on seasons before a cut, scored on the seasons after it, six cut points
// from 2014 to 2024: ALL SIX improve. +0.0083 nats per game at the earliest cut
// down to +0.0047 at the latest, and the over/under Brier at the 8.5 line goes
// 0.24899 → 0.24738.
//
// The interesting part is WHERE the gain lives, because it is not spread evenly:
//
//     estadios extremos altos (>1.06)   n=1950   +0.05228   ← 7× the average
//     algo altos (1.02–1.06)            n=3505   −0.00309
//     neutros (0.98–1.02)               n=4793   +0.00019   ← nothing, correctly
//     algo bajos (0.94–0.98)            n=4681   +0.00168
//     extremos bajos (<0.94)            n=2896   +0.01205
//
// So the honest claim is not "the model got smarter". It is that the model stopped
// being wrong in Denver. At a neutral park the factor is ~1 and changes nothing,
// which is exactly what it should do.

import { getDb } from '../db.ts';
import type { LeagueId } from './types.ts';

/**
 * Shrinkage constant, in games hosted.
 *
 * A park with 60 games sits most of the way back at neutral; one with 1,200 keeps
 * nearly its raw ratio. Without it, a park that happened to host one wild series
 * arrives in the model claiming +40 %.
 *
 * 300 ≈ two seasons of home games (81 a year) plus change, and it measured best or
 * within noise of best at every cut point in the sweep (100 / 200 / 300 / 600 /
 * 1200). Not a tuned number so much as the middle of a flat optimum.
 */
export const PARK_SHRINK_GAMES = 300;

/**
 * Bounds on the factor.
 *
 * Coors, the most extreme park in the archive, measures 1.228 — so 1.35 leaves
 * real headroom while refusing anything a ballpark cannot plausibly do. A guard
 * against a data error (a park with three games in the table), not a modelling
 * choice.
 */
const MIN_FACTOR = 0.75;
const MAX_FACTOR = 1.35;

/** Accumulator for one park: what happened there vs what the model expected. */
export interface ParkAccumulator {
  observed: number;
  expected: number;
  games: number;
}

/**
 * Turn accumulated observations into factors, relative to an average park.
 *
 * Dividing by the league-wide ratio matters: without it, any overall bias in the
 * model's run level would be absorbed into every park factor at once, and the
 * numbers would stop meaning "this stadium versus a normal one".
 */
export function factorsFrom(acc: Map<string, ParkAccumulator>): Map<string, number> {
  let allObserved = 0;
  let allExpected = 0;
  for (const a of acc.values()) {
    allObserved += a.observed;
    allExpected += a.expected;
  }
  if (!(allExpected > 0)) return new Map();
  const league = allObserved / allExpected;

  const out = new Map<string, number>();
  for (const [site, a] of acc) {
    if (!(a.expected > 0) || a.games < 1) continue;
    const raw = a.observed / a.expected / league;
    const shrunk = 1 + (raw - 1) * (a.games / (a.games + PARK_SHRINK_GAMES));
    out.set(site, Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, shrunk)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
export function storeParkFactors(
  league: LeagueId,
  factors: Map<string, number>,
  acc: Map<string, ParkAccumulator>,
): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO bsb_park_factors (league, site, factor, games, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (league, site) DO UPDATE SET
       factor = excluded.factor, games = excluded.games, updated_at = excluded.updated_at`,
  );
  const stamp = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM bsb_park_factors WHERE league = ?').run(league);
    for (const [site, factor] of factors) {
      ins.run(league, site, factor, acc.get(site)?.games ?? 0, stamp);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return factors.size;
}

export interface ParkFactor {
  site: string;
  /** Human name where known ("Coors Field"), else the Retrosheet id. */
  name: string;
  factor: number;
  games: number;
}

/**
 * The factor for one park, or null when it is unknown.
 *
 * Null and not 1: "we have never seen this stadium" and "this stadium is average"
 * are different statements, and the card says so rather than quietly asserting
 * neutrality.
 */
export function getParkFactor(league: LeagueId, site: string | null): ParkFactor | null {
  if (!site) return null;
  const row = getDb()
    .prepare('SELECT site, factor, games FROM bsb_park_factors WHERE league = ? AND site = ?')
    .get(league, site) as unknown as { site: string; factor: number; games: number } | undefined;
  if (!row) return null;
  return { ...row, name: PARK_NAMES[row.site] ?? row.site };
}

export function listParkFactors(league: LeagueId): ParkFactor[] {
  const rows = getDb()
    .prepare(
      'SELECT site, factor, games FROM bsb_park_factors WHERE league = ? ORDER BY factor DESC',
    )
    .all(league) as unknown as { site: string; factor: number; games: number }[];
  return rows.map((r) => ({ ...r, name: PARK_NAMES[r.site] ?? r.site }));
}

/**
 * Which park a team plays its home games in.
 *
 * Read from the schedule rather than configured, and from RECENT games only, so a
 * team that moved stadium is followed automatically instead of needing an edit —
 * which matters here, because three of the 30 clubs changed park inside the span
 * of this archive.
 */
export function getHomePark(league: LeagueId, teamId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT site, COUNT(*) AS n FROM bsb_games
        WHERE league = ? AND home_id = ? AND site IS NOT NULL
          AND season >= (SELECT MAX(season) - 1 FROM bsb_games WHERE league = ?)
        GROUP BY site ORDER BY n DESC LIMIT 1`,
    )
    .get(league, teamId, league) as unknown as { site: string } | undefined;
  return row?.site ?? null;
}

/**
 * Retrosheet park ids → the names people use.
 *
 * The 30 current MLB parks plus the recently-vacated ones that still appear in the
 * archive. A missing id falls back to the code, which is ugly but honest; inventing
 * a name would be worse.
 */
const PARK_NAMES: Record<string, string> = {
  ANA01: 'Angel Stadium',
  ARL02: 'Globe Life Field',
  ARL03: 'Globe Life Field',
  ATL02: 'Turner Field',
  ATL03: 'Truist Park',
  BAL12: 'Oriole Park at Camden Yards',
  BOS07: 'Fenway Park',
  CHI11: 'Wrigley Field',
  CHI12: 'Guaranteed Rate Field',
  CIN09: 'Great American Ball Park',
  CLE08: 'Progressive Field',
  DEN02: 'Coors Field',
  DET05: 'Comerica Park',
  HOU03: 'Minute Maid Park',
  KAN06: 'Kauffman Stadium',
  LOS03: 'Dodger Stadium',
  MIA02: 'loanDepot Park',
  MIL06: 'American Family Field',
  MIN04: 'Target Field',
  NYC20: 'Citi Field',
  NYC21: 'Yankee Stadium',
  OAK01: 'Oakland Coliseum',
  PHI13: 'Citizens Bank Park',
  PHO01: 'Chase Field',
  PIT08: 'PNC Park',
  SAN02: 'Petco Park',
  SEA03: 'T-Mobile Park',
  SFO03: 'Oracle Park',
  STL10: 'Busch Stadium',
  STP01: 'Tropicana Field',
  TOR02: 'Rogers Centre',
  WAS11: 'Nationals Park',
};

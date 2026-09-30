// Current-season MLB results from MLB's own public Stats API.
//
// WHY THIS EXISTS
// ---------------
// Retrosheet is authoritative and complete, and it publishes AFTER a season ends.
// On its own that means the app's ratings are permanently a season out of date —
// which for baseball is not a rounding error, it is the difference between rating
// this year's rotation and last year's.
//
// So the two sources split the job the same way football's do:
//
//   Retrosheet     — the deep history the model was fitted and validated on.
//                    Verified game by game (npm run verify:bsb).
//   MLB Stats API  — the season in progress, plus tomorrow's announced starters.
//                    Free, no key, no registration.
//
// Both write into the same table with the same UNIQUE key, so a game that later
// appears in Retrosheet does not duplicate the one taken from the live feed.
//
// VERIFICATION NOTE
// -----------------
// statsapi.mlb.com is not reachable from the environment this was written in
// (only GitHub is), so this client is written to fail loudly and specifically
// rather than quietly: it checks the fields it needs by name and reports which
// ones were missing, instead of ingesting a season of 0-0 games. The parser it
// backs up — Retrosheet — is the one that was validated against real data.

import { getDb } from '../../db.ts';
import { baseballConfig } from '../../config.ts';
import type { LeagueId } from '../types.ts';

/** MLB's own three-letter codes against Retrosheet's, where they differ. */
const MLB_TO_RETROSHEET: Record<string, string> = {
  AZ: 'ARI', CWS: 'CHA', CHC: 'CHN', KC: 'KCA', LAD: 'LAN', LAA: 'ANA',
  NYY: 'NYA', NYM: 'NYN', SD: 'SDN', SF: 'SFN', STL: 'SLN', TB: 'TBA',
  WSH: 'WAS', ATH: 'OAK',
};

function retrosheetCode(abbr: string): string {
  const a = (abbr ?? '').toUpperCase();
  return MLB_TO_RETROSHEET[a] ?? a;
}

export interface LiveIngestResult {
  games: number;
  withStarters: number;
  season: number;
  through: string | null;
}

/**
 * Ingest every completed game of a season.
 *
 * `hydrate=probablePitcher,linescore` gets the score and the starters in one
 * request per date range, which keeps this to a handful of calls for a whole
 * season rather than one per game.
 */
export async function ingestMlbSeason(
  season: number,
  league: LeagueId = 'mlb',
): Promise<LiveIngestResult> {
  const base = baseballConfig.history.mlbStatsApi;
  const url =
    `${base}/schedule?sportId=1&season=${season}` +
    `&startDate=${season}-02-01&endDate=${season}-12-01` +
    `&gameType=R&hydrate=probablePitcher,linescore,decisions`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB Stats API: HTTP ${res.status} (${url})`);
  const data = (await res.json()) as any;
  const dates = data?.dates;
  if (!Array.isArray(dates)) {
    throw new Error(
      'La respuesta de MLB Stats API no trae "dates". ' +
        `Claves recibidas: ${Object.keys(data ?? {}).join(', ') || '(ninguna)'}`,
    );
  }

  const db = getDb();
  const insertTeam = db.prepare(
    `INSERT INTO bsb_teams (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );
  const insertPitcher = db.prepare(
    `INSERT INTO bsb_pitchers (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );
  const insertGame = db.prepare(
    `INSERT INTO bsb_games
       (league, season, game_date, game_number, home_id, away_id, home_runs, away_runs,
        home_sp, away_sp, site)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, game_date, game_number, home_id, away_id) DO UPDATE SET
       home_runs = excluded.home_runs, away_runs = excluded.away_runs,
       home_sp = COALESCE(excluded.home_sp, bsb_games.home_sp),
       away_sp = COALESCE(excluded.away_sp, bsb_games.away_sp)`,
  );

  let games = 0;
  let withStarters = 0;
  let through: string | null = null;
  let skippedNoScore = 0;

  db.exec('BEGIN');
  try {
    for (const day of dates) {
      for (const g of day?.games ?? []) {
        // Only finished regular-season games. A postponed or in-progress game with
        // a 0-0 linescore would otherwise be ingested as a real tie.
        const state = g?.status?.abstractGameState;
        if (state !== 'Final') continue;

        const home = g?.teams?.home;
        const away = g?.teams?.away;
        const homeId = retrosheetCode(home?.team?.abbreviation ?? '');
        const awayId = retrosheetCode(away?.team?.abbreviation ?? '');
        const homeRuns = home?.score;
        const awayRuns = away?.score;
        if (!homeId || !awayId || typeof homeRuns !== 'number' || typeof awayRuns !== 'number') {
          skippedNoScore++;
          continue;
        }

        const date = String(g?.officialDate ?? g?.gameDate ?? '').slice(0, 10).replace(/-/g, '');
        if (!date) continue;
        if (!through || date > through) through = date;

        for (const [id, name] of [
          [homeId, home?.team?.name],
          [awayId, away?.team?.name],
        ] as [string, string | undefined][]) {
          insertTeam.run(id, league, name ?? id);
        }

        // MLB numbers its players; Retrosheet uses its own ids. Prefixing keeps
        // the two id spaces from ever colliding, at the cost of a live-feed
        // pitcher and his Retrosheet record being separate rows until Retrosheet
        // publishes — which is honest, since the two have different histories.
        const spId = (p: any): string | null =>
          p?.id != null ? `mlb${p.id}` : null;
        const homeSp = spId(home?.probablePitcher);
        const awaySp = spId(away?.probablePitcher);
        for (const [id, p] of [
          [homeSp, home?.probablePitcher],
          [awaySp, away?.probablePitcher],
        ] as [string | null, any][]) {
          if (id) insertPitcher.run(id, league, p?.fullName ?? id);
        }
        if (homeSp && awaySp) withStarters++;

        insertGame.run(
          league,
          season,
          date,
          Number(g?.gameNumber ?? 0) > 1 ? Number(g.gameNumber) : 0,
          homeId,
          awayId,
          homeRuns,
          awayRuns,
          homeSp,
          awaySp,
          g?.venue?.name ?? null,
        );
        games++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (games === 0) {
    throw new Error(
      `MLB Stats API devolvió ${dates.length} fechas pero ningún partido terminado para ${season}` +
        (skippedNoScore > 0 ? ` (${skippedNoScore} sin marcador utilizable)` : ''),
    );
  }
  return { games, withStarters, season, through };
}

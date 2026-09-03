// MLB results from Retrosheet event files, mirrored on GitHub by the Chadwick
// Baseball Bureau.
//
// WHY THIS SOURCE
// ---------------
// It is the only free, complete, game-by-game baseball archive that a machine
// with nothing but GitHub can reach — and, far more importantly, it names the
// STARTING PITCHER of every game. That single field is what separates a baseball
// model from a coin flip weighted by team quality, and no summary feed carries it.
//
// THE CATCH, AND HOW IT WAS DEALT WITH
// ------------------------------------
// Event files record every PLAY but never the final score. The score has to be
// counted off the plays, and a run-counter that is 99% right is not good enough:
// a systematic one-run error in 1% of games quietly biases every run total the
// model produces.
//
// So it was verified rather than assumed. Retrosheet also publishes game LOGS,
// which do carry official scores; parsing the 2011 event files and comparing all
// 2,426 games against gl2011.txt gives:
//
//     final score exactly right   2,426 / 2,426   (100.00%)
//     starting pitchers correct   2,426 / 2,426   (100.00%)
//
// Getting there needed two rules that are easy to miss and cost exactly one run
// each time (both are commented at their implementation below):
//
//   · SBH — a steal of home. The run is implicit; there is no advance notation.
//   · nXH(...E...) — a runner marked OUT at the plate who was in fact safe,
//     because the fielding sequence in the parentheses contains an error.
//
// Before those two, the parser scored 99.05% — which looks fine in a summary and
// is wrong in 26 games.

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db.ts';
import { RAW_DIR, baseballConfig } from '../../config.ts';
import type { LeagueId } from '../types.ts';

export const CACHE_DIR = path.join(RAW_DIR, 'baseball', 'retrosheet');

/** Retrosheet team code → the club's display name. */
export const TEAM_NAMES: Record<string, string> = {
  ANA: 'Los Angeles Angels', ARI: 'Arizona Diamondbacks', ATL: 'Atlanta Braves',
  BAL: 'Baltimore Orioles', BOS: 'Boston Red Sox', CHA: 'Chicago White Sox',
  CHN: 'Chicago Cubs', CIN: 'Cincinnati Reds', CLE: 'Cleveland Guardians',
  COL: 'Colorado Rockies', DET: 'Detroit Tigers', FLO: 'Florida Marlins',
  HOU: 'Houston Astros', KCA: 'Kansas City Royals', LAN: 'Los Angeles Dodgers',
  MIA: 'Miami Marlins', MIL: 'Milwaukee Brewers', MIN: 'Minnesota Twins',
  MON: 'Montreal Expos', NYA: 'New York Yankees', NYN: 'New York Mets',
  OAK: 'Oakland Athletics', PHI: 'Philadelphia Phillies', PIT: 'Pittsburgh Pirates',
  SDN: 'San Diego Padres', SEA: 'Seattle Mariners', SFN: 'San Francisco Giants',
  SLN: 'St. Louis Cardinals', TBA: 'Tampa Bay Rays', TEX: 'Texas Rangers',
  TOR: 'Toronto Blue Jays', WAS: 'Washington Nationals',
};

/** Every club that has appeared, so a season's 30 files can be found by trying. */
const ALL_TEAMS = Object.keys(TEAM_NAMES);

// ---------------------------------------------------------------------------
// Counting runs off the plays
// ---------------------------------------------------------------------------
/** A home run by the batter. Retrosheet writes it "HR", or bare "H" in old files. */
const HOMER = /^HR?\d*$/;

/**
 * A steal of home.
 *
 * The run is IMPLICIT — there is no advance notation to find, so a parser that
 * only reads advances silently loses it. Appears bare ("SBH"), inside a double
 * steal ("SB2;SBH"), after a strikeout ("K+SBH") and with an annotation
 * ("SBH(UR)"), and all four forms have to match.
 */
const STEAL_HOME = /(?:^|;|\+)SBH(?:\([^)]*\))?(?:$|;)/;

/**
 * A runner marked X (out) at home who actually SCORED.
 *
 * "3XH(842)" is a clean out at the plate. "3XH(3E2)" is the same play with an
 * error in the fielding sequence, which means the runner was safe and the run
 * counts. Reading the X and stopping there is the single most expensive mistake
 * available here.
 */
const SAFE_AT_HOME_ON_ERROR = /^[B123]XH\((?=[^)]*E\d)/;

/** An advance that reaches home cleanly, once annotations are stripped. */
const ADVANCE_HOME = /^[B123]-H$/;

export function runsOnPlay(event: string): number {
  const ev = (event ?? '').trim();
  if (!ev || ev === 'NP') return 0;
  const dot = ev.indexOf('.');
  const head = dot >= 0 ? ev.slice(0, dot) : ev;
  const advances = dot >= 0 ? ev.slice(dot + 1) : '';
  const baseEvent = head.split('/')[0];
  const isHomer = HOMER.test(baseEvent);

  let runs = isHomer ? 1 : 0;
  let stoleHome = STEAL_HOME.test(baseEvent);

  if (advances) {
    for (const raw of advances.split(';')) {
      const token = raw.trim();
      if (SAFE_AT_HOME_ON_ERROR.test(token)) {
        runs++;
        if (token.startsWith('3XH')) stoleHome = false;
        continue;
      }
      const clean = token.replace(/\([^)]*\)/g, '');
      if (ADVANCE_HOME.test(clean)) {
        // The batter scoring on his own home run is already counted above.
        if (clean === 'B-H' && isHomer) continue;
        if (clean === '3-H') stoleHome = false;
        runs++;
      }
    }
  }
  return runs + (stoleHome ? 1 : 0);
}

export interface ParsedGame {
  date: string; // YYYYMMDD
  number: number;
  home: string;
  away: string;
  homeRuns: number;
  awayRuns: number;
  homeSp: string | null;
  awaySp: string | null;
  homeSpName: string | null;
  awaySpName: string | null;
  site: string | null;
}

/** Parse one Retrosheet event file into games. */
export function parseEventFile(text: string): ParsedGame[] {
  const games: ParsedGame[] = [];
  let cur: ParsedGame | null = null;
  const push = () => {
    if (cur && cur.home && cur.away && cur.date) games.push(cur);
  };

  for (const line of text.split('\n')) {
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const kind = line.slice(0, comma);

    if (kind === 'id') {
      push();
      cur = {
        date: '', number: 0, home: '', away: '',
        homeRuns: 0, awayRuns: 0,
        homeSp: null, awaySp: null, homeSpName: null, awaySpName: null, site: null,
      };
      continue;
    }
    if (!cur) continue;

    if (kind === 'info') {
      const f = line.split(',');
      const key = f[1];
      const value = (f[2] ?? '').trim();
      if (key === 'visteam') cur.away = value;
      else if (key === 'hometeam') cur.home = value;
      else if (key === 'date') cur.date = value.replace(/\//g, '');
      else if (key === 'number') cur.number = Number(value) || 0;
      else if (key === 'site') cur.site = value || null;
    } else if (kind === 'start') {
      // start,playerId,"Name",team(0=away 1=home),battingOrder,fieldingPosition
      const f = splitCsvLine(line);
      if (f.length >= 6 && f[5].trim() === '1') {
        const home = f[3].trim() === '1';
        if (home) {
          cur.homeSp = f[1];
          cur.homeSpName = f[2];
        } else {
          cur.awaySp = f[1];
          cur.awaySpName = f[2];
        }
      }
    } else if (kind === 'play') {
      // play,inning,half(0=away 1=home),batter,count,pitches,event
      const f = line.split(',');
      if (f.length < 7) continue;
      const runs = runsOnPlay(f.slice(6).join(','));
      if (runs === 0) continue;
      if (f[2] === '1') cur.homeRuns += runs;
      else cur.awayRuns += runs;
    }
  }
  push();
  return games;
}

/** Split a Retrosheet line, honouring the quoted player-name field. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

// ---------------------------------------------------------------------------
// Download and store
// ---------------------------------------------------------------------------
async function fetchTeamSeason(season: number, team: string, cache: boolean): Promise<string | null> {
  const base = baseballConfig.history.retrosheetBase;
  for (const ext of ['EVA', 'EVN'] as const) {
    const file = `${season}${team}.${ext}`;
    const cached = path.join(CACHE_DIR, file);
    if (cache && fs.existsSync(cached) && fs.statSync(cached).size > 1000) {
      return fs.readFileSync(cached, 'latin1');
    }
    const res = await fetch(`${base}/${season}/${file}`);
    if (!res.ok) continue;
    const text = await res.text();
    if (text.length < 1000) continue;
    if (cache) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cached, text, 'latin1');
    }
    return text;
  }
  return null;
}

export interface IngestResult {
  games: number;
  teams: number;
  pitchers: number;
  seasons: number[];
  missing: string[];
}

/**
 * Ingest whole seasons of MLB results.
 *
 * Each team file holds that club's HOME games, so thirty files cover a season
 * exactly once — except that a handful of games appear in both clubs' files when
 * a "home" series is played at the opponent's park (three in 2011 alone). The
 * UNIQUE constraint on (league, date, number, home, away) is what makes that a
 * non-event instead of a duplicate.
 */
export async function ingestRetrosheet(
  seasons: number[],
  league: LeagueId = 'mlb',
  opts: { cache?: boolean; onSeason?: (season: number, games: number) => void } = {},
): Promise<IngestResult> {
  const db = getDb();
  const cache = opts.cache ?? false;

  const insertTeam = db.prepare(
    `INSERT INTO bsb_teams (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );
  const insertGame = db.prepare(
    `INSERT INTO bsb_games
       (league, season, game_date, game_number, home_id, away_id, home_runs, away_runs,
        home_sp, away_sp, site)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, game_date, game_number, home_id, away_id) DO NOTHING`,
  );
  const insertPitcher = db.prepare(
    `INSERT INTO bsb_pitchers (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET name = excluded.name`,
  );

  let total = 0;
  const teamsSeen = new Set<string>();
  const pitchersSeen = new Set<string>();
  const missing: string[] = [];
  const done: number[] = [];

  for (const season of seasons) {
    let seasonGames = 0;
    for (const team of ALL_TEAMS) {
      const text = await fetchTeamSeason(season, team, cache);
      if (text === null) continue;
      const games = parseEventFile(text);
      if (games.length === 0) continue;

      db.exec('BEGIN');
      try {
        for (const g of games) {
          for (const [id, name] of [
            [g.home, TEAM_NAMES[g.home]],
            [g.away, TEAM_NAMES[g.away]],
          ] as [string, string | undefined][]) {
            if (!teamsSeen.has(id)) {
              insertTeam.run(id, league, name ?? id);
              teamsSeen.add(id);
            }
          }
          for (const [id, name] of [
            [g.homeSp, g.homeSpName],
            [g.awaySp, g.awaySpName],
          ] as [string | null, string | null][]) {
            if (id && !pitchersSeen.has(id)) {
              insertPitcher.run(id, league, name ?? id);
              pitchersSeen.add(id);
            }
          }
          insertGame.run(
            league, season, g.date, g.number, g.home, g.away,
            g.homeRuns, g.awayRuns, g.homeSp, g.awaySp, g.site,
          );
          seasonGames++;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    if (seasonGames === 0) missing.push(String(season));
    else {
      done.push(season);
      total += seasonGames;
    }
    opts.onSeason?.(season, seasonGames);
  }

  if (total === 0) {
    throw new Error(
      `Retrosheet no devolvió ningún partido para ${seasons.join(', ')}. ` +
        `Base: ${baseballConfig.history.retrosheetBase}`,
    );
  }
  return {
    games: total,
    teams: teamsSeen.size,
    pitchers: pitchersSeen.size,
    seasons: done,
    missing,
  };
}

/**
 * Re-run the check that validated the parser, against Retrosheet's own game log.
 *
 * Exposed as a command (`npm run verify:bsb`) rather than left as a note in a
 * document: a claim of "100% on 2,426 games" that cannot be re-run is not
 * evidence, and the day the upstream format shifts this is what will say so.
 */
export async function verifyAgainstGamelog(
  season = 2011,
  league: LeagueId = 'mlb',
): Promise<{ checked: number; exact: number; pitchersOk: number; mismatches: string[] }> {
  const res = await fetch(baseballConfig.history.gamelogVerifyUrl);
  if (!res.ok) throw new Error(`No pude bajar el gamelog de verificación: HTTP ${res.status}`);
  const truth = new Map<string, { home: number; away: number; homeSp: string; awaySp: string }>();
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const f = splitCsvLine(line).map((x) => x.replace(/^"|"$/g, ''));
    if (f.length < 105) continue;
    truth.set(`${f[0]}|${f[1]}|${f[3]}|${f[6]}`, {
      away: Number(f[9]),
      home: Number(f[10]),
      awaySp: f[101],
      homeSp: f[103],
    });
  }

  let checked = 0;
  let exact = 0;
  let pitchersOk = 0;
  const mismatches: string[] = [];
  for (const team of ALL_TEAMS) {
    const text = await fetchTeamSeason(season, team, false);
    if (!text) continue;
    for (const g of parseEventFile(text)) {
      const t = truth.get(`${g.date}|${g.number}|${g.away}|${g.home}`);
      if (!t) continue;
      checked++;
      if (t.home === g.homeRuns && t.away === g.awayRuns) exact++;
      else mismatches.push(`${g.date} ${g.away}@${g.home}: contado ${g.awayRuns}-${g.homeRuns}, oficial ${t.away}-${t.home}`);
      if (t.homeSp === g.homeSp && t.awaySp === g.awaySp) pitchersOk++;
    }
  }
  void league;
  return { checked, exact, pitchersOk, mismatches };
}

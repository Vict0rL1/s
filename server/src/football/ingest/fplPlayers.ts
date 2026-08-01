// Premier League squads from the Fantasy Premier League dataset on GitHub.
//
// WHY THIS SOURCE
// ---------------
// Lineup and availability data is the thing every free football feed omits, and
// the thing the model most needs (see players.ts for what it is worth in goals).
// vaastav/Fantasy-Premier-League mirrors the official FPL API into CSV, season by
// season, and it carries exactly the four things required:
//
//   · minutes and starts   → who actually plays
//   · expected goals + expected assists per 90 → what each player contributes
//   · status               → injured / suspended / unavailable, right now
//   · news                 → the club's own wording for why
//
// It is public domain, needs no key, and is on GitHub — which matters, because
// GitHub is reachable from environments that block almost everything else.
//
// WHAT IT DOES NOT COVER
// ----------------------
// The Premier League and nothing else. There is no equivalent open dataset for
// LaLiga or the Bundesliga, so the squad layer is English-only and the app says
// so rather than showing an empty panel and letting the user assume the data is
// missing by accident. Every other league keeps the team-level model unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDb, setMeta } from '../../db.ts';
import { RAW_DIR } from '../../config.ts';
import { buildTeamIndex, resolveTeam } from './teamNames.ts';
import type { Position } from '../players.ts';
import type { LeagueId } from '../types.ts';

const BASE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
export const CACHE_DIR = path.join(RAW_DIR, 'football', 'fpl');

/** FPL's element_type. */
const POSITIONS: Record<string, Position> = { '1': 'GK', '2': 'DEF', '3': 'MID', '4': 'FWD' };

/**
 * FPL's abbreviations expanded to a full club name.
 *
 * These are the ones no prefix rule can bridge: "Man Utd", "Spurs" and
 * "Nott'm Forest" share nothing usable with "Manchester United", "Tottenham
 * Hotspur" and "Nottingham Forest", and a matcher loose enough to join them would
 * also happily merge the two Manchester clubs.
 *
 * They expand to NAMES, not to ids, and the expansion is then resolved against
 * whatever teams the database actually holds. That matters because the two
 * results feeds slug clubs differently — footballcsv gives
 * `manchester-united-fc`, football-data.co.uk gives `man-united` — so any
 * hardcoded id here would be right for one of them and silently wrong for the
 * other.
 */
const TEAM_ALIASES: Record<string, string> = {
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  spurs: 'tottenham hotspur',
  "nott'm forest": 'nottingham forest',
  'nottm forest': 'nottingham forest',
  wolves: 'wolverhampton wanderers',
  'sheffield utd': 'sheffield united',
  'west brom': 'west bromwich albion',
  'west ham': 'west ham united',
  newcastle: 'newcastle united',
  leeds: 'leeds united',
  brighton: 'brighton hove albion',
  bournemouth: 'afc bournemouth',
  ipswich: 'ipswich town',
  luton: 'luton town',
  leicester: 'leicester city',
  norwich: 'norwich city',
  huddersfield: 'huddersfield town',
  watford: 'watford',
  'aston villa': 'aston villa',
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** FPL writes an absent value as the literal string "None". */
function optionalInt(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s || s === 'None' || s === 'null') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function download(season: string, file: string): Promise<string> {
  const url = `${BASE}/${season}/${file}`;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, `${season}-${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FPL ${season}/${file}: HTTP ${res.status} (${url})`);
  const text = await res.text();
  fs.writeFileSync(cached, text);
  return text;
}

/**
 * Which season to read.
 *
 * The FPL calendar runs August→May, so between January and July the current
 * season started the previous calendar year. Tried newest-first and the first one
 * that exists wins, which also means a season that has not started yet falls back
 * to the completed one instead of leaving the app with no squads at all.
 */
export function candidateSeasons(now = new Date()): string[] {
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 6 ? y : y - 1;
  const fmt = (a: number) => `${a}-${String((a + 1) % 100).padStart(2, '0')}`;
  return [fmt(startYear + 1), fmt(startYear), fmt(startYear - 1)];
}

interface Ingested {
  season: string;
  players: number;
  teams: number;
  unmatched: string[];
}

/** Download one season of squads into fb_players. Returns what it found. */
export async function ingestFplPlayers(
  league: LeagueId = 'epl',
  season?: string,
): Promise<Ingested> {
  const seasons = season ? [season] : candidateSeasons();
  let teamsCsv = '';
  let playersCsv = '';
  let used = '';
  const tried: string[] = [];
  for (const s of seasons) {
    try {
      teamsCsv = await download(s, 'teams.csv');
      playersCsv = await download(s, 'players_raw.csv');
      used = s;
      break;
    } catch (e) {
      tried.push(`${s}: ${(e as Error).message}`);
    }
  }
  if (!used) {
    throw new Error(`No hay datos FPL para ninguna temporada probada.\n  ${tried.join('\n  ')}`);
  }

  const teamRows = parse(teamsCsv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const playerRows = parse(playersCsv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];

  // Fail loudly on a layout change rather than ingesting zeroes: a silently
  // renamed column would leave every player on 0 minutes and every squad neutral,
  // which looks exactly like "this team has no absences".
  const required = ['id', 'element_type', 'team', 'minutes', 'web_name', 'status'];
  const missing = required.filter((c) => !(c in (playerRows[0] ?? {})));
  if (missing.length) {
    throw new Error(
      `players_raw.csv de ${used} no trae ${missing.join(', ')}. ` +
        `Cabeceras encontradas: ${Object.keys(playerRows[0] ?? {}).slice(0, 20).join(', ')}…`,
    );
  }

  const index = buildTeamIndex(league);
  const unmatched: string[] = [];
  const teamById = new Map<string, string>();
  for (const t of teamRows) {
    const raw = (t.name ?? '').trim();
    const expanded = TEAM_ALIASES[raw.toLowerCase()] ?? raw;
    const id = resolveTeam(index, expanded);
    if (id) teamById.set(String(t.id), id);
    else unmatched.push(raw || '(sin nombre)');
  }
  if (teamById.size === 0) {
    throw new Error(
      `Ningún equipo de FPL coincide con los de la liga "${league}" en la base. ` +
        `¿Has corrido \`npm run update-data:fb\` antes? Equipos de FPL: ` +
        `${teamRows.slice(0, 5).map((t) => t.name).join(', ')}…`,
    );
  }

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO fb_players
       (id, league, team_id, name, position, minutes, starts, xgi90, goals, assists,
        status, chance_next, news, season, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET
       team_id = excluded.team_id, name = excluded.name, position = excluded.position,
       minutes = excluded.minutes, starts = excluded.starts, xgi90 = excluded.xgi90,
       goals = excluded.goals, assists = excluded.assists, status = excluded.status,
       chance_next = excluded.chance_next, news = excluded.news,
       season = excluded.season, updated_at = excluded.updated_at`,
  );

  const now = new Date().toISOString();
  let n = 0;
  db.exec('BEGIN');
  try {
    // A player who left the league keeps a stale row otherwise, and would go on
    // being counted in a squad he is no longer in.
    db.prepare('DELETE FROM fb_players WHERE league = ?').run(league);
    for (const p of playerRows) {
      const teamId = teamById.get(String(p.team));
      if (!teamId) continue;
      const minutes = num(p.minutes);
      // Per-90 rates are meaningless below a sensible amount of football, and
      // FPL's own column already divides by minutes — so a player with 12 minutes
      // and one shot comes out looking like the best striker in the division.
      const xgi90 =
        minutes >= 270
          ? num(p.expected_goal_involvements_per_90) ||
            (num(p.expected_goals) + num(p.expected_assists)) / (minutes / 90)
          : null;
      insert.run(
        String(p.id),
        league,
        teamId,
        (p.web_name ?? `${p.first_name ?? ''} ${p.second_name ?? ''}`).trim(),
        POSITIONS[String(p.element_type)] ?? 'MID',
        Math.round(minutes),
        Math.round(num(p.starts)),
        xgi90 != null ? Math.round(xgi90 * 1000) / 1000 : null,
        Math.round(num(p.goals_scored)),
        Math.round(num(p.assists)),
        (p.status ?? 'a').trim() || 'a',
        optionalInt(p.chance_of_playing_next_round),
        (p.news ?? '').trim() || null,
        used,
        now,
      );
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  setMeta('fb_squads_season', used);
  setMeta('fb_squads_updated_at', now);
  setMeta('fb_squads_leagues', league);
  return { season: used, players: n, teams: teamById.size, unmatched };
}

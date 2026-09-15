// Ingest league results from openfootball/football.json.
//
// ===========================================================================
// WHY THIS SOURCE, AND WHY IT MATTERS MORE THAN THE OTHER TWO
// ===========================================================================
// The football tab's history ended in **July 2020**. Every Elo on it described the
// teams of six years ago, and the app said so in an amber banner — which is honest
// but is not a fix. The cause was that footballcsv, the source it fits on, was
// abandoned after 2020-21.
//
// footballcsv is a MIRROR. This is what it mirrors, and the upstream is alive:
//
//     liga      2019-20  2020-21  2021-22  2022-23  2023-24  2024-25  2025-26
//     en.1      380/380  380/380  380/380  380/380  380/380  380/380  353/380
//     en.2      552/552  552/552  557/557  557/557  557/557  557/557  521/557
//     es.1      380/380  380/380  380/380  380/380  380/380  370/380  365/380
//     de.1      306/306  306/306  306/306  306/306  306/306  306/306  294/306
//     it.1      380/380  380/380  380/380  380/380  380/380  370/380  344/380
//     fr.1      279/380  380/380  380/380  380/380  306/306  306/306  282/306
//     nl.1      232/306  306/306  306/306  306/306  306/306  306/306  295/306
//     pt.1      306/306  306/306  306/306  306/306  306/306  306/306  287/306
//
// (scored / scheduled, measured against the live repo.)
//
// So this does two things at once. It moves the history from 2020 to the current
// season — and it gives Serie A, Ligue 1, Eredivisie, Primeira, Liga MX and the
// Argentine league a RESULTS SOURCE for the first time. Those five were configured
// as tabs and could only ever show the market's numbers, because nothing in the app
// knew a single one of their matches.
//
// ===========================================================================
// TWO THINGS THE JSON HAS THAT THE CSV DID NOT
// ===========================================================================
//   * HALF-TIME SCORES (`score.ht`). Stored but not yet modelled — see the note on
//     the schema. It is the one piece of data that would make "wins either half", a
//     market this app's reader actually bets, possible rather than invented.
//   * Kick-off TIMES, so a historical match has an hour and not just a date.
//
// ===========================================================================
// WHAT IT STILL IS NOT
// ===========================================================================
// It carries no BOOKMAKER ODDS. football-data.co.uk remains the only source of
// historical closing prices, which is what lets the model be measured against the
// market rather than just against a coin. The two are complements: this one supplies
// depth and currency, that one supplies the benchmark.

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db.ts';
import { RAW_DIR, footballConfig } from '../../config.ts';
import { slugify } from './footballcsv.ts';
import { buildTeamIndex, normalizeTeamName } from './teamNames.ts';
import { txtToJson } from './openfootballTxt.ts';
import type { LeagueConfig } from '../types.ts';

export const CACHE_DIR = path.join(RAW_DIR, 'football', 'openfootball');

/** One match as the JSON gives it. */
interface RawMatch {
  round?: string;
  date?: string;
  time?: string;
  team1?: string;
  team2?: string;
  /**
   * TWO SHAPES, and the second one is not documented anywhere.
   *
   *   { ft: [4, 2], ht: [1, 0] }   the normal object
   *   [0, 0]                        a bare array — see `readScore`
   */
  score?: { ft?: [number, number]; ht?: [number, number] } | [number, number];
}

/**
 * The full-time and half-time score, whichever shape the file used.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE BUG THIS EXISTS TO FIX, because it was invisible and it was biased.  │
 * │                                                                          │
 * │ openfootball writes most matches as `score: { ft: [...], ht: [...] }`,   │
 * │ but SOME as a bare `score: [0, 0]`. Reading `m.score?.ft` on the array   │
 * │ form gives undefined, so the match was skipped as "not played".          │
 * │                                                                          │
 * │ In the 2025-26 files, 178 of 2,919 matches (6.1 %) use the array form —  │
 * │ and every single one of them is 0-0. Not a sample: all 178.              │
 * │                                                                          │
 * │ So the loss was not random noise, it was one RESULT going missing. The   │
 * │ goalless-draw rate in the database fell from 6.6 % in 2024 to 3.1 % in   │
 * │ 2025 and 0.07 % in 2026 — one match in 1,438. Every goal model built on  │
 * │ that thinks the draw is rarer, the over safer and "both teams score"     │
 * │ likelier than they are, in the CURRENT seasons specifically.             │
 * │                                                                          │
 * │ Nothing failed. The counts went up, which is what a new source is        │
 * │ supposed to do.                                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
function readScore(score: RawMatch['score']): {
  ft: [number, number] | null;
  ht: [number, number] | null;
} {
  const pair = (v: unknown): [number, number] | null =>
    Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))
      ? [Number(v[0]), Number(v[1])]
      : null;
  // The array form carries no half-time score, which is consistent with it being
  // the shorthand for "nothing happened".
  if (Array.isArray(score)) return { ft: pair(score), ht: null };
  return { ft: pair(score?.ft), ht: pair(score?.ht) };
}

export interface OpenFootballMatch {
  /** YYYYMMDD. */
  date: string;
  /** "HH:MM" when the file has it. */
  time: string | null;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  /** Half-time, when present. Null is common in the older seasons. */
  htHome: number | null;
  htAway: number | null;
}

/**
 * Parse one season file.
 *
 * Deliberately tolerant: a match with no `score.ft` has not been played (or was
 * abandoned) and is skipped rather than stored as 0-0, which is the single worst
 * thing an ingest can do to a rating.
 */
export function parseOpenFootball(json: string, source: string): OpenFootballMatch[] {
  let data: { name?: string; matches?: RawMatch[] };
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`${source}: JSON ilegible — ${(e as Error).message}`);
  }
  const out: OpenFootballMatch[] = [];
  for (const m of data.matches ?? []) {
    const { ft, ht } = readScore(m.score);
    if (!ft) continue;
    const d = (m.date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const home = (m.team1 ?? '').trim();
    const away = (m.team2 ?? '').trim();
    if (!d || !home || !away) continue;
    out.push({
      date: `${d[1]}${d[2]}${d[3]}`,
      time: /^\d{1,2}:\d{2}$/.test(m.time ?? '') ? (m.time as string) : null,
      homeName: home,
      awayName: away,
      homeGoals: ft[0],
      awayGoals: ft[1],
      htHome: ht ? ht[0] : null,
      htAway: ht ? ht[1] : null,
    });
  }
  return out;
}

/** Season label "2019-20" → the year it ends in (2020), matching fb_matches.season. */
function seasonEndYear(label: string): number {
  const m = label.match(/^(\d{4})-(\d{2})$/);
  if (!m) return Number(label) || 0;
  const start = Number(m[1]);
  const endTwo = Number(m[2]);
  return Math.floor(start / 100) * 100 + endTwo + (endTwo < start % 100 ? 100 : 0);
}

/**
 * Season labels to fetch, newest first, ending with the season now in progress.
 *
 * European seasons are named by the year they END in, and the new one starts in
 * August — so in September 2026 the current label is "2026-27" and in March 2026 it
 * is still "2025-26". Getting this wrong is how an ingest silently skips the season
 * everyone actually cares about.
 */
export function seasonLabels(count: number, now = new Date()): string[] {
  const y = now.getFullYear();
  const startYear = now.getMonth() + 1 >= 7 ? y : y - 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = startYear - i;
    out.push(`${s}-${String((s + 1) % 100).padStart(2, '0')}`);
  }
  return out;
}

async function fetchSeason(league: LeagueConfig, label: string): Promise<string | null> {
  const key = league.openfootball?.key;
  if (!key) return null;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, `${key}_${label}.json`);
  // The CURRENT season is never cached: it gains matches every weekend, and serving
  // a week-old copy of it is exactly the staleness this whole file exists to remove.
  const current = seasonLabels(1)[0];
  if (label !== current && fs.existsSync(dest) && fs.statSync(dest).size > 200) return dest;

  const url = `${footballConfig.history.openfootballBase}/${label}/${key}.json`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const body = await res.text();
      if (body.length >= 100) {
        fs.writeFileSync(dest, body);
        return dest;
      }
    }
  } catch {
    // A missing season is normal — not every league has every year — so this is a
    // skip and not an error. A network that is down shows up as every season
    // missing, which the caller reports as zero matches.
  }
  return fetchSeasonFromTxt(league, label, dest);
}

/**
 * El mismo dato, del repo de TEXTO del país, cuando el mirror JSON no lo tiene.
 *
 * Esto no es redundancia por si acaso: son temporadas concretas que existen y que la
 * app no estaba leyendo. Medido fichero a fichero contra la fuente, a `es.2` y a
 * `it.2` les faltan 2021-22, 2022-23 y 2023-24 en el mirror y están las tres en el
 * texto. Y no es un hueco cualquiera: el salto de división se mide emparejando la
 * temporada S de un club en Segunda con la S+1 en Primera, así que cada temporada
 * ausente abajo borra una promoción entera arriba.
 *
 * Se convierte a la forma del JSON y se guarda con el MISMO nombre de caché, para que
 * de aquí en adelante no exista la distinción: hay un solo parser de registro
 * (`parseOpenFootball`) y un solo camino de inserción.
 */
async function fetchSeasonFromTxt(
  league: LeagueConfig,
  label: string,
  dest: string,
): Promise<string | null> {
  const txt = league.openfootball?.txt;
  if (!txt) return null;
  const url =
    `${footballConfig.history.openfootballTxtBase}/${txt.repo}/master/${label}/${txt.file}.txt`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.text();
    if (body.length < 100) return null;
    const converted = txtToJson(body, label);
    // Un fichero de texto que existe pero no produce partidos es un formato que no
    // reconocemos, y guardarlo en la caché como JSON vacío lo dejaría envenenado para
    // todas las ejecuciones siguientes.
    if (JSON.parse(converted).matches.length === 0) return null;
    fs.writeFileSync(dest, converted);
    return dest;
  } catch {
    return null;
  }
}

export interface OpenFootballResult {
  league: string;
  matches: number;
  teams: number;
  seasons: string[];
  /** Newest match ingested, YYYYMMDD — what the staleness banner reads. */
  through: string | null;
  withHalfTime: number;
}

export async function ingestOpenFootball(
  league: LeagueConfig,
  labels: string[],
): Promise<OpenFootballResult> {
  const empty: OpenFootballResult = {
    league: league.id,
    matches: 0,
    teams: 0,
    seasons: [],
    through: null,
    withHalfTime: 0,
  };
  if (!league.openfootball) return empty;

  const db = getDb();
  const insertTeam = db.prepare(
    // Keep the LONGER of the two spellings. Once the id is normalised, one club
    // arrives as both "Manchester City" (the 2019-20 files) and "Manchester City FC"
    // (every season since), and last-write-wins produced a fixture line reading
    // "Arsenal FC vs Manchester City" — the same league, the same card, two
    // conventions. The longer string is the one carrying the legal form, which is
    // also the current official name.
    `INSERT INTO fb_teams (id, league, name) VALUES (?, ?, ?)
     ON CONFLICT(league, id) DO UPDATE SET
       name = CASE WHEN length(excluded.name) > length(fb_teams.name)
                   THEN excluded.name ELSE fb_teams.name END`,
  );
  // Odds are left alone on conflict: football-data.co.uk may already have filled
  // them in for this match, and this source has none. Overwriting them with NULL
  // would destroy the only benchmark the model can be measured against.
  const insertMatch = db.prepare(
    `INSERT INTO fb_matches
       (league, season, match_date, home_id, away_id, home_goals, away_goals, result,
        odds_home, odds_draw, odds_away, ht_home_goals, ht_away_goals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(league, match_date, home_id, away_id) DO UPDATE SET
       home_goals = excluded.home_goals,
       away_goals = excluded.away_goals,
       result = excluded.result,
       season = excluded.season,
       ht_home_goals = COALESCE(excluded.ht_home_goals, fb_matches.ht_home_goals),
       ht_away_goals = COALESCE(excluded.ht_away_goals, fb_matches.ht_away_goals)`,
  );

  const teams = new Map<string, string>();
  let matches = 0;
  let withHalfTime = 0;
  let through: string | null = null;
  const used: string[] = [];

  /**
   * The club's id, RESOLVED against the clubs already ingested for this league.
   *
   * Slugifying each spelling independently is what split every club in two the
   * first time, and stripping the legal-form suffixes only fixed half of it. The
   * other half is that openfootball changes how much of the formal name it writes
   * between seasons:
   *
   *     2019-20   "Atlético Madrid"           → atletico-madrid          (38 partidos)
   *     2020-26   "Club Atlético de Madrid"   → club-atletico-de-madrid  (227)
   *
   * Two ids, one club, and the whole first season orphaned again — with the card
   * then reporting, correctly, "Atlético Madrid: 38 partidos, sin jugar desde hace
   * 6 años".
   *
   * So the same resolver the ODDS feed uses is used here: normalise, then accept a
   * prefix match only when it leaves exactly one candidate. That is what merges
   * "Rayo Vallecano" with "Rayo Vallecano de Madrid" without merging the two
   * Manchester clubs. The longest spelling wins the stored NAME (see insertTeam),
   * so the id keeps whichever came first while the label stays the formal one.
   */
  const index = buildTeamIndex(league.id);
  const clubId = (name: string): string => {
    // EXACT normalised match only — no prefix matching. This is the difference
    // between merging a club with itself and merging it with its neighbour:
    //
    //   "Atlético Madrid" / "Club Atlético de Madrid" → both "atletico madrid" ✓
    //   "Paris FC" / "Paris Saint-Germain FC"         → "paris" vs
    //                                                   "paris saint germain" ✗
    //
    // Both are real Ligue 1 clubs in 2025-26. With prefix matching "paris" is a
    // prefix of "paris saint germain" and leaves exactly one candidate, so Paris FC
    // was absorbed into PSG — and the archive ended up with two matches of PSG
    // against itself, which is how it was caught.
    //
    // Prefix matching still earns its place in the ODDS feed, where a bookmaker
    // writes "Man City" and the alternative is no model at all. There it resolves a
    // single fixture against a settled table; here it would MINT the table.
    const hit = index.get(normalizeTeamName(name));
    if (hit) return hit;
    const id = slugify(name);
    // Register it under BOTH spellings so the next season's variant resolves to it.
    index.set(normalizeTeamName(name), id);
    index.set(normalizeTeamName(id.replace(/-/g, ' ')), id);
    return id;
  };

  for (const label of labels) {
    const file = await fetchSeason(league, label);
    if (!file) continue;
    let parsed: OpenFootballMatch[];
    try {
      parsed = parseOpenFootball(fs.readFileSync(file, 'utf8'), path.basename(file));
    } catch (e) {
      process.stderr.write(`  ${league.id} ${label}: ${(e as Error).message}\n`);
      continue;
    }
    if (parsed.length === 0) continue;
    used.push(label);
    const season = seasonEndYear(label);

    db.exec('BEGIN');
    try {
      for (const m of parsed) {
        const homeId = clubId(m.homeName);
        const awayId = clubId(m.awayName);
        teams.set(homeId, m.homeName);
        teams.set(awayId, m.awayName);
        insertTeam.run(homeId, league.id, m.homeName);
        insertTeam.run(awayId, league.id, m.awayName);
        insertMatch.run(
          league.id,
          season,
          m.date,
          homeId,
          awayId,
          m.homeGoals,
          m.awayGoals,
          m.homeGoals > m.awayGoals ? 'H' : m.homeGoals === m.awayGoals ? 'D' : 'A',
          m.htHome,
          m.htAway,
        );
        matches++;
        if (m.htHome != null) withHalfTime++;
        if (!through || m.date > through) through = m.date;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return {
    league: league.id,
    matches,
    teams: teams.size,
    seasons: used,
    through,
    withHalfTime,
  };
}

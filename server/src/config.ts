// Loads environment variables and the JSON config files (tours + tournaments).
// Everything tour/tournament-specific lives in /config so the app is easy to
// extend without touching model or API logic.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import type { ToursConfig, TournamentsConfig } from './types.ts';
import type { BasketballConfig } from './basketball/types.ts';
import type { FootballConfig } from './football/types.ts';
import type { BaseballConfig } from './baseball/types.ts';
import type { NafConfig } from './nfl/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src
export const ROOT = path.resolve(HERE, '..', '..'); // repo root
export const DATA_DIR = path.join(ROOT, 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const SEED_DIR = path.join(DATA_DIR, 'seed');
export const DB_PATH = path.join(DATA_DIR, 'tennis.db');
export const CONFIG_DIR = path.join(ROOT, 'config');

// Load .env from the repo root (never commit it — see .env.example).
dotenv.config({ path: path.join(ROOT, '.env') });

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export const toursConfig = readJson<ToursConfig>(path.join(CONFIG_DIR, 'tours.json'));
export const tournamentsConfig = readJson<TournamentsConfig>(
  path.join(CONFIG_DIR, 'tournaments.json'),
);
export const basketballConfig = readJson<BasketballConfig>(
  path.join(CONFIG_DIR, 'basketball.json'),
);
export const footballConfig = readJson<FootballConfig>(path.join(CONFIG_DIR, 'football.json'));
export const baseballConfig = readJson<BaseballConfig>(path.join(CONFIG_DIR, 'baseball.json'));
export const nflConfig = readJson<NafConfig>(path.join(CONFIG_DIR, 'americanfootball.json'));

/**
 * A number from the environment, where 0 is a legitimate value.
 *
 * `Number(v) || fallback` collapses 0 into the fallback, which is wrong for
 * anything where 0 means "off".
 */
function numberFromEnv(raw: string | undefined, fallback: number): number {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const env = {
  oddsApiKey: process.env.ODDS_API_KEY?.trim() || '',
  // ONE region by default, not two.
  //
  // The Odds API charges per market PER REGION, so "eu,uk" doubled the price of
  // every single call to get a second opinion on the same prices — and it is what
  // turned a 500-request monthly plan into a two-and-a-half-day plan. Add regions
  // back only if you are on a paid tier; see server/src/oddsQuota.ts.
  oddsRegions: process.env.ODDS_REGIONS?.trim() || 'eu',
  // 7374, not 4000. `npm run dev` always passes PORT explicitly, so this fallback
  // only applies when the server is started on its own — but it has to agree with
  // scripts/ports.mjs, which is the source of truth for the number.
  port: Number(process.env.PORT) || 7374,
  // Minutes between automatic odds refreshes (0 disables). Only runs with a key.
  //
  // This is only the STARTING value now. After the first cycle the server knows
  // two things it cannot know before one — the size of the plan (from the API's
  // own response headers) and what a cycle actually costs — and re-times itself
  // from them. See recommendedRefreshMinutes in oddsQuota.ts.
  //
  // 12 hours is the safe opening bid: it is what fits the 500-credit free plan,
  // so a first cycle on the smallest plan cannot overspend before the arithmetic
  // has anything to work with. A bigger plan widens it within one cycle.
  //
  // Read with a nullish check, NOT `|| 720`. `Number('0') || 720` is 720, so
  // AUTO_REFRESH_MINUTES=0 — documented as the way to turn this off, and the
  // first thing anyone tries when the quota is disappearing — silently did
  // nothing and left the timer running at the default.
  autoRefreshMinutes: numberFromEnv(process.env.AUTO_REFRESH_MINUTES, 720),
  /**
   * Did someone actually set AUTO_REFRESH_MINUTES?
   *
   * If they did, it is honoured and the automatic tuning stays out of the way.
   * Without this flag the two are indistinguishable and the server would happily
   * overrule a deliberate setting with its own estimate.
   */
  autoRefreshMinutesExplicit: !!process.env.AUTO_REFRESH_MINUTES?.trim(),
};

export function tourById(id: string) {
  return toursConfig.tours.find((t) => t.id === id);
}

export function tournamentById(id: string) {
  return tournamentsConfig.tournaments.find((t) => t.id === id);
}

export function leagueById(id: string) {
  return basketballConfig.leagues.find((l) => l.id === id);
}

export function footballLeagueById(id: string) {
  return footballConfig.leagues.find((l) => l.id === id);
}

export function baseballLeagueById(id: string) {
  return baseballConfig.leagues.find((l) => l.id === id);
}

export function nflLeagueById(id: string) {
  return nflConfig.leagues.find((l) => l.id === id);
}

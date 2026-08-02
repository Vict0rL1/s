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

export const env = {
  oddsApiKey: process.env.ODDS_API_KEY?.trim() || '',
  oddsRegions: process.env.ODDS_REGIONS?.trim() || 'eu,uk',
  port: Number(process.env.PORT) || 4000,
  // Minutes between automatic odds refreshes (0 disables). Only runs when a key
  // is set. The /sports listing used to discover events is free; only the odds
  // fetches count against the 500/month free quota, so keep this modest.
  autoRefreshMinutes: Number(process.env.AUTO_REFRESH_MINUTES) || 360,
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

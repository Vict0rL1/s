// Loads environment variables and the JSON config files (tours + tournaments).
// Everything tour/tournament-specific lives in /config so the app is easy to
// extend without touching model or API logic.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import type { ToursConfig, TournamentsConfig } from './types.ts';

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

export const env = {
  oddsApiKey: process.env.ODDS_API_KEY?.trim() || '',
  oddsRegions: (process.env.ODDS_REGIONS?.trim() || 'eu,uk'),
  port: Number(process.env.PORT) || 4000,
};

export function tourById(id: string) {
  return toursConfig.tours.find((t) => t.id === id);
}

export function tournamentById(id: string) {
  return tournamentsConfig.tournaments.find((t) => t.id === id);
}

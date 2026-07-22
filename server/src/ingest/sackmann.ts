// Ingest historical match data from Jeff Sackmann's tennis_atp / tennis_wta
// repositories (CSV, one file per season). Free, no API key, match-by-match
// data going back decades, with serve/break stats where available.
//
// Docs: https://github.com/JeffSackmann/tennis_atp
//       https://github.com/JeffSackmann/tennis_wta
//
// NOTE: this reaches out to raw.githubusercontent.com, so it needs internet
// access. In restricted/offline environments use `npm run seed` instead, which
// loads the bundled sample dataset.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDb } from '../db.ts';
import { RAW_DIR, toursConfig } from '../config.ts';
import type { TourConfig, TourId } from '../types.ts';

function rawUrl(repo: string, file: string): string {
  return toursConfig.history.rawBaseUrl.replace('{repo}', repo).replace('{file}', file);
}

/** Fetch a CSV, caching it under data/raw so re-runs don't re-download. */
async function fetchCsvCached(repo: string, file: string): Promise<string | null> {
  const cachePath = path.join(RAW_DIR, file);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf8');
  }
  const url = rawUrl(repo, file);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    throw new Error(
      `No se pudo conectar con GitHub para descargar ${file} (${(e as Error).message}). ` +
        `Revisa tu conexión a internet.`,
    );
  }
  if (res.status === 404) return null; // season file may not exist yet
  if (!res.ok) throw new Error(`Fallo al descargar ${url}: HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(cachePath, text);
  return text;
}

/**
 * Check we can actually reach the data source before wiping anything. Returns
 * the number of players found in the first tour's players file (throws a
 * friendly error if unreachable).
 */
export async function preflight(tour: TourConfig): Promise<number> {
  const csv = await fetchCsvCached(tour.sackmann.repo, tour.sackmann.playersFile);
  if (!csv) throw new Error(`El archivo de jugadores de ${tour.id} no está disponible (404).`);
  const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
  return (rows as any[]).length;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface IngestOptions {
  fromYear: number;
  toYear: number;
}

/** Download + parse + store one tour's players and matches for a year range. */
export async function ingestTour(tour: TourConfig, opts: IngestOptions): Promise<{
  players: number;
  matches: number;
}> {
  const db = getDb();

  // --- Players (biographical info) ---
  const playersCsv = await fetchCsvCached(tour.sackmann.repo, tour.sackmann.playersFile);
  const playerUpsert = db.prepare(
    `INSERT INTO players (id, tour, name, hand, country, birthdate)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tour, id) DO UPDATE SET name=excluded.name, hand=excluded.hand,
       country=excluded.country, birthdate=excluded.birthdate`,
  );
  let playerCount = 0;
  if (playersCsv) {
    const rows = parse(playersCsv, { columns: true, skip_empty_lines: true, relax_column_count: true }) as any[];
    db.exec('BEGIN');
    for (const r of rows) {
      const id = num(r.player_id);
      if (id === null) continue;
      const name = `${r.name_first ?? ''} ${r.name_last ?? ''}`.trim() || `#${id}`;
      playerUpsert.run(id, tour.id, name, r.hand || null, r.ioc || null, r.dob || null);
      playerCount++;
    }
    db.exec('COMMIT');
  }

  // --- Matches (one CSV per season) ---
  const matchInsert = db.prepare(
    `INSERT INTO matches (
       tour, tourney_id, tourney_name, tourney_date, surface, level, round, best_of,
       winner_id, loser_id, score,
       w_ace, w_df, w_svpt, w_1stIn, w_1stWon, w_2ndWon, w_bpSaved, w_bpFaced,
       l_ace, l_df, l_svpt, l_1stIn, l_1stWon, l_2ndWon, l_bpSaved, l_bpFaced
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?)`,
  );

  // Insert-or-ignore for players that appear only in match rows — must NOT
  // overwrite the richer biographical rows loaded from the players CSV.
  const playerIgnore = db.prepare(
    'INSERT OR IGNORE INTO players (id, tour, name) VALUES (?, ?, ?)',
  );

  let matchCount = 0;
  for (let year = opts.fromYear; year <= opts.toYear; year++) {
    const file = tour.sackmann.matchesFile.replace('{year}', String(year));
    const csv = await fetchCsvCached(tour.sackmann.repo, file);
    if (!csv) continue;
    const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true }) as any[];
    db.exec('BEGIN');
    for (const r of rows) {
      const wId = num(r.winner_id);
      const lId = num(r.loser_id);
      if (wId === null || lId === null) continue;

      // Make sure both players exist (some appear only in match rows).
      ensurePlayer(playerIgnore, tour.id, wId, r.winner_name);
      ensurePlayer(playerIgnore, tour.id, lId, r.loser_name);

      matchInsert.run(
        tour.id,
        r.tourney_id || null,
        r.tourney_name || null,
        String(r.tourney_date || `${year}0101`),
        r.surface || null,
        r.tourney_level || null,
        r.round || null,
        num(r.best_of),
        wId,
        lId,
        r.score || null,
        num(r.w_ace), num(r.w_df), num(r.w_svpt), num(r.w_1stIn),
        num(r.w_1stWon), num(r.w_2ndWon), num(r.w_bpSaved), num(r.w_bpFaced),
        num(r.l_ace), num(r.l_df), num(r.l_svpt), num(r.l_1stIn),
        num(r.l_1stWon), num(r.l_2ndWon), num(r.l_bpSaved), num(r.l_bpFaced),
      );
      matchCount++;
    }
    db.exec('COMMIT');
    process.stdout.write(`  ${tour.id} ${year}: ${rows.length} matches\n`);
  }

  return { players: playerCount, matches: matchCount };
}

function ensurePlayer(
  insertIgnore: ReturnType<ReturnType<typeof getDb>['prepare']>,
  tour: TourId,
  id: number,
  name: string | undefined,
): void {
  insertIgnore.run(id, tour, name || `#${id}`);
}

export function tourConfigs(): TourConfig[] {
  return toursConfig.tours;
}

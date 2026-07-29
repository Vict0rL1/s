// Ingest historical match data from Jeff Sackmann's tennis_atp / tennis_wta
// repositories (CSV, one file per season). Free, no API key, match-by-match
// data going back decades, with serve/break stats where available.
//
// Docs: https://github.com/JeffSackmann/tennis_atp
//       https://github.com/JeffSackmann/tennis_wta
//
// Two ways to get the files:
//   1. Fast path — HTTP GET from raw.githubusercontent.com (cached in data/raw).
//   2. Fallback  — `git clone` from github.com. Some networks (universities,
//      some ISPs) block/filter raw.githubusercontent.com and return 404 even
//      though github.com works; when the always-present players file 404s or a
//      request errors, we clone the repo instead and read the CSVs from disk.
// Offline/restricted → use `npm run seed`.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'csv-parse/sync';
import { getDb } from '../db.ts';
import { RAW_DIR, toursConfig } from '../config.ts';
import type { TourConfig, TourId } from '../types.ts';

function rawUrl(repo: string, file: string): string {
  return toursConfig.history.rawBaseUrl.replace('{repo}', repo).replace('{file}', file);
}

// Repos we've switched to the git-clone source (because HTTP was unreachable).
const gitRepoDir = new Map<string, string>();

/** Shallow-clone (or update) a data repo and return its local directory. */
function cloneRepo(repo: string): string {
  const name = repo.split('/')[1] ?? repo.replace('/', '_');
  const dir = path.join(RAW_DIR, 'repos', name);
  const url = `https://github.com/${repo}.git`;
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      execFileSync('git', ['-C', dir, 'pull', '--ff-only'], { stdio: 'pipe' });
    } else {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      process.stdout.write(`  (raw.githubusercontent no disponible; clonando ${repo} vía git…)\n`);
      execFileSync('git', ['clone', '--depth', '1', url, dir], { stdio: 'inherit' });
    }
  } catch (e) {
    throw new Error(
      `No se pudo obtener ${repo}: falló tanto la descarga HTTP como git clone ` +
        `(${(e as Error).message}). Revisa tu conexión / que 'git' esté instalado.`,
    );
  }
  return dir;
}

/**
 * Read a repo file as text (null if it legitimately doesn't exist). Tries HTTP
 * first (cached in data/raw); on failure/filtered-404 switches to a git clone.
 */
async function readRepoFile(repo: string, file: string): Promise<string | null> {
  // Already switched this repo to git → read from the clone.
  const switched = gitRepoDir.get(repo);
  if (switched) {
    const p = path.join(switched, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  const cachePath = path.join(RAW_DIR, file);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');

  const useGitFor = (): string | null => {
    const dir = cloneRepo(repo);
    gitRepoDir.set(repo, dir);
    const p = path.join(dir, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };

  let res: Response;
  try {
    res = await fetch(rawUrl(repo, file), { signal: AbortSignal.timeout(45_000) });
  } catch {
    return useGitFor(); // network error → git
  }
  if (res.ok) {
    const text = await res.text();
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(cachePath, text);
    return text;
  }
  if (res.status === 404) {
    // The players file always exists; a 404 for it means raw.githubusercontent
    // is filtered on this network → switch to git. A missing season file is real.
    if (file.endsWith('_players.csv')) return useGitFor();
    return null;
  }
  return useGitFor(); // any other HTTP error → git
}

/**
 * Check we can actually reach the data source before wiping anything. Returns
 * the number of players found in the first tour's players file (throws a
 * friendly error if unreachable via both HTTP and git).
 */
export async function preflight(tour: TourConfig): Promise<number> {
  const csv = await readRepoFile(tour.sackmann.repo, tour.sackmann.playersFile);
  if (!csv) throw new Error(`El archivo de jugadores de ${tour.id} no está disponible.`);
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
  const playersCsv = await readRepoFile(tour.sackmann.repo, tour.sackmann.playersFile);
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
    const csv = await readRepoFile(tour.sackmann.repo, file);
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

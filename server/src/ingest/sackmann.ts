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

function rawUrls(repo: string, file: string): string[] {
  return toursConfig.history.rawBaseUrls.map((tpl) =>
    tpl.replace('{repo}', repo).replace('{file}', file),
  );
}

/** Host label for logging, e.g. "cdn.jsdelivr.net". */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Remembers which HTTP source worked, so we don't re-probe blocked hosts for
// every one of the ~12 season files.
let workingBaseIndex: number | null = null;

// Repos we've switched to the git-clone source (because HTTP was unreachable).
const gitRepoDir = new Map<string, string>();

/**
 * Shallow-clone (or update) a data repo and return its local directory. Tries
 * the configured mirrors in order. GIT_TERMINAL_PROMPT=0 is essential: when a
 * repo is unreachable GitHub answers 404 and git would otherwise hang forever
 * asking for a username/password.
 */
function cloneRepo(repo: string): string {
  const name = repo.split('/')[1] ?? repo.replace('/', '_');
  const dir = path.join(RAW_DIR, 'repos', name);
  const noPrompt = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GCM_INTERACTIVE: 'never',
  };

  // A manually placed copy (e.g. an unzipped download) — use it as-is.
  if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, '.git'))) {
    if (fs.readdirSync(dir).some((f) => f.endsWith('.csv'))) {
      process.stdout.write(`  usando la copia local en data/raw/repos/${name}\n`);
      return dir;
    }
    fs.rmSync(dir, { recursive: true, force: true }); // empty/partial → re-clone
  }

  // Already cloned → just try to update (a failed pull is fine, we have data).
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      execFileSync('git', ['-C', dir, 'pull', '--ff-only'], { stdio: 'pipe', env: noPrompt });
    } catch {
      process.stdout.write(`  (no se pudo actualizar ${name}; usando la copia local)\n`);
    }
    return dir;
  }

  const candidates = [repo, ...(toursConfig.history.mirrors?.[repo] ?? [])];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      process.stdout.write(`  clonando ${candidate} vía git…\n`);
      execFileSync(
        'git',
        ['clone', '--depth', '1', `https://github.com/${candidate}.git`, dir],
        { stdio: 'inherit', env: noPrompt },
      );
      return dir;
    } catch (e) {
      errors.push(`${candidate}: ${(e as Error).message.split('\n')[0]}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  throw new Error(
    `No se pudo obtener ${repo} ni por HTTP ni por git clone.\n` +
      `   Intentos: ${errors.join(' | ')}\n` +
      `   Tu red parece bloquear GitHub para este repositorio. Opciones:\n` +
      `     • Prueba con otra red (p. ej. datos del móvil) y vuelve a ejecutar.\n` +
      `     • O descarga el ZIP manualmente desde github.com/${repo} y descomprímelo en\n` +
      `       data/raw/repos/${name} (debe contener los .csv directamente).\n` +
      `     • Mientras tanto, \`npm run seed\` deja la app funcionando con datos de ejemplo.`,
  );
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

  const save = (text: string): string => {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(cachePath, text);
    return text;
  };

  const urls = rawUrls(repo, file);
  // Once a source works, stick to it for the remaining files.
  const order =
    workingBaseIndex !== null
      ? [workingBaseIndex, ...urls.map((_, i) => i).filter((i) => i !== workingBaseIndex)]
      : urls.map((_, i) => i);

  let sawRealNotFound = false;
  for (const i of order) {
    let res: Response;
    try {
      res = await fetch(urls[i], { signal: AbortSignal.timeout(45_000) });
    } catch {
      continue; // this host is unreachable → try the next one
    }
    if (res.ok) {
      if (workingBaseIndex !== i) {
        workingBaseIndex = i;
        process.stdout.write(`  (descargando vía ${hostOf(urls[i])})\n`);
      }
      return save(await res.text());
    }
    // A 404 for the always-present players file means this host is filtering
    // (some networks answer 404 instead of blocking); try the next source.
    // For season files a 404 can be genuine — but only trust it if the host
    // has already proven it works.
    if (res.status === 404 && !file.endsWith('_players.csv') && workingBaseIndex === i) {
      sawRealNotFound = true;
      break;
    }
  }

  if (sawRealNotFound) return null; // season genuinely not published yet
  return useGitFor(); // every HTTP source failed → git clone
}

/**
 * Check we can actually reach the data source before wiping anything. Returns
 * the number of players found in the first tour's players file (throws a
 * friendly error if unreachable via both HTTP and git).
 */
export async function preflight(tour: TourConfig): Promise<number> {
  const csv = await readRepoFile(tour.sackmann.repo, tour.sackmann.playersFile);
  if (!csv) throw new Error(`El archivo de jugadores de ${tour.id} no está disponible.`);
  return parsePlayers(csv).length;
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

// Column order of the players file in older snapshots, which ship WITHOUT a
// header row. Newer Sackmann files include one, so we detect and adapt.
const PLAYERS_COLUMNS = ['player_id', 'name_first', 'name_last', 'hand', 'dob', 'ioc', 'height', 'wikidata_id'];

// Rankings files ship without a header: ranking_date, rank, player_id, points.
const RANKINGS_COLUMNS = ['ranking_date', 'rank', 'player_id', 'points'];

/**
 * Ingest official ATP/WTA rankings (rank + points). Keeps only the most recent
 * snapshot per player, so the app can show a player's real ranking even when the
 * match history doesn't cover their career yet.
 */
export async function ingestRankings(tour: TourConfig): Promise<number> {
  const files = tour.sackmann.rankingsFiles ?? [];
  if (files.length === 0) return 0;
  const db = getDb();

  const upsert = db.prepare(
    `INSERT INTO player_rankings (player_id, tour, rank, points, ranking_date)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tour, player_id) DO UPDATE SET
       rank=excluded.rank, points=excluded.points, ranking_date=excluded.ranking_date
     WHERE excluded.ranking_date > player_rankings.ranking_date`,
  );

  let count = 0;
  for (const file of files) {
    const csv = await readRepoFile(tour.sackmann.repo, file);
    if (!csv) continue;
    const hasHeader = /^\s*ranking_date/i.test(csv);
    const rows = parse(csv, {
      columns: hasHeader ? true : RANKINGS_COLUMNS,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as any[];

    db.exec('BEGIN');
    for (const r of rows) {
      const id = num(r.player_id);
      const rank = num(r.rank);
      const date = String(r.ranking_date ?? '');
      if (id === null || rank === null || !date) continue;
      upsert.run(id, tour.id, rank, num(r.points), date);
      count++;
    }
    db.exec('COMMIT');
    process.stdout.write(`  ${file}: ${rows.length} filas de ranking\n`);
  }
  return count;
}

/** Parse a players CSV whether or not it has a header row. */
function parsePlayers(csv: string): any[] {
  const hasHeader = /^\s*player_id\b/i.test(csv);
  return parse(csv, {
    columns: hasHeader ? true : PLAYERS_COLUMNS,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as any[];
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
    const rows = parsePlayers(playersCsv);
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

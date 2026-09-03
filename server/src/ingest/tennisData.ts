// Ingest match history + HISTORICAL ODDS from tennis-data.co.uk (one spreadsheet
// per season, per tour).
//
// Why this source exists alongside TML:
//
//   • It covers the WTA. The Sackmann repos went 404 and TML is ATP-only, so
//     without this the women's tour has no data at all.
//   • It carries closing bookmaker odds for every match. That is what turns
//     "we can't tell whether the model beats the market" (docs/MODEL.md's most
//     honest limitation) into something measurable — see the --market flag of
//     `npm run backtest`.
//
// What it does NOT have: serve/return stats (aces, break points). So for the ATP
// the two sources are a trade-off, not an upgrade: TML gives richer per-match
// stats, tennis-data gives odds. Pick with `--source`.
//
// ---------------------------------------------------------------------------
// COLUMN MAPPING IS BY HEADER NAME, ON PURPOSE
// ---------------------------------------------------------------------------
// The layout has drifted over the years (bookmaker columns come and go, WTA
// files use "Tier" where ATP uses "Series"), and column ORDER is not something
// to rely on. So every field is located by header text, case-insensitively, and
// if a required one is missing the error lists the headers actually present
// instead of quietly ingesting nonsense. Optional fields simply stay null.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.ts';
import { RAW_DIR } from '../config.ts';
import { excelSerialToYmd, readSpreadsheet, type Grid } from './spreadsheet.ts';
import type { TourId } from '../types.ts';

/** Where a manually downloaded season file can be dropped. */
export const MANUAL_DIR = path.join(RAW_DIR, 'tennis-data');

/** URL patterns per tour. ATP lives under /{year}/, WTA under /{year}w/. */
const URLS: Record<string, string[]> = {
  atp: ['http://www.tennis-data.co.uk/{year}/{year}.xlsx'],
  wta: ['http://www.tennis-data.co.uk/{year}w/{year}.xlsx'],
};

/**
 * Header aliases, first match wins. Lowercased and stripped of spaces before
 * comparison, so "Best of" matches "bestof".
 */
const FIELDS = {
  date: ['date'],
  tournament: ['tournament'],
  location: ['location'],
  surface: ['surface'],
  round: ['round'],
  bestOf: ['bestof'],
  level: ['series', 'tier'],
  winner: ['winner'],
  loser: ['loser'],
  wRank: ['wrank'],
  lRank: ['lrank'],
  wPts: ['wpts'],
  lPts: ['lpts'],
  comment: ['comment'],
  // Odds: preference order matters. "Avg" is the average across books — the
  // closest thing to a consensus price, and the fairest yardstick for a model.
  // Pinnacle ("PS") is the sharpest single book; B365 the most widely present in
  // older files; "Max" is the best available price, which flatters the bettor and
  // is NOT what we want for measuring accuracy.
  wOdds: ['avgw', 'psw', 'b365w', 'maxw'],
  lOdds: ['avgl', 'psl', 'b365l', 'maxl'],
} as const;

type FieldName = keyof typeof FIELDS;
const REQUIRED: FieldName[] = ['date', 'tournament', 'surface', 'round', 'winner', 'loser'];

const norm = (s: string) => s.toLowerCase().replace(/[\s._-]/g, '');

/** Map each field to its column index (−1 when absent). */
function mapColumns(header: string[]): Record<FieldName, number> {
  const normalised = header.map((h) => norm(String(h ?? '')));
  const out = {} as Record<FieldName, number>;
  for (const [field, aliases] of Object.entries(FIELDS) as [FieldName, readonly string[]][]) {
    out[field] = -1;
    for (const alias of aliases) {
      const at = normalised.indexOf(alias);
      if (at !== -1) {
        out[field] = at;
        break;
      }
    }
  }
  return out;
}

/** Set-score columns: W1/L1 … W5/L5, however many the file happens to carry. */
function mapSetColumns(header: string[]): { w: number; l: number }[] {
  const normalised = header.map((h) => norm(String(h ?? '')));
  const sets: { w: number; l: number }[] = [];
  for (let i = 1; i <= 5; i++) {
    const w = normalised.indexOf(`w${i}`);
    const l = normalised.indexOf(`l${i}`);
    if (w !== -1 && l !== -1) sets.push({ w, l });
  }
  return sets;
}

/**
 * Rebuild a score string ("6-4 3-6 7-5") from the per-set columns so the
 * margin-of-victory K-factor and the retirement checks work exactly as they do
 * for TML data. A non-"Completed" comment is appended as RET, which is precisely
 * how gameDominance decides to ignore the margin.
 */
function buildScore(row: string[], sets: { w: number; l: number }[], comment: string): string | null {
  const parts: string[] = [];
  for (const s of sets) {
    const w = row[s.w]?.trim();
    const l = row[s.l]?.trim();
    if (!w || !l || !/^\d+$/.test(w) || !/^\d+$/.test(l)) break;
    parts.push(`${w}-${l}`);
  }
  const c = comment.trim().toLowerCase();
  const unfinished = c && c !== 'completed';
  if (parts.length === 0) return unfinished ? comment.trim().toUpperCase() : null;
  return unfinished ? `${parts.join(' ')} RET` : parts.join(' ');
}

/**
 * Normalise this source's round names ("1st Round", "The Final") to the codes the
 * rest of the app uses (R128…QF/SF/F).
 *
 * The numbered rounds can't be mapped in isolation — a 32-draw's "1st Round" is
 * R32, a Slam's is R128 — so they're assigned by counting how many rounds the
 * event actually has and labelling backwards from the final. That makes the codes
 * correct per tournament instead of merely plausible.
 */
const LADDER = ['F', 'SF', 'QF', 'R16', 'R32', 'R64', 'R128'];

function roundOrder(raw: string): number | null {
  const r = norm(raw);
  if (!r) return null;
  if (r.includes('final') && !r.includes('semi') && !r.includes('quarter')) return 0;
  if (r.includes('semi')) return 1;
  if (r.includes('quarter')) return 2;
  if (r.includes('roundrobin') || r === 'rr') return 99;
  const m = raw.match(/(\d+)/);
  // "4th Round" is closer to the final than "1st Round": invert to a distance.
  if (m) return 100 + (10 - Number(m[1]));
  return null;
}

function buildRoundMap(rawRounds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const unique = [...new Set(rawRounds.filter(Boolean))];
  const rr = unique.filter((r) => roundOrder(r) === 99);
  for (const r of rr) map.set(r, 'RR');

  // Order from latest (final) to earliest, then label along the ladder.
  const ordered = unique
    .filter((r) => roundOrder(r) !== 99 && roundOrder(r) !== null)
    .sort((a, b) => (roundOrder(a) as number) - (roundOrder(b) as number));
  ordered.forEach((raw, i) => map.set(raw, LADDER[i] ?? `R${Math.pow(2, i + 1)}`));
  return map;
}

/** Stable id for a player name (see the player_ids table in db.ts). */
const ID_BASE = 900_000;
function playerIdFor(tour: TourId, name: string): number {
  const db = getDb();
  const found = db
    .prepare('SELECT id FROM player_ids WHERE tour = ? AND name = ?')
    .get(tour, name) as unknown as { id: number } | undefined;
  if (found) return found.id;
  const max = (
    db.prepare('SELECT MAX(id) AS m FROM player_ids WHERE tour = ?').get(tour) as unknown as {
      m: number | null;
    }
  ).m;
  const id = Math.max(ID_BASE, (max ?? 0) + 1);
  db.prepare('INSERT INTO player_ids (tour, name, id) VALUES (?, ?, ?)').run(tour, name, id);
  return id;
}

/** A YYYYMMDD date from either an Excel serial or a text date. */
function parseDate(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const serial = excelSerialToYmd(v);
  if (serial) return serial;
  // dd/mm/yyyy — the site's text format. Also accepts yyyy-mm-dd.
  let m = v.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`;
  }
  m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}`;
  return null;
}

const SURFACES = new Set(['hard', 'clay', 'grass', 'carpet']);

function cleanSurface(raw: string): string | null {
  const s = (raw ?? '').trim();
  return SURFACES.has(s.toLowerCase()) ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null;
}

function num(raw: string | undefined): number | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface SeasonResult {
  year: number;
  matches: number;
  withOdds: number;
  skipped: number;
}

/**
 * Parse one season file into rows ready for insertion. Exported so it can be
 * tested against a fixture without any network access — which matters, because
 * the real host is not reachable from every environment.
 */
export function parseSeason(
  grid: Grid,
  tour: TourId,
  source: string,
): { rows: InsertableMatch[]; skipped: number } {
  // Some files carry a blank leading row; the header is the first row that has a
  // recognisable "Winner" column.
  const headerAt = grid.findIndex((r) => mapColumns(r).winner !== -1 && mapColumns(r).loser !== -1);
  if (headerAt === -1) {
    const first = (grid[0] ?? []).filter(Boolean).join(', ');
    throw new Error(
      `${source}: no encuentro las columnas obligatorias. Cabeceras vistas: ` +
        `[${first || '(vacío)'}]. Se esperaban al menos: Date, Tournament, Surface, Round, ` +
        `Winner, Loser. ¿Es un archivo de tennis-data.co.uk?`,
    );
  }

  const header = grid[headerAt];
  const col = mapColumns(header);
  const missing = REQUIRED.filter((f) => col[f] === -1);
  if (missing.length) {
    throw new Error(
      `${source}: faltan columnas obligatorias (${missing.join(', ')}). ` +
        `Cabeceras encontradas: [${header.filter(Boolean).join(', ')}].`,
    );
  }
  const setCols = mapSetColumns(header);
  const body = grid.slice(headerAt + 1);

  // Round codes depend on the draw size, so they're resolved per tournament+year.
  const roundMaps = new Map<string, Map<string, string>>();
  const groupKey = (row: string[]) =>
    `${(row[col.tournament] ?? '').trim()}|${(parseDate(row[col.date] ?? '') ?? '').slice(0, 4)}`;
  const grouped = new Map<string, string[]>();
  for (const row of body) {
    const k = groupKey(row);
    const arr = grouped.get(k) ?? [];
    arr.push((row[col.round] ?? '').trim());
    grouped.set(k, arr);
  }
  for (const [k, rounds] of grouped) roundMaps.set(k, buildRoundMap(rounds));

  const rows: InsertableMatch[] = [];
  let skipped = 0;
  for (const row of body) {
    const winner = (row[col.winner] ?? '').trim();
    const loser = (row[col.loser] ?? '').trim();
    const date = parseDate(row[col.date] ?? '');
    if (!winner || !loser || !date) {
      skipped++;
      continue;
    }
    const tournament = (row[col.tournament] ?? '').trim() || null;
    const comment = col.comment === -1 ? '' : (row[col.comment] ?? '');
    const rawRound = (row[col.round] ?? '').trim();

    rows.push({
      tour,
      tourney_id: null,
      tourney_name: tournament,
      tourney_date: date,
      surface: cleanSurface(row[col.surface] ?? ''),
      level: col.level === -1 ? null : (row[col.level] ?? '').trim() || null,
      round: roundMaps.get(groupKey(row))?.get(rawRound) ?? (rawRound || null),
      best_of: col.bestOf === -1 ? null : num(row[col.bestOf]),
      winnerName: winner,
      loserName: loser,
      score: buildScore(row, setCols, comment),
      winner_rank: col.wRank === -1 ? null : num(row[col.wRank]),
      loser_rank: col.lRank === -1 ? null : num(row[col.lRank]),
      winner_points: col.wPts === -1 ? null : num(row[col.wPts]),
      loser_points: col.lPts === -1 ? null : num(row[col.lPts]),
      // Odds below 1.0 are impossible in decimal format — treat as missing
      // rather than letting them poison the market comparison.
      w_odds: validOdds(col.wOdds === -1 ? null : num(row[col.wOdds])),
      l_odds: validOdds(col.lOdds === -1 ? null : num(row[col.lOdds])),
    });
  }
  return { rows, skipped };
}

function validOdds(n: number | null): number | null {
  return n != null && n > 1.0 && n < 1000 ? n : null;
}

export interface InsertableMatch {
  tour: TourId;
  tourney_id: string | null;
  tourney_name: string | null;
  tourney_date: string;
  surface: string | null;
  level: string | null;
  round: string | null;
  best_of: number | null;
  winnerName: string;
  loserName: string;
  score: string | null;
  winner_rank: number | null;
  loser_rank: number | null;
  /** Ranking points, carried to seed player_rankings (not stored on matches). */
  winner_points: number | null;
  loser_points: number | null;
  w_odds: number | null;
  l_odds: number | null;
}

/** Find a season file the user downloaded by hand (any of several namings). */
function manualFile(tour: TourId, year: number): string | null {
  if (!fs.existsSync(MANUAL_DIR)) return null;
  const candidates = fs
    .readdirSync(MANUAL_DIR)
    .filter((f) => /\.(xlsx|csv|tsv)$/i.test(f))
    .filter((f) => f.includes(String(year)));
  // Prefer a file that also names the tour, so atp-2024 and wta-2024 can coexist.
  const tagged = candidates.find((f) => norm(f).includes(tour));
  const chosen = tagged ?? (candidates.length === 1 ? candidates[0] : null);
  return chosen ? path.join(MANUAL_DIR, chosen) : null;
}

async function downloadSeason(tour: TourId, year: number): Promise<string | null> {
  const cacheDir = path.join(RAW_DIR, 'tennis-data-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, `${tour}-${year}.xlsx`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return dest;

  for (const tpl of URLS[tour] ?? []) {
    const url = tpl.replace(/\{year\}/g, String(year));
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // A blocked request often returns a short HTML/text error page with a 200.
      if (buf.length < 1000 || buf.subarray(0, 2).toString() !== 'PK') continue;
      fs.writeFileSync(dest, buf);
      return dest;
    } catch {
      // try the next pattern
    }
  }
  return null;
}

/** Ingest a range of seasons for one tour. Returns per-season counts. */
export async function ingestTennisData(
  tour: TourId,
  opts: { fromYear: number; toYear: number },
): Promise<SeasonResult[]> {
  const db = getDb();
  const insertPlayer = db.prepare(
    `INSERT INTO players (id, tour, name, hand, country, birthdate)
     VALUES (?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(tour, id) DO UPDATE SET name = excluded.name`,
  );
  const insertMatch = db.prepare(
    `INSERT INTO matches
       (tour, tourney_id, tourney_name, tourney_date, surface, level, round, best_of,
        winner_id, loser_id, score, winner_rank, loser_rank, w_odds, l_odds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertRanking = db.prepare(
    `INSERT INTO player_rankings (player_id, tour, rank, points, ranking_date)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tour, player_id) DO UPDATE SET
       rank = excluded.rank, points = excluded.points, ranking_date = excluded.ranking_date`,
  );

  // This source has no separate rankings file, but every match row carries each
  // player's rank and points on that date. Keeping the most recent one per player
  // gives the dashboard the same "official ranking" it shows for the ATP.
  const latestRank = new Map<number, { rank: number; points: number | null; date: string }>();
  const noteRank = (id: number, rank: number | null, points: number | null, date: string) => {
    if (rank == null || rank <= 0) return;
    const prev = latestRank.get(id);
    if (!prev || date > prev.date) latestRank.set(id, { rank, points, date });
  };

  const out: SeasonResult[] = [];
  const failures: string[] = [];

  for (let year = opts.fromYear; year <= opts.toYear; year++) {
    const manual = manualFile(tour, year);
    const file = manual ?? (await downloadSeason(tour, year));
    if (!file) {
      failures.push(String(year));
      continue;
    }
    const label = `${path.basename(file)}${manual ? ' (copia manual)' : ''}`;
    const { rows, skipped } = parseSeason(readSpreadsheet(file), tour, label);

    let withOdds = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const wid = playerIdFor(tour, r.winnerName);
        const lid = playerIdFor(tour, r.loserName);
        insertPlayer.run(wid, tour, r.winnerName);
        insertPlayer.run(lid, tour, r.loserName);
        insertMatch.run(
          r.tour, r.tourney_id, r.tourney_name, r.tourney_date, r.surface, r.level,
          r.round, r.best_of, wid, lid, r.score, r.winner_rank, r.loser_rank,
          r.w_odds, r.l_odds,
        );
        if (r.w_odds != null && r.l_odds != null) withOdds++;
        noteRank(wid, r.winner_rank, r.winner_points, r.tourney_date);
        noteRank(lid, r.loser_rank, r.loser_points, r.tourney_date);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    out.push({ year, matches: rows.length, withOdds, skipped });
    process.stdout.write(
      `  ${year}: ${rows.length} partidos (${withOdds} con cuotas)` +
        `${skipped ? `, ${skipped} filas descartadas` : ''} — ${label}\n`,
    );
  }

  if (latestRank.size > 0) {
    db.exec('BEGIN');
    try {
      for (const [id, r] of latestRank) insertRanking.run(id, tour, r.rank, r.points, r.date);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    process.stdout.write(`  rankings oficiales: ${latestRank.size} jugadores\n`);
  }

  if (failures.length) {
    process.stderr.write(
      `\n  ⚠️  No se pudieron obtener las temporadas: ${failures.join(', ')}.\n` +
        `      tennis-data.co.uk puede estar bloqueado en tu red. Descárgalas a mano:\n` +
        `        1. Abre http://www.tennis-data.co.uk/alldata.php\n` +
        `        2. Baja el .xlsx de cada temporada (columna ATP o WTA).\n` +
        `        3. Guárdalos como ${MANUAL_DIR}/${tour}-<año>.xlsx\n` +
        `        4. Vuelve a ejecutar el comando.\n`,
    );
  }
  return out;
}

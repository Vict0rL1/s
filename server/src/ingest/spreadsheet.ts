// Minimal spreadsheet reader for .xlsx / .csv, with no new dependencies.
//
// Needed because tennis-data.co.uk publishes one .xlsx per season. An .xlsx is
// just a ZIP of XML, and the project already shells out to `unzip` for the
// manual GitHub-ZIP route, so the same tool covers this: read the two entries we
// care about straight to stdout, no temp directory involved.
//
// This is deliberately a READER, not a spreadsheet library: it returns a grid of
// strings and knows nothing about types, formulas or styles. Anything smarter
// (dates, numbers, header mapping) is the caller's job — see tennisData.ts.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'csv-parse/sync';

/** A sheet as rows of raw cell text. Ragged: trailing empty cells are absent. */
export type Grid = string[][];

/** Read .xlsx or .csv/.tsv into a grid. Throws with a clear message otherwise. */
export function readSpreadsheet(filePath: string): Grid {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    return parse(fs.readFileSync(filePath, 'utf8'), {
      relaxColumnCount: true,
      relaxQuotes: true,
      skipEmptyLines: true,
      delimiter: lower.endsWith('.tsv') ? '\t' : ',',
      bom: true,
    }) as Grid;
  }
  if (lower.endsWith('.xlsx')) return readXlsx(filePath);
  if (lower.endsWith('.xls')) {
    // The legacy binary .xls format is a different container entirely; parsing it
    // would mean a real library. Saying so beats failing obscurely.
    throw new Error(
      `El formato .xls antiguo no se puede leer sin dependencias extra. ` +
        `Ábrelo y guárdalo como .xlsx o .csv, y vuelve a intentarlo: ${filePath}`,
    );
  }
  throw new Error(`Formato no soportado (usa .xlsx o .csv): ${filePath}`);
}

/** List entry names inside a ZIP. */
function zipEntries(zipPath: string): string[] {
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 1 << 24 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Read one ZIP entry as text ('' when the entry is absent). */
function zipRead(zipPath: string, entry: string): string {
  try {
    return execFileSync('unzip', ['-p', zipPath, entry], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
  } catch {
    return '';
  }
}

function readXlsx(filePath: string): Grid {
  let entries: string[];
  try {
    entries = zipEntries(filePath);
  } catch (e) {
    throw new Error(
      `No se pudo abrir ${filePath} como .xlsx (¿está corrupto o incompleto?): ${(e as Error).message}`,
    );
  }

  // Lowest-numbered worksheet = the first tab. These files have exactly one.
  const sheetEntry = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]))[0];
  if (!sheetEntry) {
    throw new Error(`${filePath} no contiene ninguna hoja (xl/worksheets/sheetN.xml).`);
  }

  const shared = parseSharedStrings(zipRead(filePath, 'xl/sharedStrings.xml'));
  return parseSheet(zipRead(filePath, sheetEntry), shared);
}

/**
 * The shared string table: every distinct text in the workbook, referenced by
 * index from cells with t="s". Rich text splits one string across several <t>
 * runs, which must be concatenated — otherwise "Del Potro J.M." loses pieces.
 */
function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.match(/<si>[\s\S]*?<\/si>|<si\/>/g) ?? []) {
    const runs = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    out.push(runs.map((t) => unescapeXml(t.replace(/<[^>]+>/g, ''))).join(''));
  }
  return out;
}

/** Column letters to a 0-based index: A→0, Z→25, AA→26. */
function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[]): Grid {
  if (!xml) return [];
  const grid: Grid = [];
  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) ?? []) {
    const row: string[] = [];
    for (const cellXml of rowXml.match(/<c[^>]*>[\s\S]*?<\/c>|<c[^>]*\/>/g) ?? []) {
      const ref = cellXml.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = cellXml.match(/\bt="([^"]+)"/)?.[1] ?? 'n';
      let value = '';
      if (type === 'inlineStr') {
        const runs = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
        value = runs.map((t) => unescapeXml(t.replace(/<[^>]+>/g, ''))).join('');
      } else {
        const raw = cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '';
        if (type === 's') {
          value = shared[Number(raw)] ?? '';
        } else {
          value = unescapeXml(raw);
        }
      }
      // Honour the cell reference so a sparse row keeps its columns aligned;
      // ignoring it would shift every value left of a blank cell.
      const at = ref ? colIndex(ref) : row.length;
      while (row.length < at) row.push('');
      row[at] = value;
    }
    grid.push(row);
  }
  return grid;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Excel stores dates as days since 1899-12-30. Returns YYYYMMDD, or null when
 * the value is not a plausible date serial — so a stray number in the column is
 * rejected instead of silently becoming a date in 1901.
 */
export function excelSerialToYmd(value: string): string | null {
  const n = Number(value);
  // ~1970-01-01 (25569) to ~2100 (73415): anything outside is not a date here.
  if (!Number.isFinite(n) || n < 25569 || n > 73415) return null;
  const ms = Math.round(n) * 86_400_000 + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  );
}

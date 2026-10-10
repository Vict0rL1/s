// Exportaciones (Fase 3.4): los conjuntos que alguien querría abrir en una hoja de cálculo o
// pasar a otra herramienta, con filtros de fecha y deporte, en CSV (RFC 4180) o JSON.
// Solo lectura: nada de aquí escribe en la base.

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.ts';
import { ROOT } from '../config.ts';
import { SPORT_IDS } from '../sports.ts';

export const DATASETS = ['predicciones', 'apuestas', 'papel', 'snapshots', 'benchmark'] as const;
export type Dataset = (typeof DATASETS)[number];

export interface Filtros {
  /** YYYY-MM-DD, inclusive. */
  desde?: string;
  hasta?: string;
  sport?: string;
}

export interface Exportacion {
  columnas: string[];
  datos: Record<string, unknown>[];
}

const fechaIso = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/** Los siete registros de predicciones, con las mismas columnas. */
function predicciones(f: Filtros): Exportacion {
  const db = getDb();
  const fuentes: { sport: string; tabla: string; sql: string }[] = [
    { sport: 'tennis', tabla: 'prediction_log', sql: "SELECT 'tennis' AS sport, match_key, predicted_at, commence_time, p_a AS prob_a, p_b AS prob_b, NULL AS prob_draw, outcome, model_version FROM prediction_log" },
    { sport: 'football', tabla: 'fb_prediction_log', sql: "SELECT 'football' AS sport, match_key, predicted_at, commence_time, prob_home AS prob_a, prob_away AS prob_b, prob_draw, outcome, model_version FROM fb_prediction_log" },
    { sport: 'basketball', tabla: 'bb_prediction_log', sql: "SELECT 'basketball' AS sport, match_key, predicted_at, commence_time, prob_home AS prob_a, 1 - prob_home AS prob_b, NULL AS prob_draw, outcome, model_version FROM bb_prediction_log" },
    { sport: 'baseball', tabla: 'bsb_prediction_log', sql: "SELECT 'baseball' AS sport, match_key, predicted_at, commence_time, prob_home AS prob_a, 1 - prob_home AS prob_b, NULL AS prob_draw, outcome, model_version FROM bsb_prediction_log" },
    { sport: 'nfl', tabla: 'naf_prediction_log', sql: "SELECT 'nfl' AS sport, match_key, predicted_at, commence_time, prob_home AS prob_a, prob_away AS prob_b, NULL AS prob_draw, outcome, model_version FROM naf_prediction_log" },
    {
      sport: 'nhl',
      tabla: 'nhl_prediction_log',
      sql: "SELECT 'nhl' AS sport, match_key, predicted_at, commence_time, COALESCE(shown_home, prob_home) AS prob_a, 1 - COALESCE(shown_home, prob_home) AS prob_b, NULL AS prob_draw, CASE WHEN home_goals IS NULL THEN NULL WHEN home_goals > away_goals THEN 'home' ELSE 'away' END AS outcome, model_version FROM nhl_prediction_log",
    },
    {
      sport: 'ufc',
      tabla: 'ufc_prediction_log',
      // a = el luchador A (home_*), b = el B; empate y «sin resultado» se exportan como tales.
      sql: "SELECT 'ufc' AS sport, match_key, predicted_at, commence_time, COALESCE(shown_home, prob_home) AS prob_a, 1 - COALESCE(shown_home, prob_home) AS prob_b, NULL AS prob_draw, CASE outcome WHEN 'A' THEN 'home' WHEN 'B' THEN 'away' WHEN 'EMPATE' THEN 'draw' WHEN 'NC' THEN 'no_contest' ELSE NULL END AS outcome, model_version FROM ufc_prediction_log",
    },
  ];
  const datos: Record<string, unknown>[] = [];
  for (const x of fuentes) {
    if (f.sport && f.sport !== x.sport) continue;
    let filas: Record<string, unknown>[];
    try {
      filas = db.prepare(`${x.sql} ORDER BY predicted_at`).all() as Record<string, unknown>[];
    } catch {
      // Una columna con otro nombre en un deporte: se exporta lo que la tabla tenga.
      try {
        filas = (db.prepare(`SELECT * FROM ${x.tabla}`).all() as Record<string, unknown>[]).map((r) => ({ sport: x.sport, ...r }));
      } catch {
        continue;
      }
    }
    datos.push(...filas.filter((r) => enRango(String(r.predicted_at ?? r.commence_time ?? ''), f)));
  }
  return { columnas: ['sport', 'match_key', 'predicted_at', 'commence_time', 'prob_a', 'prob_b', 'prob_draw', 'outcome', 'model_version'], datos };
}

function enRango(fecha: string, f: Filtros): boolean {
  const d = fecha.slice(0, 10).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const desde = fechaIso(f.desde);
  const hasta = fechaIso(f.hasta);
  if (desde && d < desde) return false;
  if (hasta && d > hasta) return false;
  return true;
}

function tabla(nombre: string, columnaFecha: string, f: Filtros, columnaSport = 'sport'): Exportacion {
  const db = getDb();
  const cols = (db.prepare(`PRAGMA table_info(${nombre})`).all() as unknown as { name: string }[]).map((c) => c.name);
  const cond: string[] = [];
  const args: unknown[] = [];
  if (fechaIso(f.desde)) {
    cond.push(`substr(${columnaFecha}, 1, 10) >= ?`);
    args.push(f.desde);
  }
  if (fechaIso(f.hasta)) {
    cond.push(`substr(${columnaFecha}, 1, 10) <= ?`);
    args.push(f.hasta);
  }
  if (f.sport && cols.includes(columnaSport)) {
    cond.push(`${columnaSport} = ?`);
    args.push(f.sport);
  }
  const datos = db.prepare(`SELECT * FROM ${nombre}${cond.length ? ` WHERE ${cond.join(' AND ')}` : ''} ORDER BY ${columnaFecha}, rowid LIMIT 200000`).all(...(args as never[])) as Record<string, unknown>[];
  return { columnas: cols, datos };
}

/** Las tablas del walk-forward por deporte, aplanadas: una fila por deporte y periodo. */
function benchmark(f: Filtros): Exportacion {
  const datos: Record<string, unknown>[] = [];
  for (const sport of SPORT_IDS) {
    if (f.sport && f.sport !== sport) continue;
    const p = path.join(ROOT, 'experiments', 'walkforward', `${sport}.json`);
    if (!fs.existsSync(p)) continue;
    let wf: { periodos?: { periodo: string; n: number; modelo?: { logLoss?: number | null; brier?: number | null }; recalibrado?: { logLoss?: number | null }; baselines?: Record<string, { logLoss?: number | null }>; mercado?: { logLoss?: number | null } | null }[] };
    try {
      wf = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    for (const x of wf.periodos ?? []) {
      const fila: Record<string, unknown> = { sport, periodo: x.periodo, n: x.n, modelo_logloss: x.modelo?.logLoss ?? null, modelo_brier: x.modelo?.brier ?? null, recalibrado_logloss: x.recalibrado?.logLoss ?? null, mercado_logloss: x.mercado?.logLoss ?? null };
      for (const [b, v] of Object.entries(x.baselines ?? {})) fila[`baseline_${b.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_logloss`] = v?.logLoss ?? null;
      datos.push(fila);
    }
  }
  const columnas = [...new Set(datos.flatMap((d) => Object.keys(d)))];
  return { columnas, datos };
}

export function exportar(dataset: Dataset, f: Filtros = {}): Exportacion {
  switch (dataset) {
    case 'predicciones':
      return predicciones(f);
    case 'apuestas':
      return tabla('bets', 'placed_on', f);
    case 'papel':
      return tabla('paper_bets', 'placed_at', f);
    case 'snapshots':
      return tabla('odds_snapshots', 'observed_at', f);
    case 'benchmark':
      return benchmark(f);
  }
}

/** CSV según RFC 4180: comillas dobles cuando hace falta, dobladas dentro, CRLF. */
export function aCsv(columnas: string[], datos: Record<string, unknown>[]): string {
  const celda = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [columnas.map(celda).join(',')];
  for (const d of datos) lineas.push(columnas.map((c) => celda(d[c])).join(','));
  return lineas.join('\r\n') + '\r\n';
}

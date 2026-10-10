// Consultas de la UFC publicada: el estado de cada luchador, su ficha, la clasificación, las peleas que
// vienen y el cara a cara.
//
// Como en la NHL, el Elo NO se guarda en una tabla: se recorre el archivo entero (9.000 peleas, unos
// milisegundos) con el MISMO `recorrer` del backtest, y de ese recorrido salen también los pesos de la
// logística (ajustada con todas las peleas decididas ANTES del holdout, que no se toca). Se guarda en
// memoria hasta que cambia el archivo: lo que se publica es exactamente lo que se midió.

import { getDb } from '../db.ts';
import { freshFilter } from '../freshness.ts';
import { FINAL_HOLDOUT_FROM } from '../experiments/holdout.ts';
import { UFC } from './model.ts';
import { leerFichas, leerPeleas, recorrer, edadEn, type FichaUfc } from './evaluacion.ts';
import { pesosVigentes } from './combinado.ts';

export interface UfcUpcomingRow {
  id: string;
  league: string;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  odds_home: number | null;
  odds_away: number | null;
  books: number;
  source: 'live';
  updated_at: string;
}

interface Estado {
  elo: Map<string, number>;
  peleas: Map<string, number>;
  victorias: Map<string, number>;
  fichas: Map<string, FichaUfc>;
  /** Los pesos de la logística publicada, en el orden de `CANDIDATOS[MODELO_PUBLICADO]`. */
  pesos: number[];
  /** Peleas decididas con las que se ajustaron (todas las anteriores al holdout). */
  ajustadaCon: number;
  ultimaFecha: string | null;
}

let memo: { firma: string; estado: Estado } | null = null;

function firmaArchivo(): { firma: string; ultima: string | null } {
  const d = getDb();
  const f = d.prepare('SELECT COUNT(*) AS n, MAX(ingested_at) AS i, MAX(fecha) AS u FROM ufc_fights').get() as { n: number; i: string | null; u: string | null };
  const l = d.prepare('SELECT COUNT(*) AS n FROM ufc_fighters').get() as { n: number };
  return { firma: `${f.n}|${f.i}|${f.u}|${l.n}`, ultima: f.u };
}

/** El estado tras la última pelea del archivo, y los pesos vigentes. */
export function estadoUfc(): Estado {
  const { firma, ultima } = firmaArchivo();
  if (memo?.firma === firma) return memo.estado;
  const fichas = leerFichas();
  const r = recorrer(leerPeleas(), UFC, fichas);
  const ajuste = pesosVigentes(r.pasos);
  const estado: Estado = { ...r.estado, fichas, pesos: ajuste.pesos, ajustadaCon: ajuste.n, ultimaFecha: ultima };
  memo = { firma, estado };
  return estado;
}

export const countFights = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM ufc_fights').get() as { n: number }).n;
export const countFighters = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM ufc_fighters').get() as { n: number }).n;
export const latestDate = (): string | null => (getDb().prepare('SELECT MAX(fecha) AS d FROM ufc_fights').get() as { d: string | null }).d;
/** El primer año del holdout: los pesos se ajustan con lo anterior. */
export const HOLDOUT_UFC = FINAL_HOLDOUT_FROM.ufc;

export type ResultadoPelea = 'W' | 'L' | 'D' | 'NC';

export interface UfcFighterInfo {
  id: string;
  name: string;
  nickname: string | null;
  elo: number;
  /** Puesto por Elo entre los luchadores en activo (una pelea en los dos últimos años). */
  eloRank: number | null;
  /** Peleas en la UFC detrás de su Elo (empates y «sin resultado» incluidos). */
  fightsInDb: number;
  record: { wins: number; losses: number; draws: number; noContests: number };
  /** El récord suavizado que usa el modelo: (victorias + 1) / (peleas + 2). */
  smoothedRecord: number;
  age: number | null;
  birthDate: string | null;
  heightCm: number | null;
  reachCm: number | null;
  stance: string | null;
  weightClass: string | null;
  lastDate: string | null;
  form: { date: string; opponentId: string | null; opponentName: string; result: ResultadoPelea; method: string | null; round: number | null }[];
}

/** Cuántos días sin pelear dejan a un luchador fuera de la clasificación de «en activo». */
export const DIAS_ACTIVO = 730;

interface FilaPelea {
  id: string;
  fecha: string;
  luchador_a: string | null;
  luchador_b: string | null;
  nombre_a: string;
  nombre_b: string;
  resultado: 'A' | 'B' | 'EMPATE' | 'NC';
  categoria: string | null;
  metodo: string | null;
  asalto: number | null;
}

/**
 * Las peleas de un luchador, de la más reciente a la más antigua. Las MISMAS que cuenta el modelo:
 * atribuidas a los dos lados (el recorrido salta las que no), así que el récord de la ficha cuadra con
 * las peleas detrás de su Elo.
 */
function peleasDe(id: string): FilaPelea[] {
  const atribuida = 'ambigua = 0 AND luchador_a IS NOT NULL AND luchador_b IS NOT NULL AND luchador_a <> luchador_b';
  return getDb()
    .prepare(
      `SELECT * FROM (
         SELECT id, fecha, orden, luchador_a, luchador_b, nombre_a, nombre_b, resultado, categoria, metodo, asalto FROM ufc_fights WHERE luchador_a = ? AND ${atribuida}
         UNION ALL
         SELECT id, fecha, orden, luchador_a, luchador_b, nombre_a, nombre_b, resultado, categoria, metodo, asalto FROM ufc_fights WHERE luchador_b = ? AND ${atribuida}
       ) ORDER BY fecha DESC, orden ASC`,
    )
    .all(id, id) as unknown as FilaPelea[];
}

function resultadoPara(id: string, f: FilaPelea): ResultadoPelea {
  if (f.resultado === 'EMPATE') return 'D';
  if (f.resultado === 'NC') return 'NC';
  const esA = f.luchador_a === id;
  return (f.resultado === 'A') === esA ? 'W' : 'L';
}

function activos(e: Estado, hoy: string): string[] {
  const corte = new Date(Date.parse(hoy) - DIAS_ACTIVO * 86_400_000).toISOString().slice(0, 10);
  const ultimas = getDb()
    .prepare(
      `SELECT id, MAX(fecha) AS u FROM (
         SELECT luchador_a AS id, fecha FROM ufc_fights WHERE luchador_a IS NOT NULL AND ambigua = 0
         UNION ALL SELECT luchador_b AS id, fecha FROM ufc_fights WHERE luchador_b IS NOT NULL AND ambigua = 0
       ) GROUP BY id HAVING u >= ?`,
    )
    .all(corte) as { id: string; u: string }[];
  return ultimas.map((r) => r.id).filter((id) => e.elo.has(id));
}

export function getFighterInfo(id: string, ahora = new Date()): UfcFighterInfo | null {
  const e = estadoUfc();
  const ficha = getDb().prepare('SELECT id, nombre, apodo, altura_cm, alcance_cm, guardia, nacimiento FROM ufc_fighters WHERE id = ?').get(id) as
    | { id: string; nombre: string; apodo: string | null; altura_cm: number | null; alcance_cm: number | null; guardia: string | null; nacimiento: string | null }
    | undefined;
  if (!ficha) return null;
  const filas = peleasDe(id);
  const record = { wins: 0, losses: 0, draws: 0, noContests: 0 };
  for (const f of filas) {
    const r = resultadoPara(id, f);
    if (r === 'W') record.wins++;
    else if (r === 'L') record.losses++;
    else if (r === 'D') record.draws++;
    else record.noContests++;
  }
  const hoy = ahora.toISOString().slice(0, 10);
  const enActivo = activos(e, hoy);
  const elo = e.elo.get(id) ?? UFC.inicial;
  const enLista = enActivo.includes(id);
  const peleas = e.peleas.get(id) ?? 0;
  return {
    id,
    name: ficha.nombre,
    nickname: ficha.apodo,
    elo,
    eloRank: enLista ? enActivo.filter((o) => (e.elo.get(o) ?? 0) > elo).length + 1 : null,
    fightsInDb: peleas,
    record,
    smoothedRecord: ((e.victorias.get(id) ?? 0) + 1) / (peleas + 2),
    age: edadEn(ficha.nacimiento, hoy),
    birthDate: ficha.nacimiento,
    heightCm: ficha.altura_cm,
    reachCm: ficha.alcance_cm,
    stance: ficha.guardia,
    weightClass: filas[0]?.categoria?.replace(/\s*(Title\s*)?Bout$/i, '').trim() || null,
    lastDate: filas[0]?.fecha ?? null,
    form: filas.slice(0, 10).map((f) => {
      const esA = f.luchador_a === id;
      return {
        date: f.fecha,
        opponentId: esA ? f.luchador_b : f.luchador_a,
        opponentName: esA ? f.nombre_b : f.nombre_a,
        result: resultadoPara(id, f),
        method: f.metodo?.trim() || null,
        round: f.asalto,
      };
    }),
  };
}

/** Clasificación por Elo de los luchadores en activo (todas las categorías juntas: el Elo no las separa). */
export function getPowerRanking(limit = 40, ahora = new Date()): { id: string; name: string; elo: number; fights: number }[] {
  const e = estadoUfc();
  const ids = activos(e, ahora.toISOString().slice(0, 10));
  const nombres = new Map((getDb().prepare('SELECT id, nombre FROM ufc_fighters').all() as { id: string; nombre: string }[]).map((r) => [r.id, r.nombre]));
  return ids
    .map((id) => ({ id, name: nombres.get(id) ?? id, elo: e.elo.get(id)!, fights: e.peleas.get(id) ?? 0 }))
    .sort((a, b) => b.elo - a.elo)
    .slice(0, limit);
}

/** Las peleas anteriores entre los dos, de la más reciente a la más antigua. */
export function getHeadToHead(a: string, b: string) {
  const filas = getDb()
    .prepare(
      `SELECT id, fecha, luchador_a, luchador_b, nombre_a, nombre_b, resultado, categoria, metodo, asalto FROM ufc_fights
        WHERE ambigua = 0 AND ((luchador_a = ? AND luchador_b = ?) OR (luchador_a = ? AND luchador_b = ?))
        ORDER BY fecha DESC`,
    )
    .all(a, b, b, a) as unknown as FilaPelea[];
  return filas.map((f) => ({ date: f.fecha, result: resultadoPara(a, f), method: f.metodo?.trim() || null, round: f.asalto }));
}

const COLUMNAS = 'id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, books, source, updated_at';

export function listUpcoming(limit = 40): UfcUpcomingRow[] {
  const fresh = freshFilter();
  return getDb()
    .prepare(`SELECT ${COLUMNAS} FROM ufc_upcoming WHERE ${fresh.sql} ORDER BY commence_time, id LIMIT ?`)
    .all(...fresh.params, limit) as unknown as UfcUpcomingRow[];
}

export function getUpcoming(id: string): UfcUpcomingRow | null {
  return (getDb().prepare(`SELECT ${COLUMNAS} FROM ufc_upcoming WHERE id = ?`).get(id) as unknown as UfcUpcomingRow | undefined) ?? null;
}

export function lastOddsUpdate(): string | null {
  return (getDb().prepare('SELECT MAX(updated_at) AS t FROM ufc_upcoming').get() as { t: string | null }).t;
}

/** Para los tests: olvida el estado. */
export function olvidarEstado(): void {
  memo = null;
}

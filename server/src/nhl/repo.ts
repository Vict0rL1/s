// Consultas de la NHL publicada: el Elo de hoy, la ficha de cada equipo, los próximos partidos y el
// cara a cara.
//
// El Elo NO se guarda en una tabla: se recorre el archivo entero (22.000 partidos, unos milisegundos)
// con los MISMOS `actualizar` y parámetros que el backtest, y se guarda en memoria hasta que cambia
// `nhl_games`. Así lo que se publica es exactamente lo que se midió, sin una segunda copia que pueda
// quedarse vieja.

import { getDb } from '../db.ts';
import { freshFilter } from '../freshness.ts';
import { NHL, actualizar } from './model.ts';
import { FRANQUICIAS, nombreDe } from './equipos.ts';

export interface NhlUpcomingRow {
  id: string;
  league: string;
  season: number | null;
  game_id: number | null;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  odds_home: number | null;
  odds_away: number | null;
  total_line: number | null;
  odds_over: number | null;
  odds_under: number | null;
  books: number;
  source: 'live' | 'schedule';
  updated_at: string;
}

export interface NhlRecord {
  wins: number;
  losses: number;
}

export interface NhlTeamInfo {
  id: string;
  name: string;
  elo: number;
  eloRank: number;
  /** Partidos del archivo detrás de su Elo. */
  gamesInDb: number;
  /** La temporada de su último partido y lo que lleva en ella. */
  season: number | null;
  record: NhlRecord;
  homeRecord: NhlRecord;
  awayRecord: NhlRecord;
  /** Goles a favor y en contra por partido en esa temporada (marcador final, la tanda cuenta uno). */
  goalsFor: number | null;
  goalsAgainst: number | null;
  lastDate: string | null;
  form: { date: string; opponentId: string; opponentName: string; home: boolean; result: 'W' | 'L'; goalsFor: number; goalsAgainst: number }[];
}

interface Estado {
  elo: Map<string, number>;
  partidos: Map<string, number>;
  ultimo: Map<string, string>;
  ultimaFecha: string | null;
  ultimaTemporada: number | null;
}

let memo: { firma: string; estado: Estado } | null = null;

/** El Elo de cada equipo tras el último partido del archivo. */
export function estadoElo(): Estado {
  const d = getDb();
  const f = d.prepare('SELECT COUNT(*) AS n, MAX(ingested_at) AS i, MAX(game_date) AS u FROM nhl_games').get() as { n: number; i: string | null; u: string | null };
  const firma = `${f.n}|${f.i}|${f.u}`;
  if (memo?.firma === firma) return memo.estado;
  const filas = d.prepare('SELECT season, game_date, home_id, away_id, home_goals, away_goals FROM nhl_games ORDER BY game_date, id').all() as {
    season: number;
    game_date: string;
    home_id: string;
    away_id: string;
    home_goals: number;
    away_goals: number;
  }[];
  const elo = new Map<string, number>();
  const partidos = new Map<string, number>();
  const ultimo = new Map<string, string>();
  for (const g of filas) {
    const [nh, na] = actualizar(elo.get(g.home_id) ?? NHL.inicial, elo.get(g.away_id) ?? NHL.inicial, g.home_goals, g.away_goals);
    elo.set(g.home_id, nh);
    elo.set(g.away_id, na);
    for (const id of [g.home_id, g.away_id]) {
      partidos.set(id, (partidos.get(id) ?? 0) + 1);
      ultimo.set(id, g.game_date);
    }
  }
  const estado = { elo, partidos, ultimo, ultimaFecha: f.u, ultimaTemporada: filas.at(-1)?.season ?? null };
  memo = { firma, estado };
  return estado;
}

export const countGames = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM nhl_games').get() as { n: number }).n;
export const countTeams = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM nhl_teams WHERE active = 1').get() as { n: number }).n;
export const latestDate = (): string | null => (getDb().prepare('SELECT MAX(game_date) AS d FROM nhl_games').get() as { d: string | null }).d;

/** Los 32 equipos (y los tres antiguos) a `nhl_teams`. Idempotente. */
export function guardarEquipos(): number {
  const ins = getDb().prepare('INSERT INTO nhl_teams (id, name, city, active) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, city = excluded.city, active = excluded.active');
  for (const f of FRANQUICIAS) ins.run(f.id, f.nombre, f.ciudad, f.activa ? 1 : 0);
  return FRANQUICIAS.length;
}

export function listTeams(): { id: string; name: string }[] {
  return getDb().prepare('SELECT id, name FROM nhl_teams WHERE active = 1 ORDER BY name').all() as { id: string; name: string }[];
}

/** Clasificación por Elo de los equipos en activo que tienen partidos. */
export function getPowerRanking(limit = 40): { id: string; name: string; elo: number; games: number }[] {
  const e = estadoElo();
  return FRANQUICIAS.filter((f) => f.activa && e.elo.has(f.id))
    .map((f) => ({ id: f.id, name: f.nombre, elo: e.elo.get(f.id)!, games: e.partidos.get(f.id) ?? 0 }))
    .sort((a, b) => b.elo - a.elo)
    .slice(0, limit);
}

export function getTeamInfo(id: string): NhlTeamInfo | null {
  const e = estadoElo();
  if (!e.elo.has(id)) return null;
  const d = getDb();
  const temp = d.prepare('SELECT MAX(season) AS s FROM nhl_games WHERE home_id = ? OR away_id = ?').get(id, id) as { s: number | null };
  // Dos mitades con índice y UNION ALL (un OR entre columnas no usa índice: ver nfl/repo.ts).
  const filas = d
    .prepare(
      `SELECT * FROM (
         SELECT game_date, away_id AS rival, 1 AS en_casa, home_goals AS gf, away_goals AS gc FROM nhl_games WHERE home_id = ? AND season = ?
         UNION ALL
         SELECT game_date, home_id AS rival, 0 AS en_casa, away_goals AS gf, home_goals AS gc FROM nhl_games WHERE away_id = ? AND season = ?
       ) ORDER BY game_date DESC`,
    )
    .all(id, temp.s, id, temp.s) as { game_date: string; rival: string; en_casa: number; gf: number; gc: number }[];
  const record = { wins: 0, losses: 0 };
  const homeRecord = { wins: 0, losses: 0 };
  const awayRecord = { wins: 0, losses: 0 };
  let gf = 0;
  let gc = 0;
  for (const r of filas) {
    const gana = r.gf > r.gc;
    const lado = r.en_casa ? homeRecord : awayRecord;
    if (gana) {
      record.wins++;
      lado.wins++;
    } else {
      record.losses++;
      lado.losses++;
    }
    gf += r.gf;
    gc += r.gc;
  }
  const rank = [...e.elo.entries()].filter(([k]) => FRANQUICIAS.some((f) => f.activa && f.id === k)).filter(([, v]) => v > e.elo.get(id)!).length + 1;
  const n = filas.length;
  return {
    id,
    name: nombreDe(id),
    elo: e.elo.get(id)!,
    eloRank: rank,
    gamesInDb: e.partidos.get(id) ?? 0,
    season: temp.s,
    record,
    homeRecord,
    awayRecord,
    goalsFor: n ? Number((gf / n).toFixed(2)) : null,
    goalsAgainst: n ? Number((gc / n).toFixed(2)) : null,
    lastDate: e.ultimo.get(id) ?? null,
    form: filas.slice(0, 10).map((r) => ({ date: r.game_date, opponentId: r.rival, opponentName: nombreDe(r.rival), home: r.en_casa === 1, result: r.gf > r.gc ? 'W' : 'L', goalsFor: r.gf, goalsAgainst: r.gc })),
  };
}

/** Cara a cara, del más reciente al más antiguo. */
export function getHeadToHead(a: string, b: string, limit = 6) {
  const filas = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT game_date, home_id, away_id, home_goals, away_goals FROM nhl_games WHERE home_id = ? AND away_id = ?
         UNION ALL
         SELECT game_date, home_id, away_id, home_goals, away_goals FROM nhl_games WHERE home_id = ? AND away_id = ?
       ) ORDER BY game_date DESC`,
    )
    .all(a, b, b, a) as { game_date: string; home_id: string; away_id: string; home_goals: number; away_goals: number }[];
  let aGana = 0;
  for (const r of filas) if ((r.home_goals > r.away_goals ? r.home_id : r.away_id) === a) aGana++;
  return {
    total: filas.length,
    homeWins: aGana,
    awayWins: filas.length - aGana,
    recent: filas.slice(0, limit).map((r) => ({ date: r.game_date, homeId: r.home_id, awayId: r.away_id, homeGoals: r.home_goals, awayGoals: r.away_goals })),
  };
}

const COLUMNAS = 'id, league, season, game_id, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, total_line, odds_over, odds_under, books, source, updated_at';

export function listUpcoming(limit = 24): NhlUpcomingRow[] {
  const fresh = freshFilter();
  return getDb()
    .prepare(`SELECT ${COLUMNAS} FROM nhl_upcoming WHERE ${fresh.sql} ORDER BY commence_time, id LIMIT ?`)
    .all(...fresh.params, limit) as unknown as NhlUpcomingRow[];
}

export function getUpcoming(id: string): NhlUpcomingRow | null {
  return (getDb().prepare(`SELECT ${COLUMNAS} FROM nhl_upcoming WHERE id = ?`).get(id) as unknown as NhlUpcomingRow | undefined) ?? null;
}

export function lastOddsUpdate(): string | null {
  return (getDb().prepare("SELECT MAX(updated_at) AS t FROM nhl_upcoming WHERE source = 'live'").get() as { t: string | null }).t;
}

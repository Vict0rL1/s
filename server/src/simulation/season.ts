// Simulación de temporada por Monte Carlo (Fase 4.6).
//
// Qué es: 10.000 temporadas posibles, jugadas partido a partido con la probabilidad que el
// modelo publica hoy para cada uno, sumadas a la clasificación real. Por equipo: puntos y
// victorias esperados, probabilidad de acabar primero, de entrar arriba (top N, playoffs,
// ascenso) y de bajar, y la distribución de la posición final.
//
// Qué NO es: una predicción publicada. Es una lectura de lo que las probabilidades de hoy
// implican si no cambia nada (lesiones, fichajes, forma: nada de eso se mueve), y así se
// etiqueta. Semilla fija y resultado cacheado por día: dos lecturas del mismo día dicen lo
// mismo, y el test lo comprueba con una liga sintética.
//
// La probabilidad de cada partido pendiente sale del MISMO núcleo del modelo del deporte,
// sin lo que no se puede saber con semanas de antelación (descanso, abridor, QB titular):
// Dixon-Coles para el fútbol, Elo con ventaja de campo para la NBA, la MLB y la NFL.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, footballLeagueById, leagueById as basketballLeagueById, baseballLeagueById, nflLeagueById } from '../config.ts';
import { getDb } from '../db.ts';
import { rng, elegir } from './rng.ts';
import { calendarioGuardado, reconstruirDobleVuelta, type Fixture, type Calendario, pendientesDe } from './calendario.ts';
import { SPORT_IDS, type SportId } from '../sports.ts';

// ---------------------------------------------------------------------------
// Reglas por liga (config/simulation.json)
// ---------------------------------------------------------------------------
export interface ReglasLiga {
  puntos: [number, number, number] | 'victorias';
  top: number;
  descenso: number;
  formato: 'doble vuelta' | 'calendario' | 'apertura/clausura' | 'grupos';
  etiquetaTop: string;
  grupos?: string;
  nota?: string;
}

interface ConfigSimulacion {
  corridas: number;
  semilla: number;
  ligas: Record<string, Record<string, ReglasLiga>>;
}

let cacheConfig: ConfigSimulacion | null = null;
export function configSimulacion(): ConfigSimulacion {
  if (!cacheConfig) cacheConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'simulation.json'), 'utf8')) as ConfigSimulacion;
  return cacheConfig;
}

export function reglasDe(sport: SportId, league: string): ReglasLiga | null {
  const s = configSimulacion().ligas[sport];
  if (!s) return null;
  return s[league] ?? s._defecto ?? null;
}

// ---------------------------------------------------------------------------
// El núcleo, puro: equipos, clasificación, partidos con probabilidad, reglas, semilla
// ---------------------------------------------------------------------------
export interface EquipoEntrada {
  id: string;
  nombre: string;
  grupo?: string | null;
}

export interface Clasificacion {
  puntos: number;
  jugados: number;
  victorias: number;
  empates: number;
  derrotas: number;
}

export interface PartidoSimulable {
  homeId: string;
  awayId: string;
  /** [local, (empate,) visitante]. Con dos entradas no hay empate. */
  p: number[];
}

export interface EntradaSimulacion {
  equipos: EquipoEntrada[];
  clasificacion: Record<string, Clasificacion>;
  partidos: PartidoSimulable[];
  reglas: Pick<ReglasLiga, 'puntos' | 'top' | 'descenso'> & { grupos?: boolean };
  corridas: number;
  semilla: number;
}

export interface EquipoSimulado {
  id: string;
  nombre: string;
  grupo: string | null;
  actual: Clasificacion;
  puntosEsperados: number;
  victoriasEsperadas: number;
  /** Probabilidad de acabar primero de la liga (o del grupo, si los hay). */
  titulo: number;
  /** Probabilidad de entrar en el top N de la liga o del grupo. */
  top: number;
  /** Probabilidad de acabar en las N últimas plazas de la liga. */
  descenso: number;
  /** Distribución de la posición final, índice 0 = primero. */
  posiciones: number[];
}

/** Puntos que da cada resultado [local, empate, visitante] para el local y el visitante. */
function tablaPuntos(reglas: EntradaSimulacion['reglas']): { local: number[]; visitante: number[] } {
  if (reglas.puntos === 'victorias') return { local: [1, 0.5, 0], visitante: [0, 0.5, 1] };
  const [g, e, p] = reglas.puntos;
  return { local: [g, e, p], visitante: [p, e, g] };
}

/** Un resultado de dos entradas se expande a tres (sin empate) para usar una sola tabla. */
const tres = (p: number[]): number[] => (p.length === 3 ? p : [p[0], 0, p[1]]);

export function simularTemporada(entrada: EntradaSimulacion): EquipoSimulado[] {
  const { equipos, partidos, reglas, corridas, semilla } = entrada;
  const n = equipos.length;
  const idx = new Map(equipos.map((e, i) => [e.id, i]));
  const base = new Float64Array(n);
  const victoriasBase = new Float64Array(n);
  for (const [id, c] of Object.entries(entrada.clasificacion)) {
    const i = idx.get(id);
    if (i == null) continue;
    base[i] = c.puntos;
    victoriasBase[i] = c.victorias + (reglas.puntos === 'victorias' ? c.empates * 0.5 : 0);
  }
  const ps = partidos.map((m) => ({ h: idx.get(m.homeId), a: idx.get(m.awayId), p: tres(m.p) })).filter((m): m is { h: number; a: number; p: number[] } => m.h != null && m.a != null);
  const tabla = tablaPuntos(reglas);
  const grupos = reglas.grupos ? equipos.map((e) => e.grupo ?? '') : null;
  const random = rng(semilla);

  const sumaPuntos = new Float64Array(n);
  const sumaVictorias = new Float64Array(n);
  const titulo = new Float64Array(n);
  const top = new Float64Array(n);
  const descenso = new Float64Array(n);
  const posiciones = Array.from({ length: n }, () => new Float64Array(n));
  const puntos = new Float64Array(n);
  const victorias = new Float64Array(n);
  const orden = Array.from({ length: n }, (_, i) => i);
  const desempate = new Float64Array(n);

  for (let r = 0; r < corridas; r++) {
    puntos.set(base);
    victorias.set(victoriasBase);
    for (const m of ps) {
      const k = elegir(m.p, random());
      puntos[m.h] += tabla.local[k];
      puntos[m.a] += tabla.visitante[k];
      if (reglas.puntos === 'victorias') {
        victorias[m.h] += tabla.local[k];
        victorias[m.a] += tabla.visitante[k];
      } else {
        if (k === 0) victorias[m.h] += 1;
        else if (k === 2) victorias[m.a] += 1;
      }
    }
    // Empates a puntos: al azar (no hay diferencia de goles en la simulación). Es honesto:
    // ni se inventa un criterio ni se favorece al primero de la lista.
    for (let i = 0; i < n; i++) desempate[i] = random();
    orden.sort((x, y) => puntos[y] - puntos[x] || desempate[y] - desempate[x]);
    for (let pos = 0; pos < n; pos++) {
      const i = orden[pos];
      sumaPuntos[i] += puntos[i];
      sumaVictorias[i] += victorias[i];
      posiciones[i][pos] += 1;
      if (pos >= n - reglas.descenso) descenso[i] += 1;
    }
    if (grupos) {
      const vistos = new Map<string, number>();
      for (const i of orden) {
        const g = grupos[i];
        const pos = vistos.get(g) ?? 0;
        vistos.set(g, pos + 1);
        if (pos === 0) titulo[i] += 1;
        if (pos < reglas.top) top[i] += 1;
      }
    } else {
      titulo[orden[0]] += 1;
      for (let pos = 0; pos < Math.min(reglas.top, n); pos++) top[orden[pos]] += 1;
    }
  }

  const vacia: Clasificacion = { puntos: 0, jugados: 0, victorias: 0, empates: 0, derrotas: 0 };
  return equipos
    .map((e, i) => ({
      id: e.id,
      nombre: e.nombre,
      grupo: e.grupo ?? null,
      actual: entrada.clasificacion[e.id] ?? vacia,
      puntosEsperados: sumaPuntos[i] / corridas,
      victoriasEsperadas: sumaVictorias[i] / corridas,
      titulo: titulo[i] / corridas,
      top: top[i] / corridas,
      descenso: descenso[i] / corridas,
      posiciones: Array.from(posiciones[i], (v) => v / corridas),
    }))
    .sort((a, b) => b.puntosEsperados - a.puntosEsperados || a.nombre.localeCompare(b.nombre));
}

// ---------------------------------------------------------------------------
// Las entradas reales: clasificación, calendario y probabilidades por deporte
// ---------------------------------------------------------------------------
/**
 * Los deportes con simulación de temporada. La NHL no está: su calendario se guarda solo para las
 * próximas semanas (no la temporada entera) y la clasificación de la NHL reparte puntos por la
 * derrota en la prórroga, que el archivo no dice (la fuente no trae cómo acabó cada partido).
 */
export type DeporteSimulable = Exclude<SportId, 'tennis' | 'nhl' | 'ufc'>;

/** Los deportes con simulación de temporada (la web solo pide estos: web/src/lib/simulacion.ts). */
export const DEPORTES_SIMULABLES: DeporteSimulable[] = ['football', 'basketball', 'baseball', 'nfl'];

const TABLAS: Record<DeporteSimulable, { partidos: string; equipos: string; fecha: string; marcador: [string, string]; filtro: string; neutral: string }> = {
  football: { partidos: 'fb_matches', equipos: 'fb_teams', fecha: 'match_date', marcador: ['home_goals', 'away_goals'], filtro: '1 = 1', neutral: '0' },
  basketball: { partidos: 'bb_games', equipos: 'bb_teams', fecha: 'game_date', marcador: ['home_pts', 'away_pts'], filtro: 'COALESCE(is_playoff, 0) = 0', neutral: 'COALESCE(neutral, 0)' },
  baseball: { partidos: 'bsb_games', equipos: 'bsb_teams', fecha: 'game_date', marcador: ['home_runs', 'away_runs'], filtro: '1 = 1', neutral: '0' },
  nfl: { partidos: 'naf_games', equipos: 'naf_teams', fecha: 'game_date', marcador: ['home_points', 'away_points'], filtro: 'COALESCE(playoff, 0) = 0', neutral: 'COALESCE(neutral, 0)' },
};

export interface TemporadaActual {
  season: number | null;
  ultimoPartido: string | null;
  jugados: { homeId: string; awayId: string; hg: number; ag: number }[];
}

export function temporadaActual(sport: DeporteSimulable, league: string): TemporadaActual {
  const t = TABLAS[sport];
  const db = getDb();
  const s = db.prepare(`SELECT MAX(season) AS season FROM ${t.partidos} WHERE league = ?`).get(league) as { season: number | null };
  if (s.season == null) return { season: null, ultimoPartido: null, jugados: [] };
  const filas = db
    .prepare(`SELECT home_id AS homeId, away_id AS awayId, ${t.marcador[0]} AS hg, ${t.marcador[1]} AS ag, ${t.fecha} AS fecha FROM ${t.partidos} WHERE league = ? AND season = ? AND ${t.filtro} ORDER BY ${t.fecha}`)
    .all(league, s.season) as unknown as { homeId: string; awayId: string; hg: number; ag: number; fecha: string }[];
  return { season: s.season, ultimoPartido: filas.length ? filas[filas.length - 1].fecha : null, jugados: filas };
}

export function clasificacionDe(jugados: TemporadaActual['jugados'], reglas: Pick<ReglasLiga, 'puntos'>): Record<string, Clasificacion> {
  const out: Record<string, Clasificacion> = {};
  const c = (id: string) => (out[id] ??= { puntos: 0, jugados: 0, victorias: 0, empates: 0, derrotas: 0 });
  const tabla = tablaPuntos({ puntos: reglas.puntos, top: 0, descenso: 0 });
  for (const j of jugados) {
    const k = j.hg > j.ag ? 0 : j.hg === j.ag ? 1 : 2;
    const h = c(j.homeId);
    const a = c(j.awayId);
    h.jugados++;
    a.jugados++;
    h.puntos += tabla.local[k];
    a.puntos += tabla.visitante[k];
    if (k === 0) {
      h.victorias++;
      a.derrotas++;
    } else if (k === 2) {
      a.victorias++;
      h.derrotas++;
    } else {
      h.empates++;
      a.empates++;
    }
  }
  return out;
}

function equiposDe(sport: DeporteSimulable, league: string, ids: Set<string>): EquipoEntrada[] {
  const t = TABLAS[sport];
  const db = getDb();
  const cols = (db.prepare(`PRAGMA table_info(${t.equipos})`).all() as unknown as { name: string }[]).map((c) => c.name);
  const grupo = cols.includes('conference') ? 'conference' : null;
  const filas = db.prepare(`SELECT id, name${grupo ? `, ${grupo} AS grupo` : ''} FROM ${t.equipos} WHERE league = ?`).all(league) as unknown as { id: string; name: string; grupo?: string | null }[];
  const nombres = new Map(filas.map((f) => [f.id, f]));
  return [...ids].sort().map((id) => ({ id, nombre: nombres.get(id)?.name ?? id, grupo: nombres.get(id)?.grupo ?? null }));
}

/** La probabilidad publicada por el núcleo del deporte, sin lo que no se sabe con antelación. */
export async function probabilidadPartido(sport: DeporteSimulable, league: string, f: Fixture): Promise<number[] | null> {
  try {
    switch (sport) {
      case 'football': {
        const { buildFootballPrediction } = await import('../football/predict.ts');
        const p = buildFootballPrediction(league, f.homeId, f.awayId, undefined, { neutral: f.neutral });
        return [p.final.home, p.final.draw, p.final.away];
      }
      case 'basketball': {
        const { getRating, getHomeAdvantage } = await import('../basketball/repo.ts');
        const { calibratedHomeWinProbability } = await import('../basketball/elo.ts');
        const q = calibratedHomeWinProbability(getRating(league, f.homeId).elo, getRating(league, f.awayId).elo, { neutral: f.neutral, homeAdvantage: getHomeAdvantage(league) });
        return [q, 1 - q];
      }
      case 'baseball': {
        const { getRating } = await import('../baseball/repo.ts');
        const { getLeagueRunsPerGame } = await import('../baseball/ratings.ts');
        const { expectedRuns, runDistribution, winProbability } = await import('../baseball/model.ts');
        const l = expectedRuns(getRating(league, f.homeId).elo, getRating(league, f.awayId).elo, getLeagueRunsPerGame(league), { neutral: f.neutral });
        const q = winProbability(runDistribution(l.home, l.away)).home;
        return [q, 1 - q];
      }
      case 'nfl': {
        const { getRating, getLeagueState } = await import('../nfl/repo.ts');
        const { buildDistribution, outcomeProbabilities, ELO_PER_POINT } = await import('../nfl/model.ts');
        const st = getLeagueState(league);
        const margen = (getRating(league, f.homeId).elo + (f.neutral ? 0 : st.homeAdvantage) - getRating(league, f.awayId).elo) / ELO_PER_POINT;
        const o = outcomeProbabilities(buildDistribution(margen, st.leagueTotal));
        return [o.home, o.tie, o.away];
      }
    }
  } catch {
    return null;
  }
}

export interface ResultadoSimulacion {
  sport: SportId;
  league: string;
  season: number | null;
  generado: string;
  corridas: number;
  semilla: number;
  etiqueta: string;
  reglas: ReglasLiga | null;
  calendario: { origen: Calendario['origen']; fuente: string | null; pendientes: number; sinProbabilidad: number; nota: string | null };
  jugados: number;
  equipos: EquipoSimulado[];
  /** Por qué no hay simulación, cuando no la hay. */
  motivo: string | null;
}

export const ETIQUETA = 'Simulación con las probabilidades de hoy; no es una predicción publicada ni entra en el libro mayor.';

export async function simulacionTemporada(sport: DeporteSimulable, league: string, ahora = new Date()): Promise<ResultadoSimulacion> {
  const cfg = configSimulacion();
  const reglas = reglasDe(sport, league);
  const vacio = (motivo: string, extra: Partial<ResultadoSimulacion> = {}): ResultadoSimulacion => ({
    sport, league, season: null, generado: ahora.toISOString(), corridas: cfg.corridas, semilla: cfg.semilla, etiqueta: ETIQUETA, reglas,
    calendario: { origen: 'ninguno', fuente: null, pendientes: 0, sinProbabilidad: 0, nota: null }, jugados: 0, equipos: [], motivo, ...extra,
  });
  if (!reglas) return vacio('liga sin reglas en config/simulation.json');
  const liga = sport === 'football' ? footballLeagueById(league) : sport === 'basketball' ? basketballLeagueById(league) : sport === 'baseball' ? baseballLeagueById(league) : nflLeagueById(league);
  if (!liga) return vacio('liga desconocida');
  const temp = temporadaActual(sport, league);
  if (temp.season == null) return vacio('sin partidos en la base');
  // El calendario ENTERO y, pendiente, lo que no tiene resultado emparejado (lote C, C6): ni se
  // simula lo ya jugado aunque su fecha sea de hoy, ni se olvida lo aplazado.
  let cal = calendarioGuardado(sport, league, temp.season);
  if (cal.origen === 'fuente') cal = { ...cal, partidos: pendientesDe(cal.partidos, temp.jugados) };
  const ids = new Set<string>();
  for (const j of temp.jugados) {
    ids.add(j.homeId);
    ids.add(j.awayId);
  }
  let nota: string | null = null;
  if (cal.origen === 'ninguno' && reglas.formato === 'doble vuelta' && temp.jugados.length > 0) {
    cal = { partidos: reconstruirDobleVuelta([...ids], temp.jugados), origen: 'reconstruido', fuente: null, actualizado: null };
    nota = 'Calendario reconstruido: la fuente no trae los partidos pendientes, así que se asume la doble vuelta completa entre los equipos que ya han jugado, sin fechas.';
  }
  if (cal.origen === 'ninguno') {
    return vacio(`sin calendario pendiente para ${league} ${temp.season}${reglas.formato !== 'doble vuelta' ? ` (formato ${reglas.formato}: no se reconstruye)` : ''}`, { season: temp.season, jugados: temp.jugados.length });
  }
  for (const f of cal.partidos) {
    ids.add(f.homeId);
    ids.add(f.awayId);
  }
  const partidos: PartidoSimulable[] = [];
  let sinProbabilidad = 0;
  for (const f of cal.partidos) {
    const p = await probabilidadPartido(sport, league, f);
    if (p) partidos.push({ homeId: f.homeId, awayId: f.awayId, p });
    else sinProbabilidad++;
  }
  if (sinProbabilidad) nota = `${nota ? nota + ' ' : ''}${sinProbabilidad} partidos sin probabilidad del modelo (equipo sin rating): no se simulan y la tabla los ignora.`;
  const equipos = equiposDe(sport, league, ids);
  const conGrupos = !!reglas.grupos && equipos.every((e) => e.grupo);
  if (reglas.grupos && !conGrupos) nota = `${nota ? nota + ' ' : ''}Sin conferencias en la base: el top cuenta sobre toda la liga.`;
  const res = simularTemporada({
    equipos,
    clasificacion: clasificacionDe(temp.jugados, reglas),
    partidos,
    reglas: { puntos: reglas.puntos, top: reglas.top, descenso: reglas.descenso, grupos: conGrupos },
    corridas: cfg.corridas,
    semilla: cfg.semilla,
  });
  return {
    sport, league, season: temp.season, generado: ahora.toISOString(), corridas: cfg.corridas, semilla: cfg.semilla, etiqueta: ETIQUETA, reglas,
    calendario: { origen: cal.origen, fuente: cal.fuente, pendientes: partidos.length, sinProbabilidad, nota },
    jugados: temp.jugados.length,
    equipos: res,
    motivo: null,
  };
}

// ---------------------------------------------------------------------------
// Caché diaria y trabajo
// ---------------------------------------------------------------------------
export function simulacionGuardada(sport: SportId, league: string, dia: string): ResultadoSimulacion | null {
  const r = getDb().prepare('SELECT result FROM simulation_runs WHERE sport = ? AND league = ? AND day = ?').get(sport, league, dia) as { result: string } | undefined;
  return r ? (JSON.parse(r.result) as ResultadoSimulacion) : null;
}

export async function simulacionDelDia(sport: DeporteSimulable, league: string, ahora = new Date()): Promise<ResultadoSimulacion> {
  const dia = ahora.toISOString().slice(0, 10);
  const cache = simulacionGuardada(sport, league, dia);
  if (cache) return cache;
  const r = await simulacionTemporada(sport, league, ahora);
  getDb().prepare('INSERT OR REPLACE INTO simulation_runs (sport, league, day, computed_at, result) VALUES (?, ?, ?, ?, ?)').run(sport, league, dia, r.generado, JSON.stringify(r));
  return r;
}

/** Ligas con partidos en la base, por deporte. */
export function ligasConDatos(sport: DeporteSimulable): string[] {
  try {
    return (getDb().prepare(`SELECT DISTINCT league FROM ${TABLAS[sport].partidos} ORDER BY league`).all() as { league: string }[]).map((r) => r.league);
  } catch {
    return [];
  }
}

export async function cicloSimulacion(log: (m: string) => void = () => {}, ahora = new Date()): Promise<{ ligas: number; simuladas: number }> {
  let ligas = 0;
  let simuladas = 0;
  for (const s of SPORT_IDS) {
    if (s === 'tennis' || s === 'nhl' || s === 'ufc') continue;
    for (const l of ligasConDatos(s)) {
      ligas++;
      try {
        const r = await simulacionDelDia(s, l, ahora);
        if (!r.motivo) simuladas++;
        log(`simulación ${s}/${l}: ${r.motivo ?? `${r.calendario.pendientes} partidos pendientes (${r.calendario.origen})`}`);
      } catch (e) {
        log(`simulación ${s}/${l}: ${(e as Error).message}`);
      }
    }
  }
  return { ligas, simuladas };
}

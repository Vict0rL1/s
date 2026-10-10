// Ingesta de la NHL en sombra (Fase 8.1): partidos TERMINADOS, de una de dos fuentes.
//
//   · `nhl`: la API web pública de la NHL (`api-web.nhle.com/v1/schedule/{fecha}`, una semana por
//     petición). Dice cómo acabó cada partido (tiempo reglamentario, prórroga o tanda).
//   · `sportsdataverse`: los calendarios por temporada que publica sportsdataverse en GitHub (copia de
//     esa misma API, un CSV por temporada). Trae el marcador final pero NO cómo acabó: `final_period`
//     queda NULL. El marcador final de la NHL ya cuenta la prórroga o la tanda como un gol, que es
//     justo como cuenta los totales el modelo, así que ganador y total se evalúan igual.
//
// Solo se guardan los terminados con su marcador; lo demás se ignora. Si la fuente no contesta, se
// dice y no se escribe nada: nunca un partido inventado.

import { parse } from 'csv-parse/sync';
import { getDb } from '../db.ts';
import { nhlConfig } from '../config.ts';

export const NHL_API = 'https://api-web.nhle.com/v1';

export interface PartidoNhl {
  id: number;
  season: number;
  game_type: number;
  game_date: string;
  home_id: string;
  away_id: string;
  home_name: string | null;
  away_name: string | null;
  home_goals: number;
  away_goals: number;
  /** NULL cuando la fuente no lo dice: no se supone «REG». */
  final_period: 'REG' | 'OT' | 'SO' | null;
  fuente?: 'nhl-api' | 'sportsdataverse';
}

interface EquipoApi {
  abbrev?: string;
  score?: number;
  name?: { default?: string };
  placeName?: { default?: string };
  commonName?: { default?: string };
}
interface PartidoApi {
  id?: number;
  season?: number;
  gameType?: number;
  gameDate?: string;
  startTimeUTC?: string;
  gameState?: string;
  homeTeam?: EquipoApi;
  awayTeam?: EquipoApi;
  periodDescriptor?: { periodType?: string };
  gameOutcome?: { lastPeriodType?: string };
}

const nombre = (t: EquipoApi | undefined) =>
  t?.name?.default ?? ([t?.placeName?.default, t?.commonName?.default].filter(Boolean).join(' ') || null);

/** Los partidos terminados de una respuesta de /schedule (gameWeek) o /score (games). */
export function partidosDe(json: unknown): PartidoNhl[] {
  const j = json as { gameWeek?: { date?: string; games?: PartidoApi[] }[]; games?: PartidoApi[] };
  const crudos: (PartidoApi & { _fecha?: string })[] = [
    ...(j.games ?? []),
    ...(j.gameWeek ?? []).flatMap((d) => (d.games ?? []).map((g) => ({ ...g, _fecha: d.date }))),
  ];
  const out: PartidoNhl[] = [];
  for (const g of crudos) {
    if (!['FINAL', 'OFF'].includes(String(g.gameState))) continue;
    const h = g.homeTeam;
    const a = g.awayTeam;
    if (!g.id || !g.season || !h?.abbrev || !a?.abbrev || typeof h.score !== 'number' || typeof a.score !== 'number' || h.score === a.score) continue;
    const periodo = String(g.gameOutcome?.lastPeriodType ?? g.periodDescriptor?.periodType ?? 'REG');
    const fecha = g.gameDate ?? g._fecha ?? g.startTimeUTC?.slice(0, 10);
    if (!fecha) continue;
    out.push({
      id: g.id,
      season: Math.floor(g.season / 10000),
      game_type: g.gameType ?? 2,
      game_date: fecha.slice(0, 10),
      home_id: h.abbrev,
      away_id: a.abbrev,
      home_name: nombre(h),
      away_name: nombre(a),
      home_goals: h.score,
      away_goals: a.score,
      final_period: periodo === 'OT' || periodo === 'SO' ? periodo : 'REG',
      fuente: 'nhl-api',
    });
  }
  return out;
}

export function guardarPartidos(xs: PartidoNhl[], ahora = new Date()): number {
  const st = getDb().prepare(
    `INSERT INTO nhl_games (id, season, game_type, game_date, home_id, away_id, home_name, away_name, home_goals, away_goals, final_period, fuente, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET home_goals = excluded.home_goals, away_goals = excluded.away_goals,
       final_period = COALESCE(excluded.final_period, nhl_games.final_period),
       fuente = CASE WHEN excluded.final_period IS NULL AND nhl_games.final_period IS NOT NULL THEN nhl_games.fuente ELSE excluded.fuente END,
       ingested_at = excluded.ingested_at`,
  );
  // Una transacción: o entra la temporada entera o no entra nada.
  const d = getDb();
  let n = 0;
  d.exec('BEGIN');
  try {
    for (const x of xs) {
      st.run(x.id, x.season, x.game_type, x.game_date, x.home_id, x.away_id, x.home_name, x.away_name, x.home_goals, x.away_goals, x.final_period, x.fuente ?? null, ahora.toISOString());
      n++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return n;
}

/** Semana a semana entre dos fechas. Devuelve lo guardado; lanza con un mensaje claro si la fuente falla. */
export async function ingestarRango(desde: string, hasta: string, f: typeof fetch = fetch, log: (m: string) => void = () => {}): Promise<{ semanas: number; partidos: number }> {
  let fecha = desde;
  let semanas = 0;
  let partidos = 0;
  while (fecha <= hasta) {
    let res: Response;
    try {
      res = await f(`${NHL_API}/schedule/${fecha}`);
    } catch (e) {
      throw new Error(`no se pudo contactar con api-web.nhle.com (${(e as Error).message}); no se ha escrito nada de esta semana`);
    }
    if (!res.ok) throw new Error(`api-web.nhle.com contestó ${res.status} para ${fecha}`);
    const j = (await res.json()) as { nextStartDate?: string };
    partidos += guardarPartidos(partidosDe(j));
    semanas++;
    const siguiente = j.nextStartDate ?? new Date(Date.parse(`${fecha}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    if (siguiente <= fecha) break;
    fecha = siguiente;
    if (semanas % 10 === 0) log(`NHL: ${semanas} semanas, ${partidos} partidos (hasta ${fecha})`);
  }
  return { semanas, partidos };
}

// ---------------------------------------------------------------------------
// sportsdataverse: un CSV por temporada en las releases de GitHub
// ---------------------------------------------------------------------------

/** El fichero de una temporada se nombra por el año en que ACABA: `nhl_schedule_2024.csv` es la 2023-24. */
export const SPORTSDATAVERSE = nhlConfig.history.schedulesUrl;
export const urlTemporada = (anioFin: number) => `${SPORTSDATAVERSE}/nhl_schedule_${anioFin}.csv`;

/** Los partidos terminados de un CSV de calendario de sportsdataverse (solo temporada regular y playoffs). */
export function partidosDeCsv(texto: string): PartidoNhl[] {
  const filas = parse(texto, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
  const out: PartidoNhl[] = [];
  for (const r of filas) {
    if (!['OFF', 'FINAL'].includes(r.game_state)) continue;
    const tipo = r.game_type === 'R' ? 2 : r.game_type === 'P' ? 3 : null;
    if (tipo == null) continue;
    const id = Number(r.game_id);
    const temporada = Math.floor(Number(r.season_full) / 10000);
    const gl = Number(r.home_score);
    const gv = Number(r.away_score);
    const fecha = (r.game_date ?? '').slice(0, 10);
    if (!Number.isInteger(id) || !Number.isInteger(temporada) || !r.home_team_abbr || !r.away_team_abbr) continue;
    if (r.home_score === '' || r.away_score === '' || !Number.isFinite(gl) || !Number.isFinite(gv) || gl === gv) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    out.push({
      id,
      season: temporada,
      game_type: tipo,
      game_date: fecha,
      home_id: r.home_team_abbr,
      away_id: r.away_team_abbr,
      home_name: r.home_team_name || null,
      away_name: r.away_team_name || null,
      home_goals: gl,
      away_goals: gv,
      final_period: null,
      fuente: 'sportsdataverse',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Marcadores rotos en el calendario, y su arreglo verificable
// ---------------------------------------------------------------------------
// Medido al bajarlo (octubre de 2026): en nueve temporadas (2009-10 a 2012-13 y 2018-19 a 2022-23) el
// CSV de calendario trae un marcador de relleno —todos los partidos «3-2», o el local gana siempre—.
// Guardarlos tal cual habría dado un backtest peor que tirar una moneda. Las «team box» de la misma
// fuente sí traen los goles de verdad, pero sin id ni fecha: dos filas por partido (visitante y local)
// en orden de fecha. Se cruzan por posición SOLO si los dos equipos coinciden en TODOS los partidos de
// la temporada; si falla uno, la temporada no se guarda.

const CAJAS = nhlConfig.history.teamBoxUrl;
export const urlCajas = (anioFin: number) => `${CAJAS}/team_box_${anioFin}.csv`;

/** ¿Marcadores de relleno? Un mismo resultado en más de la mitad de los partidos, o el local gana siempre o nunca. */
export function marcadoresDegenerados(xs: PartidoNhl[]): boolean {
  if (xs.length < 50) return false;
  const cuenta = new Map<string, number>();
  let local = 0;
  for (const x of xs) {
    const k = `${x.home_goals}-${x.away_goals}`;
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
    if (x.home_goals > x.away_goals) local++;
  }
  const max = Math.max(...cuenta.values());
  const tasa = local / xs.length;
  return max > xs.length / 2 || tasa < 0.1 || tasa > 0.9;
}

/**
 * Los goles de las «team box», cruzados con el calendario por orden de fecha. Devuelve los partidos con
 * los goles corregidos, o el motivo por el que no se puede (y entonces no se guarda nada).
 */
export function corregirConCajas(xs: PartidoNhl[], textoCajas: string): { partidos: PartidoNhl[] } | { error: string } {
  const filas = parse(textoCajas, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
  if (filas.length !== xs.length * 2) return { error: `${filas.length / 2} partidos en las cajas y ${xs.length} en el calendario` };
  const orden = [...xs].sort((a, b) => a.game_date.localeCompare(b.game_date) || a.id - b.id);
  const out: PartidoNhl[] = [];
  for (let i = 0; i < orden.length; i++) {
    const v = filas[2 * i];
    const l = filas[2 * i + 1];
    const g = orden[i];
    if (v.home_away !== 'away' || l.home_away !== 'home') return { error: `las cajas no alternan visitante/local en el partido ${i + 1}` };
    if (v.team_abbrev !== g.away_id || l.team_abbrev !== g.home_id) {
      return { error: `el partido ${i + 1} (${g.game_date}) es ${g.away_id} @ ${g.home_id} en el calendario y ${v.team_abbrev} @ ${l.team_abbrev} en las cajas` };
    }
    const gv = Number(v.goals);
    const gl = Number(l.goals);
    if (!Number.isInteger(gv) || !Number.isInteger(gl) || gv === gl) return { error: `marcador imposible en las cajas para ${g.away_id} @ ${g.home_id} (${g.game_date})` };
    out.push({ ...g, home_goals: gl, away_goals: gv });
  }
  return { partidos: out };
}

/**
 * Temporada a temporada, por el año en que acaba (2010 = la 2009-10). Una temporada sin fichero (404)
 * se dice y se salta; cualquier otro fallo para la ingesta sin tocar lo ya guardado de esa temporada.
 * Una temporada con marcadores de relleno se arregla con las cajas o se rechaza (ver arriba).
 */
export async function ingestarTemporadas(
  desde: number,
  hasta: number,
  f: typeof fetch = fetch,
  log: (m: string) => void = () => {},
): Promise<{ temporadas: number; partidos: number; sinFichero: number[]; corregidas: number[]; rechazadas: { anio: number; motivo: string }[] }> {
  let temporadas = 0;
  let partidos = 0;
  const sinFichero: number[] = [];
  const corregidas: number[] = [];
  const rechazadas: { anio: number; motivo: string }[] = [];
  for (let anio = desde; anio <= hasta; anio++) {
    let res: Response;
    try {
      res = await f(urlTemporada(anio));
    } catch (e) {
      throw new Error(`no se pudo contactar con GitHub para la temporada ${anio - 1}-${String(anio).slice(2)} (${(e as Error).message}); no se ha escrito nada de ella`);
    }
    if (res.status === 404) {
      sinFichero.push(anio);
      log(`NHL ${anio - 1}-${String(anio).slice(2)}: sportsdataverse no tiene ese fichero; se salta`);
      continue;
    }
    if (!res.ok) throw new Error(`sportsdataverse contestó ${res.status} para la temporada ${anio - 1}-${String(anio).slice(2)}`);
    const nombre = `${anio - 1}-${String(anio).slice(2)}`;
    let xs = partidosDeCsv(await res.text());
    if (marcadoresDegenerados(xs)) {
      const rc = await f(urlCajas(anio)).catch(() => null);
      const r = rc?.ok ? corregirConCajas(xs, await rc.text()) : { error: `sin «team box» para cruzar (${rc ? rc.status : 'sin conexión'})` };
      if ('error' in r) {
        rechazadas.push({ anio, motivo: r.error });
        log(`NHL ${nombre}: marcadores de relleno en el calendario y no se pudieron corregir (${r.error}); NO se guarda`);
        continue;
      }
      xs = r.partidos;
      corregidas.push(anio);
      log(`NHL ${nombre}: marcadores de relleno en el calendario; corregidos con las «team box» (${xs.length} partidos, todos cruzados)`);
    } else {
      log(`NHL ${nombre}: ${xs.length} partidos terminados`);
    }
    partidos += guardarPartidos(xs);
    temporadas++;
  }
  return { temporadas, partidos, sinFichero, corregidas, rechazadas };
}

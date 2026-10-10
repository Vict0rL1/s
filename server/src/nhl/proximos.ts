// Los próximos partidos de la NHL, de dos fuentes (seguimiento: NHL y UFC).
//
//   · El CALENDARIO de la temporada (sportsdataverse en GitHub, el mismo CSV del archivo): trae todos
//     los partidos por jugar con su hora en UTC. Con él la pestaña funciona sin clave de cuotas, como
//     la NFL con nflverse.
//   · Las CUOTAS de The Odds API (`icehockey_nhl`, mercados h2h y totals = 2 créditos por región):
//     ganador (prórroga y tanda incluidas, que es como se paga el moneyline en la NHL) y total de
//     goles. Una fila con precio SUSTITUYE a la del calendario del mismo partido, para que no salga
//     dos veces.
//
// Los equipos se resuelven a su abreviatura con `equipos.ts`; el que no se resuelve se queda sin id y
// sin predicción (no se adivina entre los dos de Nueva York).

import { parse } from 'csv-parse/sync';
import { getDb, setMeta } from '../db.ts';
import { pruneUpcoming } from '../freshness.ts';
import { env, nhlConfig } from '../config.ts';
import { activeKeys, creditCost, OddsBudgetSkip } from '../oddsQuota.ts';
import { median, outcomeError, outcomeOk, requestOdds, type KeyOutcome } from '../oddsApi.ts';
import { decideReason, recordKeyOutcomes, recordOddsReason } from '../oddsReason.ts';
import { nombreDe, resolverEquipo } from './equipos.ts';
import { urlTemporada } from './ingest.ts';

export const CLAVE_ODDS_NHL = nhlConfig.odds.sportKey;
const MERCADOS = nhlConfig.odds.markets;

export interface ProximoCalendario {
  game_id: number;
  season: number;
  commence_time: string;
  home_id: string;
  away_id: string;
}

/** Los partidos POR JUGAR del CSV de una temporada (regular y playoffs), con hora. */
export function proximosDeCsv(texto: string): ProximoCalendario[] {
  const filas = parse(texto, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as Record<string, string>[];
  const out: ProximoCalendario[] = [];
  for (const r of filas) {
    if (!['FUT', 'PRE'].includes(r.game_state ?? '')) continue;
    if (!['R', 'P'].includes(r.game_type ?? '')) continue;
    const id = Number(r.game_id);
    const hora = r.game_time ?? '';
    if (!Number.isInteger(id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(hora) || !r.home_team_abbr || !r.away_team_abbr) continue;
    out.push({ game_id: id, season: Number(String(r.season_full ?? '').slice(0, 4)) || Number(String(id).slice(0, 4)), commence_time: new Date(hora).toISOString(), home_id: r.home_team_abbr, away_id: r.away_team_abbr });
  }
  return out;
}

/** Cuántos días de calendario se guardan: la pestaña enseña los próximos dos o tres. */
export const HORIZONTE_DIAS = 30;

/**
 * El calendario a `nhl_upcoming`, sustituyendo el anterior, hasta HORIZONTE_DIAS por delante. No pisa a
 * un partido que ya tiene precio (misma pareja a menos de 12 horas): esa fila es la buena.
 */
export function guardarCalendario(xs: ProximoCalendario[], ahora = new Date()): number {
  const d = getDb();
  const stamp = ahora.toISOString();
  const tope = new Date(ahora.getTime() + HORIZONTE_DIAS * 86_400_000).toISOString();
  d.exec('BEGIN');
  try {
    pruneUpcoming(d, 'nhl_upcoming', { scope: { source: 'schedule' }, now: ahora });
    const conPrecio = d.prepare(
      "SELECT 1 FROM nhl_upcoming WHERE source = 'live' AND home_id = ? AND away_id = ? AND ABS(julianday(commence_time) - julianday(?)) < 0.5",
    );
    const ins = d.prepare(
      `INSERT INTO nhl_upcoming (id, league, season, game_id, commence_time, home_name, away_name, home_id, away_id, books, source, updated_at)
       VALUES (?, 'nhl', ?, ?, ?, ?, ?, ?, ?, 0, 'schedule', ?)
       ON CONFLICT(id) DO UPDATE SET commence_time = excluded.commence_time, updated_at = excluded.updated_at`,
    );
    let n = 0;
    for (const x of xs) {
      if (x.commence_time < stamp || x.commence_time > tope) continue;
      if (conPrecio.get(x.home_id, x.away_id, x.commence_time)) continue;
      ins.run(`nhl-${x.game_id}`, x.season, x.game_id, x.commence_time, nombreDe(x.home_id), nombreDe(x.away_id), x.home_id, x.away_id, stamp);
      n++;
    }
    d.exec('COMMIT');
    return n;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Baja el calendario de la temporada en curso y lo guarda. */
export async function refrescarCalendario(anioFin: number, f: typeof fetch = fetch): Promise<number> {
  const res = await f(urlTemporada(anioFin));
  if (!res.ok) throw new Error(`GitHub contestó ${res.status} para el calendario ${anioFin - 1}-${String(anioFin).slice(2)}`);
  const n = guardarCalendario(proximosDeCsv(await res.text()));
  setMeta('nhl:calendarAt', new Date().toISOString());
  return n;
}

export interface EventoNhl {
  id: string;
  commence_time: string;
  home: string;
  away: string;
  price: Record<string, number>;
  total: number | null;
  over: number | null;
  under: number | null;
  books: number;
}

/** Un evento de The Odds API a precios medianos entre casas. La línea de total es la más repetida. */
export function agregarEvento(ev: Record<string, unknown>): EventoNhl {
  const home = String(ev.home_team ?? '');
  const precios: Record<string, number[]> = {};
  const totales = new Map<number, { over: number[]; under: number[] }>();
  const casas = (ev.bookmakers as Record<string, unknown>[] | undefined) ?? [];
  for (const bk of casas) {
    for (const mk of (bk.markets as Record<string, unknown>[] | undefined) ?? []) {
      const outcomes = (mk.outcomes as Record<string, unknown>[] | undefined) ?? [];
      if (mk.key === 'h2h') {
        for (const o of outcomes) {
          const n = String(o.name ?? '');
          const p = Number(o.price);
          if (n && Number.isFinite(p) && p > 1) (precios[n] ??= []).push(p);
        }
      } else if (mk.key === 'totals') {
        for (const o of outcomes) {
          const linea = Number(o.point);
          const p = Number(o.price);
          if (!Number.isFinite(linea) || !Number.isFinite(p) || p <= 1) continue;
          const t = totales.get(linea) ?? { over: [], under: [] };
          if (String(o.name ?? '').toLowerCase() === 'over') t.over.push(p);
          else if (String(o.name ?? '').toLowerCase() === 'under') t.under.push(p);
          totales.set(linea, t);
        }
      }
    }
  }
  const price: Record<string, number> = {};
  for (const [n, xs] of Object.entries(precios)) price[n] = median(xs);
  // La línea que más casas ofrecen (con los dos lados), y sus precios medianos.
  const linea = [...totales.entries()].filter(([, t]) => t.over.length && t.under.length).sort((a, b) => b[1].over.length + b[1].under.length - (a[1].over.length + a[1].under.length) || a[0] - b[0])[0];
  return {
    id: String(ev.id ?? ''),
    commence_time: String(ev.commence_time ?? ''),
    home,
    away: String(ev.away_team ?? ''),
    price,
    total: linea ? linea[0] : null,
    over: linea ? median(linea[1].over) : null,
    under: linea ? median(linea[1].under) : null,
    books: casas.length,
  };
}

/** Guarda los eventos con precio; quita la fila del calendario del mismo partido. */
export function guardarEventos(eventos: EventoNhl[], ahora = new Date()): number {
  const d = getDb();
  const stamp = ahora.toISOString();
  d.exec('BEGIN');
  try {
    pruneUpcoming(d, 'nhl_upcoming', { scope: { source: 'live' }, now: ahora });
    const ins = d.prepare(
      `INSERT INTO nhl_upcoming (id, league, season, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, total_line, odds_over, odds_under, books, source, updated_at)
       VALUES (?, 'nhl', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)
       ON CONFLICT(id) DO UPDATE SET commence_time = excluded.commence_time, odds_home = excluded.odds_home, odds_away = excluded.odds_away,
         total_line = excluded.total_line, odds_over = excluded.odds_over, odds_under = excluded.odds_under, books = excluded.books, updated_at = excluded.updated_at`,
    );
    const delCalendario = d.prepare("DELETE FROM nhl_upcoming WHERE source = 'schedule' AND home_id = ? AND away_id = ? AND ABS(julianday(commence_time) - julianday(?)) < 0.5");
    const temporada = d.prepare("SELECT season FROM nhl_upcoming WHERE source = 'schedule' AND home_id = ? AND away_id = ? AND ABS(julianday(commence_time) - julianday(?)) < 0.5");
    let n = 0;
    for (const ev of eventos) {
      if (!ev.id || !ev.home || !ev.away || !ev.commence_time) continue;
      const h = resolverEquipo(ev.home);
      const a = resolverEquipo(ev.away);
      const t = h && a ? (temporada.get(h.id, a.id, ev.commence_time) as { season: number } | undefined) : undefined;
      ins.run(`odds-${ev.id}`, t?.season ?? null, ev.commence_time, h?.nombre ?? ev.home, a?.nombre ?? ev.away, h?.id ?? null, a?.id ?? null, ev.price[ev.home] ?? null, ev.price[ev.away] ?? null, ev.total, ev.over, ev.under, ev.books, stamp);
      if (h && a) delCalendario.run(h.id, a.id, ev.commence_time);
      n++;
    }
    d.exec('COMMIT');
    return n;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Refresca las cuotas. Devuelve cuántos partidos se guardaron y deja la causa si no hubo precio
 * (sin clave, fuera de temporada, fallo del proveedor…), como los otros cinco deportes.
 */
export async function refrescarCuotas(manual = false): Promise<number> {
  if (!env.oddsApiKey) {
    recordOddsReason('nhl_', 'sin_clave');
    return 0;
  }
  let activas: Set<string>;
  try {
    activas = await activeKeys([CLAVE_ODDS_NHL]);
  } catch (e) {
    recordOddsReason('nhl_', 'fuente_falla', (e as Error).message);
    return 0;
  }
  if (!activas.has(CLAVE_ODDS_NHL)) {
    recordOddsReason('nhl_', 'sin_ligas', 'la NHL no está en temporada ahora mismo');
    return 0;
  }
  console.log(`[nhl] en temporada · ${creditCost(MERCADOS)} créditos por región`);
  const outcomes: KeyOutcome[] = [];
  let guardados = 0;
  let conPrecio = 0;
  try {
    const r = await requestOdds(CLAVE_ODDS_NHL, { markets: MERCADOS, manual });
    outcomes.push(outcomeOk(CLAVE_ODDS_NHL, r));
    const eventos = (r.events as unknown as Record<string, unknown>[]).map(agregarEvento);
    conPrecio = eventos.filter((e) => e.price[e.home] != null && e.price[e.away] != null).length;
    if (eventos.length) guardados = guardarEventos(eventos);
  } catch (e) {
    outcomes.push(outcomeError(CLAVE_ODDS_NHL, e, e instanceof OddsBudgetSkip));
    console.warn(`[nhl] ${CLAVE_ODDS_NHL}: ${(e as Error).message}`);
  }
  recordKeyOutcomes('nhl_', outcomes);
  const dec = decideReason(outcomes, conPrecio);
  recordOddsReason('nhl_', dec.reason, dec.reason ? `${dec.detail} · regiones=${env.oddsRegions}` : '');
  if (guardados) setMeta('nhl_odds_refreshed_at', new Date().toISOString());
  return guardados;
}

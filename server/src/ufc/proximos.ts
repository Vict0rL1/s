// Las peleas que vienen, de The Odds API (`mma_mixed_martial_arts`, mercado h2h: un crédito por región).
//
// ===========================================================================
// SOLO LA UFC, SIN ADIVINAR
// ===========================================================================
// La clave del proveedor es la de TODO el MMA: UFC, PFL, Bellator… y los eventos no dicen de qué
// organización son. Lo que sí se sabe es quién ha peleado en la UFC (ufc_fighters). Una pelea se
// considera de una cartelera de la UFC si, a menos de `ventanaHoras` de su hora, hay al menos
// `minimoConocidas` peleas con los DOS luchadores ya en la UFC (config/ufc.json). Lo demás se descarta
// y se cuenta. Dentro de una cartelera puede haber un debutante: la pelea se enseña, sin predicción.
//
// El orden de los dos tampoco lo pone la casa: A es el de id de ufcstats menor (ver ufc/schema.ts),
// así que si la casa da la vuelta a los dos entre una actualización y otra, la fila es la misma y las
// cuotas no cambian de lado.

import { getDb, setMeta } from '../db.ts';
import { pruneUpcoming } from '../freshness.ts';
import { env, ufcConfig } from '../config.ts';
import { activeKeys, creditCost, OddsBudgetSkip } from '../oddsQuota.ts';
import { median, outcomeError, outcomeOk, requestOdds, type KeyOutcome } from '../oddsApi.ts';
import { decideReason, recordKeyOutcomes, recordOddsReason } from '../oddsReason.ts';
import { resolverLuchador } from './luchadores.ts';

export const CLAVE_ODDS_UFC = ufcConfig.odds.sportKey;
const MERCADOS = ufcConfig.odds.markets;

export interface EventoMma {
  id: string;
  commence_time: string;
  /** Los dos nombres como los da la casa (`home_team` y `away_team`, que en el MMA no significan nada). */
  uno: string;
  otro: string;
  price: Record<string, number>;
  books: number;
}

/** Un evento de The Odds API a precios medianos entre casas. */
export function agregarEvento(ev: Record<string, unknown>): EventoMma {
  const precios: Record<string, number[]> = {};
  const casas = (ev.bookmakers as Record<string, unknown>[] | undefined) ?? [];
  for (const bk of casas) {
    for (const mk of (bk.markets as Record<string, unknown>[] | undefined) ?? []) {
      if (mk.key !== 'h2h') continue;
      for (const o of (mk.outcomes as Record<string, unknown>[] | undefined) ?? []) {
        const n = String(o.name ?? '');
        const p = Number(o.price);
        if (n && Number.isFinite(p) && p > 1) (precios[n] ??= []).push(p);
      }
    }
  }
  const price: Record<string, number> = {};
  // Redondeada: la mediana de dos precios (1,91 y 1,90) da 1,9049999… en coma flotante.
  for (const [n, xs] of Object.entries(precios)) price[n] = Math.round(median(xs) * 1000) / 1000;
  return { id: String(ev.id ?? ''), commence_time: String(ev.commence_time ?? ''), uno: String(ev.home_team ?? ''), otro: String(ev.away_team ?? ''), price, books: casas.length };
}

export interface PeleaProxima {
  id: string;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  odds_home: number | null;
  odds_away: number | null;
  books: number;
}

export interface Filtrado {
  peleas: PeleaProxima[];
  /** De otras organizaciones (o sin ningún luchador de la UFC alrededor): descartadas. */
  descartadas: number;
  /** En una cartelera de la UFC pero con un luchador sin identificar (debutante o nombre ambiguo). */
  sinIdentificar: number;
}

/**
 * De los eventos de MMA, los de una cartelera de la UFC, con los luchadores identificados y en orden
 * canónico. Puro: no toca la base (salvo para leer quién es quién).
 */
export function filtrarUfc(eventos: EventoMma[], cfg = ufcConfig.cartelera): Filtrado {
  const conIds = eventos
    .filter((e) => e.id && e.uno && e.otro && !Number.isNaN(Date.parse(e.commence_time)))
    .map((e) => {
      const a = resolverLuchador(e.uno);
      const b = resolverLuchador(e.otro);
      return { e, a: a.id, b: b.id, t: Date.parse(e.commence_time) };
    });
  const conocidas = conIds.filter((x) => x.a && x.b);
  const ventana = cfg.ventanaHoras * 3_600_000;
  const out: PeleaProxima[] = [];
  let descartadas = 0;
  let sinIdentificar = 0;
  for (const x of conIds) {
    const alrededor = conocidas.filter((c) => Math.abs(c.t - x.t) <= ventana).length;
    if (alrededor < cfg.minimoConocidas) {
      descartadas++;
      continue;
    }
    const { e } = x;
    const pUno = e.price[e.uno] ?? null;
    const pOtro = e.price[e.otro] ?? null;
    if (!x.a || !x.b) sinIdentificar++;
    // Orden canónico solo si están los dos; si no, el de la casa (la pelea no se predice).
    const girar = !!(x.a && x.b && x.b < x.a);
    out.push({
      id: `odds-${e.id}`,
      commence_time: new Date(x.t).toISOString(),
      home_name: girar ? e.otro : e.uno,
      away_name: girar ? e.uno : e.otro,
      home_id: girar ? x.b : x.a,
      away_id: girar ? x.a : x.b,
      odds_home: girar ? pOtro : pUno,
      odds_away: girar ? pUno : pOtro,
      books: e.books,
    });
  }
  return { peleas: out, descartadas, sinIdentificar };
}

/** Guarda las peleas (sustituyendo las de la actualización anterior). */
export function guardarPeleas(xs: PeleaProxima[], ahora = new Date()): number {
  const d = getDb();
  const stamp = ahora.toISOString();
  d.exec('BEGIN');
  try {
    pruneUpcoming(d, 'ufc_upcoming', { now: ahora });
    const ins = d.prepare(
      `INSERT INTO ufc_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, books, source, updated_at)
       VALUES (?, 'ufc', ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)
       ON CONFLICT(id) DO UPDATE SET commence_time = excluded.commence_time, home_name = excluded.home_name, away_name = excluded.away_name,
         home_id = excluded.home_id, away_id = excluded.away_id, odds_home = excluded.odds_home, odds_away = excluded.odds_away,
         books = excluded.books, updated_at = excluded.updated_at`,
    );
    for (const x of xs) ins.run(x.id, x.commence_time, x.home_name, x.away_name, x.home_id, x.away_id, x.odds_home, x.odds_away, x.books, stamp);
    d.exec('COMMIT');
    return xs.length;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Refresca las peleas y sus cuotas. Sin clave no hay cartelera (la fuente del archivo solo trae peleas
 * ya disputadas): se deja la causa, como en los otros deportes.
 */
export async function refrescarCuotas(manual = false): Promise<number> {
  if (!env.oddsApiKey) {
    recordOddsReason('ufc_', 'sin_clave');
    return 0;
  }
  let activas: Set<string>;
  try {
    activas = await activeKeys([CLAVE_ODDS_UFC]);
  } catch (e) {
    recordOddsReason('ufc_', 'fuente_falla', (e as Error).message);
    return 0;
  }
  if (!activas.has(CLAVE_ODDS_UFC)) {
    recordOddsReason('ufc_', 'sin_ligas', 'el proveedor no tiene ahora mismo peleas de MMA con cuotas');
    return 0;
  }
  console.log(`[ufc] ${creditCost(MERCADOS)} crédito(s) por región`);
  const outcomes: KeyOutcome[] = [];
  let guardadas = 0;
  let conPrecio = 0;
  try {
    const r = await requestOdds(CLAVE_ODDS_UFC, { markets: MERCADOS, manual });
    outcomes.push(outcomeOk(CLAVE_ODDS_UFC, r));
    const f = filtrarUfc((r.events as unknown as Record<string, unknown>[]).map(agregarEvento));
    conPrecio = f.peleas.filter((p) => p.odds_home != null && p.odds_away != null).length;
    guardadas = guardarPeleas(f.peleas);
    setMeta('ufc:descartadas', String(f.descartadas));
    setMeta('ufc:sinIdentificar', String(f.sinIdentificar));
  } catch (e) {
    outcomes.push(outcomeError(CLAVE_ODDS_UFC, e, e instanceof OddsBudgetSkip));
    console.warn(`[ufc] ${CLAVE_ODDS_UFC}: ${(e as Error).message}`);
  }
  recordKeyOutcomes('ufc_', outcomes);
  const dec = decideReason(outcomes, conPrecio);
  recordOddsReason('ufc_', dec.reason, dec.reason ? `${dec.detail} · regiones=${env.oddsRegions}` : '');
  if (guardadas) setMeta('ufc_odds_refreshed_at', new Date().toISOString());
  return guardadas;
}

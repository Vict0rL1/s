// Snapshots históricos de mercado: escribir cada cambio de cuota y reconstruir el
// mercado en cualquier instante. Ver odds/schema.ts para el diseño y por qué solo se
// guardan CAMBIOS.
//
// Todo lo que entra aquí viene de una respuesta real de The Odds API (lo llama
// oddsApi.requestOdds). Las cuotas de demostración nunca pasan por aquí: no son mercado.

import { getDb } from '../db.ts';
import { median, type OddsEvent, type OddsResponse } from '../oddsApi.ts';

export type Deporte = 'football' | 'basketball' | 'baseball' | 'nfl' | 'nhl' | 'ufc' | 'tennis' | 'other';

/** Qué deporte es una clave de competición del proveedor. */
export function sportOfKey(key: string): Deporte {
  if (key.startsWith('soccer_')) return 'football';
  if (key.startsWith('basketball_')) return 'basketball';
  if (key.startsWith('baseball_')) return 'baseball';
  if (key.startsWith('americanfootball_')) return 'nfl';
  if (key.startsWith('icehockey_nhl')) return 'nhl';
  // La clave de todo el MMA: de ella solo se guardan peleas de la UFC (ufc/proximos.ts), pero la
  // instantánea de cuotas la guarda entera, como el resto.
  if (key.startsWith('mma_')) return 'ufc';
  if (key.startsWith('tennis_')) return 'tennis';
  return 'other';
}

interface Quote {
  market: string;
  selection: string;
  bookmaker: string;
  odds: number;
  line: number | null;
  sourceUpdatedAt: string | null;
}

/** Todas las cuotas de un evento, una por (mercado, selección, casa). */
export function quotesOf(ev: OddsEvent): Quote[] {
  const out: Quote[] = [];
  for (const bk of ev.bookmakers ?? []) {
    for (const m of bk.markets ?? []) {
      for (const o of m.outcomes ?? []) {
        if (typeof o.price !== 'number' || !(o.price > 1) || !o.name) continue;
        out.push({
          market: m.key,
          selection: o.name,
          bookmaker: bk.key,
          odds: o.price,
          line: typeof o.point === 'number' ? o.point : null,
          sourceUpdatedAt: m.last_update ?? bk.last_update ?? null,
        });
      }
    }
  }
  return out;
}

const k = (q: { market: string; selection: string; bookmaker: string }) => `${q.market}\u0000${q.selection}\u0000${q.bookmaker}`;

/**
 * Registra una respuesta del proveedor: una observación por evento, y un snapshot por
 * cada cuota que cambió (o que se retiró). Todo en una transacción: o entra la respuesta
 * entera o nada, para que el histórico nunca tenga medio refresco.
 */
export function recordOddsResponse(
  sportKey: string,
  markets: string,
  r: Pick<OddsResponse, 'events' | 'fetchedAt'>,
): { observaciones: number; snapshots: number; retiradas: number } {
  const db = getDb();
  const sport = sportOfKey(sportKey);
  const pedidos = new Set(markets.split(',').map((m) => m.trim()));
  const insObs = db.prepare(
    `INSERT INTO odds_event_observations (event_id, sport, league, markets, commence_time, observed_at, bookmakers)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insSnap = db.prepare(
    `INSERT INTO odds_snapshots
       (event_id, sport, league, market, selection, bookmaker, odds_decimal, line,
        home_team, away_team, commence_time, observed_at, source_updated_at, source, is_live, withdrawn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'the-odds-api', ?, ?)`,
  );
  const leerEstado = db.prepare(
    `SELECT market, selection, bookmaker, odds_decimal, line, withdrawn FROM odds_quote_state WHERE event_id = ?`,
  );
  const ponerEstado = db.prepare(
    `INSERT INTO odds_quote_state (event_id, market, selection, bookmaker, odds_decimal, line, withdrawn, snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id, market, selection, bookmaker) DO UPDATE SET
       odds_decimal = excluded.odds_decimal, line = excluded.line,
       withdrawn = excluded.withdrawn, snapshot_id = excluded.snapshot_id`,
  );

  let snapshots = 0;
  let retiradas = 0;
  db.exec('BEGIN');
  try {
    for (const ev of r.events) {
      const quotes = quotesOf(ev);
      insObs.run(ev.id, sport, sportKey, markets, ev.commence_time, r.fetchedAt, (ev.bookmakers ?? []).length);
      const isLive = Date.parse(r.fetchedAt) >= Date.parse(ev.commence_time) ? 1 : 0;
      const estado = new Map(
        (leerEstado.all(ev.id) as { market: string; selection: string; bookmaker: string; odds_decimal: number | null; line: number | null; withdrawn: number }[]).map(
          (s) => [k(s), s],
        ),
      );
      const vistas = new Set<string>();
      for (const q of quotes) {
        const clave = k(q);
        vistas.add(clave);
        const prev = estado.get(clave);
        if (prev && !prev.withdrawn && prev.odds_decimal === q.odds && prev.line === q.line) continue;
        const res = insSnap.run(
          ev.id, sport, sportKey, q.market, q.selection, q.bookmaker, q.odds, q.line,
          ev.home_team, ev.away_team, ev.commence_time, r.fetchedAt, q.sourceUpdatedAt, isLive, 0,
        );
        ponerEstado.run(ev.id, q.market, q.selection, q.bookmaker, q.odds, q.line, 0, Number(res.lastInsertRowid));
        snapshots++;
      }
      // Retiradas: solo de mercados que se PIDIERON en esta descarga. Una petición de
      // h2h no dice nada de los totales, y tomar su ausencia por retirada los borraría.
      for (const [clave, s] of estado) {
        if (vistas.has(clave) || s.withdrawn || !pedidos.has(s.market)) continue;
        const res = insSnap.run(
          ev.id, sport, sportKey, s.market, s.selection, s.bookmaker, null, s.line,
          ev.home_team, ev.away_team, ev.commence_time, r.fetchedAt, null, isLive, 1,
        );
        ponerEstado.run(ev.id, s.market, s.selection, s.bookmaker, null, s.line, 1, Number(res.lastInsertRowid));
        retiradas++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { observaciones: r.events.length, snapshots, retiradas };
}

// ===========================================================================
// RECONSTRUIR EL MERCADO
// ===========================================================================

export interface BookQuote {
  bookmaker: string;
  odds: number;
  line: number | null;
  observedAt: string;
}

/**
 * Las cuotas vigentes de una selección en el instante `at`: por cada casa, su último
 * snapshot anterior o igual a `at`, si no era una retirada.
 */
export function quotesAt(eventId: string, market: string, selection: string, at: string): BookQuote[] {
  const rows = getDb()
    .prepare(
      `SELECT s.bookmaker, s.odds_decimal AS odds, s.line, s.observed_at AS observedAt, s.withdrawn
       FROM odds_snapshots s
       JOIN (
         SELECT bookmaker, MAX(id) AS id FROM odds_snapshots
         WHERE event_id = ? AND market = ? AND selection = ? AND observed_at <= ?
         GROUP BY bookmaker
       ) u ON u.id = s.id`,
    )
    .all(eventId, market, selection, at) as unknown as (BookQuote & { withdrawn: number })[];
  return rows.filter((r) => !r.withdrawn).map(({ withdrawn: _w, ...q }) => q);
}

export interface MarketPoint {
  /** El instante que describe este punto. */
  at: string;
  /** Mediana de las casas vigentes: el «precio de mercado» que usa la app. */
  consensus: number;
  /** La mejor cuota disponible (la más alta) y en qué casa. */
  best: number;
  bestBookmaker: string;
  books: number;
  line: number | null;
}

/**
 * Las cotizaciones de la línea más cotizada (todas, si no hay línea). Un mercado con línea
 * (totales, hándicap) no se puede resumir mezclando líneas: Más de 2,5 a 1,90 y Más de 3,0 a
 * 2,20 son la misma `selection` y precios de cosas distintas (lote C, C2).
 */
export function deLaLineaMasCotizada(qs: BookQuote[]): { linea: number | null; cuotas: BookQuote[] } {
  if (qs.every((q) => q.line == null)) return { linea: null, cuotas: qs };
  const cuenta = new Map<number, number>();
  for (const q of qs) if (q.line != null) cuenta.set(q.line, (cuenta.get(q.line) ?? 0) + 1);
  const [linea] = [...cuenta].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0];
  return { linea, cuotas: qs.filter((q) => q.line === linea) };
}

function toPoint(at: string, todas: BookQuote[]): MarketPoint | null {
  if (todas.length === 0) return null;
  // Un punto describe UNA línea: la más cotizada en ese instante.
  const { linea, cuotas: qs } = deLaLineaMasCotizada(todas);
  const best = qs.reduce((a, b) => (b.odds > a.odds ? b : a));
  return {
    at,
    consensus: median(qs.map((q) => q.odds)),
    best: best.odds,
    bestBookmaker: best.bookmaker,
    books: qs.length,
    line: linea,
  };
}

export function marketAt(eventId: string, market: string, selection: string, at: string): MarketPoint | null {
  return toPoint(at, quotesAt(eventId, market, selection, at));
}

/** Evolución: un punto por cada instante en que ALGUNA casa movió esa selección. */
export function history(eventId: string, market: string, selection: string): MarketPoint[] {
  const times = getDb()
    .prepare(
      `SELECT DISTINCT observed_at FROM odds_snapshots
       WHERE event_id = ? AND market = ? AND selection = ? ORDER BY observed_at`,
    )
    .all(eventId, market, selection) as { observed_at: string }[];
  return times.map((t) => marketAt(eventId, market, selection, t.observed_at)).filter((p): p is MarketPoint => p != null);
}

/** Las selecciones que tiene un evento en un mercado (para pintar su evolución entera). */
export function selectionsOf(eventId: string, market: string): string[] {
  return (
    getDb()
      .prepare('SELECT DISTINCT selection FROM odds_snapshots WHERE event_id = ? AND market = ? ORDER BY selection')
      .all(eventId, market) as { selection: string }[]
  ).map((r) => r.selection);
}

/** La primera vez que se vio precio para esa selección. */
export function openingLine(eventId: string, market: string, selection: string): MarketPoint | null {
  const first = getDb()
    .prepare(
      `SELECT MIN(observed_at) AS t FROM odds_snapshots
       WHERE event_id = ? AND market = ? AND selection = ? AND withdrawn = 0`,
    )
    .get(eventId, market, selection) as { t: string | null };
  return first.t ? marketAt(eventId, market, selection, first.t) : null;
}

/** Lo último que se ha visto, hasta ahora. */
export function latestLine(eventId: string, market: string, selection: string, now = new Date().toISOString()): MarketPoint | null {
  const last = lastObservation(eventId, now);
  return last ? marketAt(eventId, market, selection, last) : null;
}

/** La última vez que el evento apareció en una descarga, hasta `before` (excluido). */
export function lastObservation(eventId: string, before: string): string | null {
  const r = getDb()
    .prepare('SELECT MAX(observed_at) AS t FROM odds_event_observations WHERE event_id = ? AND observed_at < ?')
    .get(eventId, before) as { t: string | null };
  return r.t;
}

/**
 * La cuota de CIERRE: el estado del mercado en la última observación ANTERIOR al inicio.
 *
 * `observedAt` dice cuándo se vio por última vez antes de empezar. Si fue ocho horas
 * antes, el «cierre» es de hace ocho horas, y eso tiene que poder verse: un CLV medido
 * contra una línea vieja no mide lo mismo que uno medido contra la de verdad.
 */
export function closingLine(
  eventId: string,
  market: string,
  selection: string,
  commenceTime: string,
): (MarketPoint & { minutesBeforeStart: number }) | null {
  const t = lastObservation(eventId, commenceTime);
  if (!t) return null;
  const p = marketAt(eventId, market, selection, t);
  if (!p) return null;
  return { ...p, minutesBeforeStart: Math.round((Date.parse(commenceTime) - Date.parse(t)) / 60_000) };
}

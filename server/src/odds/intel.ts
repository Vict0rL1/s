// Inteligencia de mercado (Fase 4.9), a partir de los snapshots de cuotas que ya se guardan.
//
// Tres lecturas, las tres etiquetadas como aproximación porque la app ve PRECIOS, no
// volumen ni apuestas:
//   · steam moves: la cuota de consenso (mediana de las casas) se mueve ≥ 2 pp de
//     probabilidad implícita en ≤ 60 minutos con al menos 3 casas cotizando. Un
//     movimiento así y a la vez suele ser dinero informado; también puede ser una
//     alineación publicada. Aquí solo se señala; no se apuesta.
//   · surebets: la mejor cuota de cada selección, en casas distintas, suma menos de 1 en
//     probabilidad implícita. Casi siempre dura minutos y rara vez se puede cobrar en
//     todas las casas a la vez.
//   · referencia afilada: Pinnacle como vara (la misma del CLV histórico): su
//     probabilidad sin margen frente a la del consenso, en pp.
// Nada de esto cambia una probabilidad del modelo.

import { getDb } from '../db.ts';
import { quotesAt, history, selectionsOf, type BookQuote } from './snapshots.ts';

export const VENTANA_HORAS = 48;
export const STEAM_MIN_PP = 2;
export const STEAM_MIN_MINUTOS = 60;
export const STEAM_MIN_CASAS = 3;
export const REFERENCIA = 'pinnacle';

export interface EventoMercado {
  eventId: string;
  sport: string;
  league: string;
  market: string;
  partido: string;
  cuando: string | null;
}

export interface Steam extends EventoMercado {
  seleccion: string;
  desde: number;
  hasta: number;
  /** Cambio en probabilidad implícita (1/cuota), en pp; positivo = la selección se acorta. */
  movimientoPp: number;
  minutos: number;
  casas: number;
  observadoEn: string;
}

export interface Surebet extends EventoMercado {
  /** Σ 1/mejor: por debajo de 1 hay hueco. */
  suma: number;
  margenPct: number;
  patas: { seleccion: string; cuota: number; casa: string }[];
  /** La |línea| de la surebet (totales, hándicap); null sin línea (lote C, C2). */
  linea: number | null;
}

export interface Referencia extends EventoMercado {
  casa: string;
  selecciones: { seleccion: string; referencia: number; consenso: number; desviacionPp: number }[];
  observadoEn: string;
}

export interface Inteligencia {
  generado: string;
  ventanaHoras: number;
  eventos: number;
  steam: Steam[];
  surebets: Surebet[];
  referencia: Referencia[];
  etiqueta: string;
}

export const ETIQUETA_INTEL =
  'Aproximación a partir de los precios observados (sin volumen): el consenso es la mediana de las casas y una ' +
  'surebet rara vez se puede cerrar en todas a la vez. Informa; no apuesta ni cambia ninguna probabilidad.';

/** Eventos con cuotas vistas en las últimas horas y que aún no han empezado. */
export function eventosRecientes(now = new Date(), horas = VENTANA_HORAS): EventoMercado[] {
  const desde = new Date(now.getTime() - horas * 3_600_000).toISOString();
  try {
    return (
      getDb()
        .prepare(
          `SELECT event_id AS eventId, sport, league, market, home_team, away_team, commence_time AS cuando
             FROM odds_snapshots WHERE observed_at >= ? AND is_live = 0 AND (commence_time IS NULL OR commence_time > ?)
            GROUP BY event_id, market ORDER BY commence_time, event_id`,
        )
        .all(desde, now.toISOString()) as unknown as (EventoMercado & { home_team: string | null; away_team: string | null })[]
    ).map((e) => ({ eventId: e.eventId, sport: e.sport, league: e.league, market: e.market, partido: e.home_team && e.away_team ? `${e.home_team} vs ${e.away_team}` : e.eventId, cuando: e.cuando }));
  } catch {
    return [];
  }
}

const implicita = (cuota: number) => 1 / cuota;

/**
 * El último movimiento rápido de una selección, si lo hubo: medido contra el punto más antiguo
 * DENTRO de la ventana (lote C, C3: antes, sin ningún punto dentro, se medía contra el anterior
 * aunque fuera de hace horas) y solo entre puntos de la MISMA línea (C2: pasar de Más 2,5 a Más
 * 3,0 no es un movimiento, es otra línea).
 */
export function steamDe(puntos: { at: string; consensus: number; books: number; line?: number | null }[]): Omit<Steam, keyof EventoMercado | 'seleccion'> | null {
  if (puntos.length < 2) return null;
  const ultimo = puntos[puntos.length - 1];
  if (ultimo.books < STEAM_MIN_CASAS) return null;
  const tUlt = Date.parse(ultimo.at);
  let base: (typeof puntos)[number] | null = null;
  for (let i = puntos.length - 2; i >= 0; i--) {
    if (tUlt - Date.parse(puntos[i].at) > STEAM_MIN_MINUTOS * 60_000) break;
    if ((puntos[i].line ?? null) !== (ultimo.line ?? null)) continue;
    base = puntos[i];
  }
  if (!base) return null;
  const movimiento = (implicita(ultimo.consensus) - implicita(base.consensus)) * 100;
  if (Math.abs(movimiento) < STEAM_MIN_PP) return null;
  return {
    desde: base.consensus,
    hasta: ultimo.consensus,
    movimientoPp: Math.round(movimiento * 10) / 10,
    minutos: Math.round((tUlt - Date.parse(base.at)) / 60_000),
    casas: ultimo.books,
    observadoEn: ultimo.at,
  };
}

/**
 * La surebet de un mercado con las mejores cuotas actuales de cada selección. Con líneas, solo
 * entre líneas COMPLEMENTARIAS (lote C, C2): Más 2,5 se cubre con Menos 2,5, y el hándicap −3,5
 * con el +3,5 (misma |línea|). Más 2,5 con Menos 3,0 «suma menos de 1» y no cubre nada.
 */
export function surebetDe(porSeleccion: { seleccion: string; cuotas: BookQuote[] }[]): Omit<Surebet, keyof EventoMercado> | null {
  if (porSeleccion.length < 2 || porSeleccion.some((s) => s.cuotas.length === 0)) return null;
  const claveDe = (q: BookQuote) => (q.line == null ? 'sin-linea' : String(Math.abs(q.line)));
  const claves = new Set(porSeleccion[0].cuotas.map(claveDe));
  let mejorSurebet: Omit<Surebet, keyof EventoMercado> | null = null;
  for (const clave of claves) {
    const patas: { seleccion: string; cuota: number; casa: string }[] = [];
    for (const s of porSeleccion) {
      const enLinea = s.cuotas.filter((q) => claveDe(q) === clave);
      if (enLinea.length === 0) break;
      const mejor = enLinea.reduce((a, b) => (b.odds > a.odds ? b : a));
      patas.push({ seleccion: s.seleccion, cuota: mejor.odds, casa: mejor.bookmaker });
    }
    if (patas.length !== porSeleccion.length) continue;
    const suma = patas.reduce((a, p) => a + implicita(p.cuota), 0);
    if (suma >= 1) continue;
    const candidata = { suma: Math.round(suma * 10000) / 10000, margenPct: Math.round((1 - suma) * 1000) / 10, patas, linea: clave === 'sin-linea' ? null : Number(clave) };
    if (!mejorSurebet || candidata.suma < mejorSurebet.suma) mejorSurebet = candidata;
  }
  return mejorSurebet;
}

const sinMargen = (xs: number[]) => {
  const s = xs.reduce((a, b) => a + b, 0);
  return xs.map((x) => x / s);
};

export function referenciaDe(porSeleccion: { seleccion: string; cuotas: BookQuote[] }[], casa = REFERENCIA): Omit<Referencia, keyof EventoMercado> | null {
  const ref = porSeleccion.map((s) => s.cuotas.find((q) => q.bookmaker.toLowerCase() === casa));
  if (porSeleccion.length < 2 || ref.some((r) => !r)) return null;
  const pRef = sinMargen(ref.map((r) => implicita((r as BookQuote).odds)));
  const pCons = sinMargen(porSeleccion.map((s) => implicita(mediana(s.cuotas.map((q) => q.odds)))));
  return {
    casa,
    selecciones: porSeleccion.map((s, i) => ({ seleccion: s.seleccion, referencia: pRef[i], consenso: pCons[i], desviacionPp: Math.round((pCons[i] - pRef[i]) * 1000) / 10 })),
    observadoEn: (ref[0] as BookQuote).observedAt,
  };
}

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function inteligenciaMercado(now = new Date()): Inteligencia {
  const eventos = eventosRecientes(now);
  const at = now.toISOString();
  const steam: Steam[] = [];
  const surebets: Surebet[] = [];
  const referencia: Referencia[] = [];
  for (const e of eventos) {
    let selecciones: string[] = [];
    try {
      selecciones = selectionsOf(e.eventId, e.market);
    } catch {
      continue;
    }
    const porSeleccion = selecciones.map((s) => ({ seleccion: s, cuotas: quotesAt(e.eventId, e.market, s, at) }));
    for (const s of selecciones) {
      const st = steamDe(history(e.eventId, e.market, s));
      if (st) steam.push({ ...e, seleccion: s, ...st });
    }
    const sb = surebetDe(porSeleccion);
    if (sb) surebets.push({ ...e, ...sb });
    const ref = referenciaDe(porSeleccion);
    if (ref) referencia.push({ ...e, ...ref });
  }
  steam.sort((a, b) => Math.abs(b.movimientoPp) - Math.abs(a.movimientoPp));
  surebets.sort((a, b) => b.margenPct - a.margenPct);
  return { generado: at, ventanaHoras: VENTANA_HORAS, eventos: eventos.length, steam, surebets, referencia, etiqueta: ETIQUETA_INTEL };
}

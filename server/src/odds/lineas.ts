// Comparador de líneas (Fase 6.5): para cada mercado abierto, la mejor cuota de cada selección y
// en qué casa, la peor, el consenso, cuánto discrepan las casas y si las mejores juntas dejan una
// surebet. Solo lectura: no apuesta ni cambia nada.
//
// ===========================================================================
// LO QUE HACE EL BANCO DE PAPEL, DICHO COMO ES
// ===========================================================================
// El banco de papel apuesta al CONSENSO (la mediana de las casas, paper/bankroll.ts), no a la
// mejor cuota. Es conservador a propósito: la mejor cuota a menudo es de una casa que limita o que
// tarda en mover, y apostar a ella haría que el banco presumiera de un precio que casi nadie
// consigue. Esta vista enseña cuánto precio se deja por esa decisión (`mejorSobreConsenso`), que
// es un dato para decidir si cambiarla; cambiarla sería una versión nueva de la política.
//
// ===========================================================================
// UNA LÍNEA ES UNA APUESTA DISTINTA
// ===========================================================================
// En hándicaps y totales cada casa puede cotizar una línea distinta (−3,5 en una, −3 en otra), y
// comparar sus cuotas sería comparar apuestas distintas. Se compara solo dentro de la línea más
// cotizada de cada selección y se dice cuál es.

import { getDb } from '../db.ts';
import { quotesAt, selectionsOf, type BookQuote, deLaLineaMasCotizada } from './snapshots.ts';
import { eventosRecientes, VENTANA_HORAS } from './intel.ts';

export interface LineaSeleccion {
  seleccion: string;
  /** La línea comparada (hándicap o total); null en ganador. */
  linea: number | null;
  mejor: { cuota: number; casa: string };
  peor: { cuota: number; casa: string };
  consenso: number;
  casas: number;
  /** Desviación típica entre casas de la probabilidad implícita (1/cuota), en pp. */
  dispersionPp: number;
  /** Cuánto paga la mejor sobre el consenso: mejor/consenso − 1. */
  mejorSobreConsenso: number;
}

export interface MercadoLinea {
  eventId: string;
  sport: string;
  league: string;
  market: string;
  partido: string;
  cuando: string | null;
  /** El id de la fila de próximos (la ficha /partido/:sport/:id), si la hay. */
  eventoId: string | null;
  selecciones: LineaSeleccion[];
  /** Σ 1/mejor − 1: el margen que queda tomando la mejor de cada selección. Negativo = surebet. */
  margenMejor: number | null;
  /** Σ 1/consenso − 1: el margen del precio de consenso. */
  margenConsenso: number | null;
  surebet: boolean;
  observado: string | null;
}

export interface Comparador {
  generado: string;
  ventanaHoras: number;
  mercados: MercadoLinea[];
  eventos: number;
  bancoApuestaA: 'consenso';
  nota: string;
}

export const NOTA_LINEAS =
  'Solo lectura. El banco de papel apuesta al consenso (mediana de casas), no a la mejor cuota: «mejor sobre consenso» es el precio que deja por eso. ' +
  'Una surebet sobre el papel rara vez se cobra en todas las casas a la vez, y las cuotas pueden haber cambiado desde la última observación.';

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// `deLaLineaMasCotizada` vive en snapshots.ts desde el lote C (C2): la usan también el consenso
// por instante (`marketAt`) y la inteligencia de mercado. Aquí se reexporta.
export { deLaLineaMasCotizada };

export function lineaDe(seleccion: string, qs: BookQuote[]): LineaSeleccion | null {
  const { linea, cuotas } = deLaLineaMasCotizada(qs.filter((q) => q.odds > 1));
  if (cuotas.length === 0) return null;
  const mejor = cuotas.reduce((a, b) => (b.odds > a.odds ? b : a));
  const peor = cuotas.reduce((a, b) => (b.odds < a.odds ? b : a));
  const consenso = mediana(cuotas.map((q) => q.odds));
  const imp = cuotas.map((q) => 1 / q.odds);
  const media = imp.reduce((a, b) => a + b, 0) / imp.length;
  const sd = Math.sqrt(imp.reduce((a, b) => a + (b - media) ** 2, 0) / imp.length);
  return {
    seleccion,
    linea,
    mejor: { cuota: mejor.odds, casa: mejor.bookmaker },
    peor: { cuota: peor.odds, casa: peor.bookmaker },
    consenso,
    casas: cuotas.length,
    dispersionPp: Math.round(sd * 1000) / 10,
    mejorSobreConsenso: mejor.odds / consenso - 1,
  };
}

/** El margen de un mercado con unas cuotas (una por selección). */
export function margen(cuotas: number[]): number | null {
  if (cuotas.length < 2 || cuotas.some((c) => !(c > 1))) return null;
  return cuotas.reduce((a, c) => a + 1 / c, 0) - 1;
}

const PROXIMOS: Record<string, string> = { tennis: 'upcoming_matches', football: 'fb_upcoming', basketball: 'bb_upcoming', baseball: 'bsb_upcoming', nfl: 'naf_upcoming', nhl: 'nhl_upcoming', ufc: 'ufc_upcoming' };

/** El id de la fila de próximos para un evento del proveedor (la NFL lo guarda con «odds-»). */
export function idProximo(sport: string, eventId: string): string | null {
  const t = PROXIMOS[sport];
  if (!t) return null;
  try {
    const r = getDb().prepare(`SELECT id FROM ${t} WHERE id IN (?, ?) LIMIT 1`).get(eventId, `odds-${eventId}`) as { id: string } | undefined;
    return r?.id ?? null;
  } catch {
    return null;
  }
}

export function comparadorDeLineas(now = new Date(), opts: { sport?: string; market?: string } = {}): Comparador {
  const at = now.toISOString();
  const eventos = eventosRecientes(now).filter((e) => (!opts.sport || e.sport === opts.sport) && (!opts.market || e.market === opts.market));
  const mercados: MercadoLinea[] = [];
  for (const e of eventos) {
    let selecciones: string[] = [];
    try {
      selecciones = selectionsOf(e.eventId, e.market);
    } catch {
      continue;
    }
    const lineas = selecciones.map((s) => lineaDe(s, quotesAt(e.eventId, e.market, s, at))).filter((x): x is LineaSeleccion => x != null);
    if (lineas.length === 0) continue;
    // Las casas cotizan todas las selecciones de un mercado; si falta alguna, el margen no se puede calcular.
    const completo = lineas.length === selecciones.length;
    const margenMejor = completo ? margen(lineas.map((l) => l.mejor.cuota)) : null;
    let observado: string | null = null;
    for (const s of selecciones) for (const q of quotesAt(e.eventId, e.market, s, at)) if (!observado || q.observedAt > observado) observado = q.observedAt;
    mercados.push({
      ...e,
      eventoId: idProximo(e.sport, e.eventId),
      selecciones: lineas,
      margenMejor: margenMejor == null ? null : Math.round(margenMejor * 10000) / 10000,
      margenConsenso: completo ? margen(lineas.map((l) => l.consenso)) : null,
      surebet: margenMejor != null && margenMejor < 0,
      observado,
    });
  }
  // Primero lo que empieza antes; las surebets, arriba.
  mercados.sort((a, b) => Number(b.surebet) - Number(a.surebet) || String(a.cuando).localeCompare(String(b.cuando)));
  return { generado: at, ventanaHoras: VENTANA_HORAS, mercados, eventos: eventos.length, bancoApuestaA: 'consenso', nota: NOTA_LINEAS };
}

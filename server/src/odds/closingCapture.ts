// Capturar la cuota de CIERRE de verdad: pedir el mercado justo antes de que empiece un
// partido que importa.
//
// ===========================================================================
// EL PROBLEMA
// ===========================================================================
// El cierre es «el último estado del mercado antes del inicio» (odds/snapshots.ts). Con el
// refresco automático cada 12 horas, esa última observación puede ser de la mañana para un
// partido de la noche, y un CLV medido contra ella no mide casi nada: compara la cuota
// apostada con otra cuota vieja.
//
// ===========================================================================
// LA SOLUCIÓN, BARATA
// ===========================================================================
// Solo se pide lo que hace falta: las competiciones donde hay una apuesta de papel
// pendiente o una señal sin cierre cuyo partido empieza en los próximos
// VENTANA_MIN minutos y que no se ha observado en los últimos FRESCO_MIN. Una petición
// por competición (h2h, 1 crédito por región), y varios partidos de la misma liga a la
// misma hora comparten la petición.
//
// Respeta el presupuesto como cualquier refresco automático (reserva y freno de ritmo):
// si el freno no deja, se dice en el log y el cierre queda en la última observación, con
// sus «minutos antes del inicio» a la vista para quien lo lea.

import { getDb } from '../db.ts';
import { env } from '../config.ts';
import { requestOdds } from '../oddsApi.ts';
import { OddsBudgetSkip } from '../oddsQuota.ts';

/** Cuánto antes del inicio se empieza a vigilar. */
export const VENTANA_MIN = 30;
/** Una observación más reciente que esto se da por buena como cierre. */
export const FRESCO_MIN = 15;

/** Las competiciones (claves del proveedor) que necesitan una observación ya. */
export function closingTargets(now = new Date()): string[] {
  const ahora = now.toISOString();
  const hasta = new Date(now.getTime() + VENTANA_MIN * 60_000).toISOString();
  const fresco = new Date(now.getTime() - FRESCO_MIN * 60_000).toISOString();
  const rows = getDb()
    .prepare(
      `WITH abiertos AS (
         SELECT provider_event_id AS ev, commence_time FROM paper_bets
          WHERE status = 'pending' AND provider_event_id IS NOT NULL AND closing_odds IS NULL
         UNION
         SELECT provider_event_id, commence_time FROM edge_signals
          WHERE provider_event_id IS NOT NULL AND closing_odds IS NULL
       )
       SELECT DISTINCT o.league
         FROM abiertos a
         JOIN odds_event_observations o ON o.event_id = a.ev
        WHERE a.commence_time > ? AND a.commence_time <= ?
          AND NOT EXISTS (
            SELECT 1 FROM odds_event_observations r WHERE r.event_id = a.ev AND r.observed_at >= ?
          )`,
    )
    .all(ahora, hasta, fresco) as { league: string }[];
  return rows.map((r) => r.league).sort();
}

/**
 * Pide las competiciones que lo necesitan. Cada respuesta queda en los snapshots, y de
 * ahí sale el cierre cuando el partido empiece.
 */
export async function captureClosingOdds(
  log: (m: string) => void = () => {},
  now = new Date(),
): Promise<{ pedidas: string[]; frenadas: string[]; fallidas: string[] }> {
  const out = { pedidas: [] as string[], frenadas: [] as string[], fallidas: [] as string[] };
  if (!env.oddsApiKey) return out;
  for (const key of closingTargets(now)) {
    try {
      await requestOdds(key, { markets: 'h2h' });
      out.pedidas.push(key);
    } catch (e) {
      if (e instanceof OddsBudgetSkip) out.frenadas.push(key);
      else out.fallidas.push(key);
      log(`Cierre: no se pudo observar ${key} antes del inicio: ${(e as Error).message}`);
    }
  }
  if (out.pedidas.length) log(`Cierre: observadas ${out.pedidas.join(', ')} antes del inicio.`);
  return out;
}

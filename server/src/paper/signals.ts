// Las señales de edge: cada evaluación de la política sobre un partido con precio real.
// Ver EDGE_SIGNALS_SCHEMA en paper/schema.ts para por qué existen.

import { getDb } from '../db.ts';
import { closingLine } from '../odds/snapshots.ts';
import type { Versions } from '../versions.ts';

export interface Senal {
  sport: string;
  league: string | null;
  eventId: string;
  providerEventId: string;
  selection: string;
  providerSelection: string;
  pRaw: number;
  pCal: number;
  pMarket: number;
  odds: number;
  edge: number;
  kellyRaw: number;
  decision: 'apostada' | 'rechazada';
  reason: string | null;
  stake: number;
  paperBetId: number | null;
  versions: Versions;
  predictionTimestamp: string | null;
  oddsTimestamp: string | null;
  commenceTime: string;
}

/**
 * Registra una señal, salvo que sea IGUAL a la última de ese partido y selección.
 *
 * «Igual» = misma cuota, misma probabilidad calibrada y misma decisión. Cada refresco
 * vuelve a evaluar los partidos no apostados, y sin esto un partido rechazado durante una
 * semana dejaría catorce filas idénticas, pesando catorce veces en cualquier media. Si la
 * cuota se mueve, sí es una señal nueva: el mismo modelo ante otro precio.
 *
 * Devuelve el id insertado, o null si no hacía falta.
 */
export function recordSignal(s: Senal, now = new Date()): number | null {
  const db = getDb();
  const ultima = db
    .prepare('SELECT odds, model_probability_calibrated AS p, decision FROM edge_signals WHERE event_id = ? AND selection = ? ORDER BY id DESC LIMIT 1')
    .get(s.eventId, s.selection) as { odds: number; p: number; decision: string } | undefined;
  if (ultima && ultima.odds === s.odds && ultima.p === s.pCal && ultima.decision === s.decision) return null;
  const r = db
    .prepare(
      `INSERT INTO edge_signals (
         created_at, sport, league, event_id, provider_event_id, market, selection, provider_selection,
         model_probability_raw, model_probability_calibrated, market_probability_no_vig, odds, edge, kelly_raw,
         decision, reason, stake, paper_bet_id, model_version, calibration_version, strategy_version, data_version,
         git_commit, prediction_timestamp, odds_timestamp, commence_time
       ) VALUES (?, ?, ?, ?, ?, 'h2h', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now.toISOString(), s.sport, s.league, s.eventId, s.providerEventId, s.selection, s.providerSelection,
      s.pRaw, s.pCal, s.pMarket, s.odds, s.edge, s.kellyRaw, s.decision, s.reason, s.stake, s.paperBetId,
      s.versions.model_version, s.versions.calibration_version, s.versions.strategy_version, s.versions.data_version,
      s.versions.git_commit, s.predictionTimestamp, s.oddsTimestamp, s.commenceTime,
    );
  return Number(r.lastInsertRowid);
}

/** Fija la cuota de cierre y el CLV de las señales cuyo partido ya empezó. */
export function captureSignalClosing(now = new Date()): { fijados: number } {
  const db = getDb();
  const sin = db
    .prepare(
      `SELECT id, provider_event_id, provider_selection, market, commence_time, odds FROM edge_signals
        WHERE closing_odds IS NULL AND provider_event_id IS NOT NULL AND commence_time <= ?`,
    )
    .all(now.toISOString()) as { id: number; provider_event_id: string; provider_selection: string; market: string; commence_time: string; odds: number }[];
  const upd = db.prepare('UPDATE edge_signals SET closing_odds = ?, closing_observed_at = ?, clv = ? WHERE id = ?');
  let fijados = 0;
  for (const s of sin) {
    const cl = closingLine(s.provider_event_id, s.market, s.provider_selection, s.commence_time);
    if (!cl) continue;
    upd.run(cl.consensus, cl.at, s.odds / cl.consensus - 1, s.id);
    fijados++;
  }
  return { fijados };
}

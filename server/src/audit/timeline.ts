// La línea temporal de un partido: todo lo que la app hizo con él, en orden, sacado de
// las filas guardadas. Ningún evento se deduce ni se rellena: si algo no está guardado,
// no aparece (y la nota final lo recuerda).

import { getDb } from '../db.ts';
import { alertas } from '../alerts/engine.ts';
import type { SportId } from '../sports.ts';

export interface Hito {
  at: string;
  tipo: string;
  texto: string;
}

/** Dónde vive el registro de predicciones de cada deporte y cómo se llama su clave. */
const LOG: Record<SportId, { tabla: string; clave: string; prob: string; resultado: string }> = {
  tennis: { tabla: 'prediction_log', clave: 'match_key', prob: 'prob1', resultado: 'winner_id' },
  football: { tabla: 'fb_prediction_log', clave: 'match_key', prob: 'COALESCE(shown_home, prob_home)', resultado: 'home_goals' },
  basketball: { tabla: 'bb_prediction_log', clave: 'game_key', prob: 'prob_home', resultado: 'home_pts' },
  baseball: { tabla: 'bsb_prediction_log', clave: 'match_key', prob: 'prob_home', resultado: 'home_runs' },
  nfl: { tabla: 'naf_prediction_log', clave: 'match_key', prob: 'COALESCE(shown_home, prob_home)', resultado: 'home_points' },
  nhl: { tabla: 'nhl_prediction_log', clave: 'match_key', prob: 'COALESCE(shown_home, prob_home)', resultado: 'home_goals' },
  ufc: { tabla: 'ufc_prediction_log', clave: 'match_key', prob: 'COALESCE(shown_home, prob_home)', resultado: 'home_score' },
};

const pc = (p: number) => `${(p * 100).toFixed(1).replace('.', ',')} %`;

export function lineaTemporal(sport: SportId, matchKey: string): { hitos: Hito[]; nota: string } {
  const db = getDb();
  const h: Hito[] = [];
  const l = LOG[sport];
  const log = db.prepare(`SELECT *, ${l.prob} AS p FROM ${l.tabla} WHERE ${l.clave} = ?`).get(matchKey) as Record<string, unknown> | undefined;
  if (log) {
    h.push({ at: String(log.predicted_at), tipo: 'predicción', texto: `El modelo registra su predicción: ${pc(Number(log.p))} para el primero (${log.model_version ?? 'sin versión'})` });
    if (log.commence_time) h.push({ at: String(log.commence_time), tipo: 'inicio', texto: 'Empieza el partido' });
    if (log.resolved_at) h.push({ at: String(log.resolved_at), tipo: 'resultado', texto: 'Resultado registrado en el archivo' });
  }
  const eventId = log?.upcoming_id ? String(log.upcoming_id).replace(/^odds-/, '') : null;
  if (eventId) {
    const o = db.prepare('SELECT MIN(observed_at) AS a, MAX(observed_at) AS b, COUNT(*) AS n FROM odds_event_observations WHERE event_id = ?').get(eventId) as { a: string | null; b: string | null; n: number };
    if (o.a) h.push({ at: o.a, tipo: 'mercado', texto: `Cuotas observadas por primera vez (${o.n} descargas en total)` });
    if (o.b && o.b !== o.a) h.push({ at: o.b, tipo: 'mercado', texto: 'Última descarga de cuotas' });
  }
  for (const s of db.prepare('SELECT captured_at, probs, market_probs, data_version FROM prediction_snapshots WHERE sport = ? AND match_key = ? ORDER BY captured_at').all(sport, matchKey) as { captured_at: string; probs: string; market_probs: string | null; data_version: string }[]) {
    const p = JSON.parse(s.probs) as number[];
    const m = s.market_probs ? (JSON.parse(s.market_probs) as number[]) : null;
    h.push({ at: s.captured_at, tipo: 'instantánea', texto: `Instantánea: ${pc(p[0])}${m ? ` · mercado ${pc(m[0])}` : ''} · datos ${s.data_version}` });
  }
  for (const a of db.prepare('SELECT assessed_at, decision, confidence, data_quality, reasons FROM prediction_assessments WHERE sport = ? AND match_key = ? ORDER BY assessed_at').all(sport, matchKey) as { assessed_at: string; decision: string; confidence: string; data_quality: number; reasons: string }[]) {
    const r = JSON.parse(a.reasons) as string[];
    h.push({ at: a.assessed_at, tipo: 'confianza', texto: `Evaluación: ${a.decision} · confianza ${a.confidence} · datos ${a.data_quality}/100${r[0] ? ` · ${r[0]}` : ''}` });
  }
  if (eventId) {
    for (const s of db.prepare('SELECT created_at, selection, odds, edge, decision, reason, closing_observed_at, closing_odds, clv FROM edge_signals WHERE provider_event_id = ? OR event_id = ? ORDER BY id').all(eventId, String(log?.upcoming_id ?? eventId)) as Record<string, unknown>[]) {
      h.push({ at: String(s.created_at), tipo: 'señal', texto: `Señal: ${s.selection} a ${Number(s.odds).toFixed(2)}, ventaja ${(Number(s.edge) * 100).toFixed(1)} % → ${s.decision}${s.reason ? ` (${s.reason})` : ''}` });
    }
  }
  for (const b of db.prepare('SELECT * FROM paper_bets WHERE match_key = ? AND sport = ?').all(matchKey, sport) as Record<string, unknown>[]) {
    h.push({ at: String(b.placed_at), tipo: 'apuesta', texto: `Apuesta de papel: ${b.selection} @ ${Number(b.odds).toFixed(2)}, ${Number(b.stake).toFixed(2)} (${b.confidence ? `confianza ${b.confidence}` : 'sin evaluación'})` });
    if (b.closing_observed_at) h.push({ at: String(b.closing_observed_at), tipo: 'cierre', texto: `Cuota de cierre: ${Number(b.closing_odds).toFixed(2)} · CLV ${(Number(b.clv) * 100).toFixed(1)} %` });
    if (b.settled_at) h.push({ at: String(b.settled_at), tipo: 'liquidación', texto: `Liquidada: ${b.status}, ${Number(b.profit) >= 0 ? '+' : ''}${Number(b.profit).toFixed(2)}` });
  }
  const f = db.prepare('SELECT frozen_at, source, probs FROM prematch_final WHERE sport = ? AND match_key = ?').get(sport, matchKey) as { frozen_at: string; source: string; probs: string } | undefined;
  if (f) h.push({ at: f.frozen_at, tipo: 'congelada', texto: `Predicción final pre-partido congelada: ${pc((JSON.parse(f.probs) as number[])[0])} (desde ${f.source === 'snapshot' ? 'instantánea' : 'registro'})` });
  for (const a of alertas({ sport, matchKey, limit: 50 })) h.push({ at: a.created_at, tipo: 'alerta', texto: `Alerta: ${a.title} — ${a.body}` });
  h.sort((x, y) => x.at.localeCompare(y.at));
  return { hitos: h, nota: 'Solo hechos guardados. Lo que no se guardó (por ejemplo, horas con el servidor apagado) no aparece.' };
}

// ¿Mejora el modelo cerca del partido? La misma capa de métricas, aplicada a lo que el
// modelo decía a T-24h, T-6h, T-1h y en la final pre-partido, sobre los MISMOS partidos.
//
// Emparejado a propósito: si T-1h se midiera sobre más partidos que T-24h (porque el
// servidor estaba encendido esa tarde y no la víspera), la diferencia mezclaría el
// horizonte con la muestra.

import { getDb } from '../db.ts';
import { evaluate, type Informe } from '../evaluation/metrics.ts';
import { SPORT_IDS, type SportId } from '../sports.ts';
import { horizontes } from './snapshots.ts';

/** El resultado de cada partido resuelto, en el orden de resultados de la instantánea. */
export const RESULTADOS: Record<SportId, string> = {
  tennis: `SELECT match_key AS k, CASE WHEN winner_id = p1_id THEN 0 ELSE 1 END AS y FROM prediction_log WHERE winner_id IS NOT NULL`,
  football: `SELECT match_key AS k, CASE WHEN home_goals > away_goals THEN 0 WHEN home_goals = away_goals THEN 1 ELSE 2 END AS y
               FROM fb_prediction_log WHERE home_goals IS NOT NULL`,
  basketball: `SELECT game_key AS k, CASE WHEN home_pts > away_pts THEN 0 ELSE 1 END AS y FROM bb_prediction_log
                WHERE home_pts IS NOT NULL AND home_pts <> away_pts`,
  baseball: `SELECT match_key AS k, CASE WHEN home_runs > away_runs THEN 0 ELSE 1 END AS y FROM bsb_prediction_log
              WHERE home_runs IS NOT NULL AND home_runs <> away_runs`,
  nfl: `SELECT match_key AS k, CASE WHEN home_points > away_points THEN 0 ELSE 1 END AS y FROM naf_prediction_log
         WHERE home_points IS NOT NULL AND home_points <> away_points`,
  nhl: `SELECT match_key AS k, CASE WHEN home_goals > away_goals THEN 0 ELSE 1 END AS y FROM nhl_prediction_log
         WHERE home_goals IS NOT NULL AND home_goals <> away_goals`,
  ufc: `SELECT match_key AS k, CASE WHEN outcome = 'A' THEN 0 ELSE 1 END AS y FROM ufc_prediction_log WHERE outcome IN ('A', 'B')`,
};

export interface EvaluacionHorizontes {
  deporte: SportId;
  /** Partidos resueltos con instantánea en TODOS los horizontes. */
  emparejados: number;
  /** Partidos resueltos con alguna instantánea. */
  conInstantaneas: number;
  horizontes: { etiqueta: string; informe: Informe }[];
}

export function evaluacionPorHorizonte(): EvaluacionHorizontes[] {
  const db = getDb();
  return SPORT_IDS.map((deporte) => {
    let resueltos: { k: string; y: number }[] = [];
    try {
      resueltos = db.prepare(RESULTADOS[deporte]).all() as { k: string; y: number }[];
    } catch {
      resueltos = [];
    }
    const y = new Map(resueltos.map((r) => [r.k, r.y]));
    const eventos = db
      .prepare('SELECT match_key, MAX(commence_time) AS c FROM prediction_snapshots WHERE sport = ? GROUP BY match_key')
      .all(deporte) as { match_key: string; c: string }[];
    const porHorizonte = new Map<string, { p: number[]; y: number; mercado: number[] | null }[]>();
    let conInstantaneas = 0;
    let emparejados = 0;
    for (const e of eventos) {
      const res = y.get(e.match_key);
      if (res == null) continue;
      conInstantaneas++;
      // Solo partidos jugados: todas sus marcas han llegado (horizontes() deja pendientes las futuras).
      const hs = horizontes(deporte, e.match_key, e.c, new Date(Date.parse(e.c) + 1));
      if (hs.some((h) => !h.fila)) continue;
      emparejados++;
      for (const h of hs) {
        const f = h.fila!;
        const xs = porHorizonte.get(h.etiqueta) ?? [];
        xs.push({ p: f.probs, y: res, mercado: f.market_probs });
        porHorizonte.set(h.etiqueta, xs);
      }
    }
    const etiquetas = ['T-24h', 'T-6h', 'T-1h', 'Final pre-partido'];
    return {
      deporte,
      emparejados,
      conInstantaneas,
      horizontes: etiquetas.map((etiqueta) => ({ etiqueta, informe: evaluate('live', deporte, porHorizonte.get(etiqueta) ?? []) })),
    };
  });
}

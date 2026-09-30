// La evaluación EN VIVO: lo que el modelo dijo antes de cada partido real, contra lo que
// pasó. Solo lee los registros de predicciones (escritos antes del partido, inmutables):
// ningún número de backtest entra aquí, y por eso cada informe lleva `origen: 'live'`.
//
// Se evalúa la probabilidad ENSEÑADA (la calibrada, donde hay capa de calibración), que es
// la que la persona vio y la que usa el banco de papel. Juzgar la cruda sería juzgar un
// número que no se enseñó — el fallo que tuvo «¿Acertó?».

import { getDb } from '../db.ts';
import { evaluate, type Informe, type Prediccion } from './metrics.ts';
import { SPORT_IDS, type SportId } from '../sports.ts';

type Fila = Record<string, number | string | null>;

/** Una predicción en vivo, con la versión del modelo que la hizo (null: anterior al versionado). */
export type PrediccionEnVivo = Prediccion & { version: string | null };

function leer(sql: string): Fila[] {
  try {
    return getDb().prepare(sql).all() as Fila[];
  } catch {
    // Un deporte sin tabla todavía no puede tumbar la evaluación de los otros cuatro.
    return [];
  }
}

const dos = (r: Fila): PrediccionEnVivo => ({
  p: [r.p as number, 1 - (r.p as number)],
  y: r.y as number,
  mercado: r.m == null ? null : [r.m as number, 1 - (r.m as number)],
  version: (r.v as string | null) ?? null,
});

export function predicciones(deporte: SportId): PrediccionEnVivo[] {
  switch (deporte) {
    case 'tennis':
      return leer(
        `SELECT prob1 AS p, market_prob1 AS m, CASE WHEN winner_id = p1_id THEN 0 ELSE 1 END AS y, model_version AS v
           FROM prediction_log WHERE resolved_at IS NOT NULL AND winner_id IS NOT NULL ORDER BY rowid`,
      ).map(dos);
    case 'football':
      return leer(
        `SELECT COALESCE(shown_home, prob_home) AS h, COALESCE(shown_draw, prob_draw) AS d, COALESCE(shown_away, prob_away) AS a,
                market_prob_home AS mh, market_prob_draw AS md, market_prob_away AS ma, home_goals AS g1, away_goals AS g2,
                model_version AS v
           FROM fb_prediction_log WHERE resolved_at IS NOT NULL AND home_goals IS NOT NULL ORDER BY rowid`,
      ).map((r) => {
        // Renormalizado: el log guarda cinco decimales y las tres pueden sumar 0,99999.
        const s = (r.h as number) + (r.d as number) + (r.a as number);
        const ms = r.mh != null && r.md != null && r.ma != null ? (r.mh as number) + (r.md as number) + (r.ma as number) : null;
        return {
          p: [(r.h as number) / s, (r.d as number) / s, (r.a as number) / s],
          y: (r.g1 as number) > (r.g2 as number) ? 0 : r.g1 === r.g2 ? 1 : 2,
          mercado: ms ? [(r.mh as number) / ms, (r.md as number) / ms, (r.ma as number) / ms] : null,
          version: (r.v as string | null) ?? null,
        };
      });
    case 'basketball':
      return leer(
        `SELECT prob_home AS p, market_prob_home AS m, CASE WHEN home_pts > away_pts THEN 0 ELSE 1 END AS y, model_version AS v
           FROM bb_prediction_log WHERE home_pts IS NOT NULL AND home_pts <> away_pts ORDER BY rowid`,
      ).map(dos);
    case 'baseball':
      return leer(
        `SELECT prob_home AS p, market_prob_home AS m, CASE WHEN home_runs > away_runs THEN 0 ELSE 1 END AS y, model_version AS v
           FROM bsb_prediction_log WHERE home_runs IS NOT NULL AND home_runs <> away_runs ORDER BY rowid`,
      ).map(dos);
    case 'nfl':
      // Los empates se excluyen: el moneyline se devuelve y no hay resultado que puntuar.
      return leer(
        `SELECT COALESCE(shown_home, prob_home) AS p, market_prob_home AS m, CASE WHEN home_points > away_points THEN 0 ELSE 1 END AS y,
                model_version AS v
           FROM naf_prediction_log WHERE home_points IS NOT NULL AND home_points <> away_points ORDER BY rowid`,
      ).map(dos);
  }
}

/** Las métricas de UNA versión del modelo, sobre sus propias predicciones. */
export interface PorVersion {
  /** null: predicciones anteriores al versionado, que no tienen versión y no se les inventa. */
  version: string | null;
  n: number;
  logLoss: number | null;
  brier: number | null;
  mercado: { n: number; logLoss: number; modeloLogLoss: number } | null;
}

/**
 * Parte las predicciones por la versión que las hizo, en el orden en que apareció cada una.
 * El total del deporte las junta todas; esto dice si la versión nueva lo hace mejor o peor
 * que la anterior, cosa que la cifra conjunta esconde en cuanto el modelo cambia.
 */
export function porVersion(deporte: string, xs: PrediccionEnVivo[]): PorVersion[] {
  const grupos = new Map<string | null, PrediccionEnVivo[]>();
  for (const x of xs) {
    const g = grupos.get(x.version);
    if (g) g.push(x);
    else grupos.set(x.version, [x]);
  }
  return [...grupos].map(([version, g]) => {
    const r = evaluate('live', deporte, g);
    return {
      version,
      n: r.n,
      logLoss: r.logLoss,
      brier: r.brier,
      mercado: r.mercado ? { n: r.mercado.n, logLoss: r.mercado.logLoss, modeloLogLoss: r.mercado.modeloLogLoss } : null,
    };
  });
}

export function evaluacionEnVivo(): (Informe & { error?: string; porVersion: PorVersion[] })[] {
  return SPORT_IDS.map((d) => {
    try {
      const xs = predicciones(d);
      return { ...evaluate('live', d, xs), porVersion: porVersion(d, xs) };
    } catch (e) {
      // Una fila mal formada no puede tumbar la evaluación de los otros cuatro, pero
      // tampoco se esconde: el deporte sale sin cifras y con el motivo.
      return { ...evaluate('live', d, []), porVersion: [], error: (e as Error).message };
    }
  });
}

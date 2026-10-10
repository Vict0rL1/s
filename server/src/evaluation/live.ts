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
import { avisoMuestra, type AvisoMuestra } from './sample.ts';

type Fila = Record<string, number | string | null>;

/** Una predicción en vivo, con la versión del modelo que la hizo (null: anterior al versionado). */
export type PrediccionEnVivo = Prediccion & {
  version: string | null;
  cuando: string | null;
  liga: string | null;
  /**
   * Lo que dijo el MODELO (prob_*), antes de calibrar y mezclar con el mercado. `p` es lo
   * publicado. La deriva se mide con esto, que es lo que midió el backtest (lote C, C4).
   */
  pModelo?: number[];
};

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
  pModelo: r.pm == null ? undefined : [r.pm as number, 1 - (r.pm as number)],
  y: r.y as number,
  mercado: r.m == null ? null : [r.m as number, 1 - (r.m as number)],
  version: (r.v as string | null) ?? null,
  cuando: (r.t as string | null) ?? null,
  liga: (r.l as string | null) ?? null,
});

export function predicciones(deporte: SportId): PrediccionEnVivo[] {
  switch (deporte) {
    case 'tennis':
      return leer(
        `SELECT prob1 AS p, prob1 AS pm, market_prob1 AS m, CASE WHEN winner_id = p1_id THEN 0 ELSE 1 END AS y, model_version AS v, commence_time AS t, tour AS l
           FROM prediction_log WHERE resolved_at IS NOT NULL AND winner_id IS NOT NULL ORDER BY rowid`,
      ).map(dos);
    case 'football':
      return leer(
        `SELECT COALESCE(shown_home, prob_home) AS h, COALESCE(shown_draw, prob_draw) AS d, COALESCE(shown_away, prob_away) AS a,
                prob_home AS mh0, prob_draw AS md0, prob_away AS ma0,
                market_prob_home AS mh, market_prob_draw AS md, market_prob_away AS ma, home_goals AS g1, away_goals AS g2,
                model_version AS v, commence_time AS t, league AS l
           FROM fb_prediction_log WHERE resolved_at IS NOT NULL AND home_goals IS NOT NULL ORDER BY rowid`,
      ).map((r) => {
        // Renormalizado: el log guarda cinco decimales y las tres pueden sumar 0,99999.
        const s = (r.h as number) + (r.d as number) + (r.a as number);
        const ms = r.mh != null && r.md != null && r.ma != null ? (r.mh as number) + (r.md as number) + (r.ma as number) : null;
        const s0 = (r.mh0 as number) + (r.md0 as number) + (r.ma0 as number);
        return {
          p: [(r.h as number) / s, (r.d as number) / s, (r.a as number) / s],
          pModelo: s0 > 0 ? [(r.mh0 as number) / s0, (r.md0 as number) / s0, (r.ma0 as number) / s0] : undefined,
          y: (r.g1 as number) > (r.g2 as number) ? 0 : r.g1 === r.g2 ? 1 : 2,
          mercado: ms ? [(r.mh as number) / ms, (r.md as number) / ms, (r.ma as number) / ms] : null,
          version: (r.v as string | null) ?? null,
          cuando: (r.t as string | null) ?? null,
          liga: (r.l as string | null) ?? null,
        };
      });
    case 'basketball':
      return leer(
        `SELECT prob_home AS p, prob_home AS pm, market_prob_home AS m, CASE WHEN home_pts > away_pts THEN 0 ELSE 1 END AS y, model_version AS v, commence_time AS t, league AS l
           FROM bb_prediction_log WHERE home_pts IS NOT NULL AND home_pts <> away_pts ORDER BY rowid`,
      ).map(dos);
    case 'baseball':
      return leer(
        `SELECT prob_home AS p, prob_home AS pm, market_prob_home AS m, CASE WHEN home_runs > away_runs THEN 0 ELSE 1 END AS y, model_version AS v, commence_time AS t, league AS l
           FROM bsb_prediction_log WHERE home_runs IS NOT NULL AND home_runs <> away_runs ORDER BY rowid`,
      ).map(dos);
    case 'nfl':
      // Los empates se excluyen: el moneyline se devuelve y no hay resultado que puntuar.
      return leer(
        `SELECT COALESCE(shown_home, prob_home) AS p, prob_home AS pm, market_prob_home AS m, CASE WHEN home_points > away_points THEN 0 ELSE 1 END AS y,
                model_version AS v, commence_time AS t, league AS l
           FROM naf_prediction_log WHERE home_points IS NOT NULL AND home_points <> away_points ORDER BY rowid`,
      ).map(dos);
    case 'nhl':
      // El moneyline incluye prórroga y tanda: siempre hay ganador.
      return leer(
        `SELECT COALESCE(shown_home, prob_home) AS p, prob_home AS pm, market_prob_home AS m, CASE WHEN home_goals > away_goals THEN 0 ELSE 1 END AS y,
                model_version AS v, commence_time AS t, league AS l
           FROM nhl_prediction_log WHERE home_goals IS NOT NULL AND home_goals <> away_goals ORDER BY rowid`,
      ).map(dos);
    case 'ufc':
      // Solo las peleas con ganador: el empate y el «sin resultado» no se puntúan (A es home_*).
      return leer(
        `SELECT COALESCE(shown_home, prob_home) AS p, prob_home AS pm, market_prob_home AS m, CASE WHEN outcome = 'A' THEN 0 ELSE 1 END AS y,
                model_version AS v, commence_time AS t, league AS l
           FROM ufc_prediction_log WHERE outcome IN ('A', 'B') ORDER BY rowid`,
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

export function evaluacionEnVivo(): (Informe & { error?: string; porVersion: PorVersion[]; aviso: AvisoMuestra })[] {
  return SPORT_IDS.map((d) => {
    try {
      const xs = predicciones(d);
      return { ...evaluate('live', d, xs), porVersion: porVersion(d, xs), aviso: avisoMuestra(xs.length, 'predicciones') };
    } catch (e) {
      // Una fila mal formada no puede tumbar la evaluación de los otros cuatro, pero
      // tampoco se esconde: el deporte sale sin cifras y con el motivo.
      return { ...evaluate('live', d, []), porVersion: [], aviso: avisoMuestra(0, 'predicciones'), error: (e as Error).message };
    }
  });
}

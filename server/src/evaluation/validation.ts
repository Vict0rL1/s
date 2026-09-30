// Validación estadística EN VIVO: cada cifra con su intervalo, y un veredicto que no
// promete más de lo que la muestra sostiene.
//
// Tres preguntas, que son el final de la cadena predicción → mercado → edge → paper
// trading → evaluación:
//
//   1. ¿Le gana el modelo al mercado?   log loss del modelo − el del mercado, partido a
//                                       partido, sobre los MISMOS partidos (emparejado).
//   2. ¿El edge detectado es real?       CLV de las señales con ventaja: si el mercado se
//                                       movió hacia el modelo después de la señal, el edge
//                                       estaba ahí, se apostara o no. Es la prueba con más
//                                       muestra y la que no depende de la suerte del resultado.
//   3. ¿El banco gana?                   retorno por apuesta liquidada. La más ruidosa: con
//                                       cuotas de 2,0, cien apuestas dan ±20 puntos de ROI.
//   4. ¿Rinde lo prometido?              retorno realizado menos la ventaja con que se apostó.
//                                       Negativo: el modelo sobrestima su ventaja.
//
// Intervalos por bootstrap (el emparejado del registro de experimentos: mismo generador,
// mismo número de remuestreos). Con menos de MIN_N datos no se calcula nada: se dice
// «muestra insuficiente» y cuántos harían falta, en vez de un intervalo que abarca todo
// y se lee como un resultado.

import { getDb } from '../db.ts';
import { pairedBootstrap } from '../experiments/registry.ts';
import { predicciones } from './live.ts';
import { SPORT_IDS } from '../sports.ts';

export const MIN_N = 30;

export type Veredicto = 'a favor' | 'en contra' | 'no concluyente' | 'muestra insuficiente';

export interface Prueba {
  pregunta: string;
  n: number;
  /** La media de lo que se mide (Δ log loss, CLV, retorno). */
  media: number | null;
  lo: number | null;
  hi: number | null;
  p: number | null;
  veredicto: Veredicto;
  /** Una frase que se puede leer sin saber estadística. */
  lectura: string;
  /** Cuántos datos harían falta para distinguir de cero una media como la actual. */
  necesarios: number | null;
}

/**
 * Prueba de media ≠ 0 por bootstrap. `mejorSiPositiva` fija qué signo es «a favor».
 */
export function probarMedia(
  xs: number[],
  pregunta: string,
  mejorSiPositiva: boolean,
  fmt: (m: number) => string,
): Prueba {
  const n = xs.length;
  if (n < MIN_N) {
    return {
      pregunta, n, media: n ? xs.reduce((a, b) => a + b, 0) / n : null, lo: null, hi: null, p: null,
      veredicto: 'muestra insuficiente',
      lectura: `${n} de al menos ${MIN_N} datos: todavía no se puede decir nada.`,
      necesarios: null,
    };
  }
  const ci = pairedBootstrap(new Array(n).fill(0), xs);
  const media = ci.mean;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - media) ** 2, 0) / (n - 1));
  const aFavor = mejorSiPositiva ? ci.lo > 0 : ci.hi < 0;
  const enContra = mejorSiPositiva ? ci.hi < 0 : ci.lo > 0;
  const veredicto: Veredicto = aFavor ? 'a favor' : enContra ? 'en contra' : 'no concluyente';
  // n para que un intervalo del 95 % no toque el cero con esta media y esta dispersión.
  const necesarios = media !== 0 ? Math.ceil(((1.96 * sd) / Math.abs(media)) ** 2) : null;
  return {
    pregunta, n, media, lo: ci.lo, hi: ci.hi, p: ci.p, veredicto,
    lectura:
      veredicto === 'no concluyente'
        ? `${fmt(media)}, pero el intervalo [${fmt(ci.lo)}, ${fmt(ci.hi)}] incluye el cero` +
          (necesarios && necesarios > n ? `: harían falta unos ${necesarios} datos para distinguirlo.` : '.')
        : // Con 4.000 remuestreos el p más pequeño que se puede expresar es ~0,0005: «p 0,000»
          // afirmaría una certeza que el método no puede dar.
          `${fmt(media)}, intervalo del 95 % [${fmt(ci.lo)}, ${fmt(ci.hi)}], ${ci.p < 0.001 ? 'p < 0,001' : `p ${ci.p.toFixed(3).replace('.', ',')}`}.`,
    necesarios,
  };
}

const pp = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;
const ll = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(4).replace('.', ',')}`;

export function validacionEnVivo(): {
  modeloVsMercado: Record<string, Prueba>;
  clvSenales: Prueba;
  clvApostadas: Prueba;
  clvRechazadas: Prueba;
  retornoBanco: Prueba;
  promesa: Prueba;
} {
  // 1. Modelo contra mercado, por deporte (cada deporte tiene su propio mercado).
  const modeloVsMercado: Record<string, Prueba> = {};
  for (const d of SPORT_IDS) {
    let diffs: number[] = [];
    try {
      diffs = predicciones(d)
        .filter((x) => x.mercado && x.mercado.length === x.p.length)
        .map((x) => -Math.log(Math.max(x.p[x.y], 1e-15)) + Math.log(Math.max((x.mercado as number[])[x.y], 1e-15)));
    } catch {
      diffs = [];
    }
    // Negativo = el modelo tiene MENOS log loss que el mercado = mejor.
    modeloVsMercado[d] = probarMedia(diffs, `¿${d}: el modelo le gana al mercado?`, false, ll);
  }

  // 2. CLV de las señales con ventaja positiva.
  const clv = (where: string) =>
    (getDb().prepare(`SELECT clv FROM edge_signals WHERE clv IS NOT NULL AND edge > 0 ${where}`).all() as { clv: number }[]).map((r) => r.clv);
  const clvSenales = probarMedia(clv(''), '¿El edge detectado le gana al cierre?', true, pp);
  const clvApostadas = probarMedia(clv("AND decision = 'apostada'"), '¿Las apuestas le ganan al cierre?', true, pp);
  const clvRechazadas = probarMedia(clv("AND decision = 'rechazada'"), '¿Las señales rechazadas le ganaban al cierre?', true, pp);

  // 3. Retorno por apuesta liquidada (ganada/perdida; los empates devueltos no informan).
  const ret = (getDb().prepare("SELECT profit, stake FROM paper_bets WHERE status IN ('won', 'lost')").all() as { profit: number; stake: number }[]).map(
    (r) => r.profit / r.stake,
  );
  const retornoBanco = probarMedia(ret, '¿El banco de papel gana?', true, pp);

  // 4. ¿Rinde lo que prometía? Cada apuesta se hizo con una ventaja (p·cuota − 1); si el
  //    modelo tiene razón, el retorno realizado menos esa ventaja es cero de media. Si es
  //    negativo con intervalo, el modelo sobrestima su ventaja justo donde apuesta: el
  //    fallo típico de un modelo demasiado seguro, porque las apuestas son los partidos
  //    donde más discrepa del mercado.
  const prom = (
    getDb()
      .prepare(
        `SELECT profit, stake, odds, edge, COALESCE(model_probability_calibrated, p_model) AS p
           FROM paper_bets WHERE status IN ('won', 'lost')`,
      )
      .all() as { profit: number; stake: number; odds: number; edge: number | null; p: number }[]
  ).map((r) => r.profit / r.stake - (r.edge ?? r.p * r.odds - 1));
  const promesa = probarMedia(prom, '¿Las apuestas rinden lo que el modelo prometía?', true, pp);

  return { modeloVsMercado, clvSenales, clvApostadas, clvRechazadas, retornoBanco, promesa };
}

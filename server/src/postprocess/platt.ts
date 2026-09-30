// Platt scaling: la versión paramétrica de lo mismo, con dos manos en vez de mil.
//
// ===========================================================================
// LA FORMA
// ===========================================================================
//     q_k  ∝  exp( a · log p_k  +  b_k )
//
// Con dos resultados esto es EXACTAMENTE el Platt de toda la vida:
//
//     logit(q) = a · logit(p) + c
//
// `a` es una temperatura: por debajo de 1 acerca todo al centro (el modelo era
// demasiado tajante), por encima de 1 lo separa. `b_k` corrige un sesgo por resultado —
// el clásico «el modelo se queda corto con los empates».
//
// ===========================================================================
// POR QUÉ ESTA VARIANTE Y NO UNA POR CLASE
// ===========================================================================
// Se podría dar una `a` distinta a cada resultado (vector scaling). Se usa UNA
// compartida a propósito: con tres resultados eso son 3 parámetros en vez de 6, y con
// unos miles de partidos la diferencia entre ajustar y sobreajustar es justo esa. Con
// `a` compartida, además, la transformación es monótona en las tres a la vez, así que no
// puede reordenar dos resultados del mismo partido — y reordenarlos es un cambio de
// pronóstico, no una calibración.
//
// `b_0` se fija en 0: sumar una constante a todos los `b` no cambia nada tras
// renormalizar, así que sin fijarlo el ajuste deriva sin cambiar de valor.

export interface Platt {
  a: number;
  /** Un sesgo por resultado. `b[0]` es siempre 0. */
  b: number[];
  n: number;
}

const LOG_FLOOR = -30;
const safeLog = (p: number): number => Math.max(LOG_FLOOR, Math.log(Math.max(p, 1e-12)));

/** q_k ∝ exp(a·log p_k + b_k), renormalizado. */
export function applyPlatt(pl: Platt, raw: number[]): number[] {
  const z = raw.map((p, k) => pl.a * safeLog(p) + (pl.b[k] ?? 0));
  const max = Math.max(...z);
  const e = z.map((v) => Math.exp(v - max));
  const sum = e.reduce((s, v) => s + v, 0);
  return sum > 0 ? e.map((v) => v / sum) : raw.map(() => 1 / raw.length);
}

/**
 * Ajuste por descenso de gradiente sobre la log-verosimilitud multinomial.
 *
 * El gradiente es el de siempre en un softmax: (q − y) por la entrada de cada parámetro.
 * Adam en vez de descenso plano porque `a` y los `b` viven en escalas muy distintas —
 * `a` ronda 1 y los `b` centésimas— y un solo paso de aprendizaje para los dos, o va
 * demasiado lento para uno o diverge para el otro.
 */
export function fitPlatt(
  samples: { p: number[]; outcome: number }[],
  iterations = 600,
): Platt | null {
  if (samples.length < 100) return null;
  const K = samples[0].p.length;
  let a = 1;
  const b = new Array<number>(K).fill(0);

  let ma = 0;
  let va = 0;
  const mb = new Array<number>(K).fill(0);
  const vb = new Array<number>(K).fill(0);
  const lr = 0.05;
  const B1 = 0.9;
  const B2 = 0.999;
  const EPS = 1e-8;

  for (let it = 1; it <= iterations; it++) {
    let ga = 0;
    const gb = new Array<number>(K).fill(0);
    for (const s of samples) {
      const logs = s.p.map(safeLog);
      const z = logs.map((l, k) => a * l + b[k]);
      const max = Math.max(...z);
      const e = z.map((v) => Math.exp(v - max));
      const sum = e.reduce((t, v) => t + v, 0);
      const q = e.map((v) => v / sum);
      for (let k = 0; k < K; k++) {
        const err = q[k] - (k === s.outcome ? 1 : 0);
        ga += err * logs[k];
        gb[k] += err;
      }
    }
    const n = samples.length;
    ga /= n;
    for (let k = 0; k < K; k++) gb[k] /= n;

    ma = B1 * ma + (1 - B1) * ga;
    va = B2 * va + (1 - B2) * ga * ga;
    a -= (lr * (ma / (1 - B1 ** it))) / (Math.sqrt(va / (1 - B2 ** it)) + EPS);
    for (let k = 1; k < K; k++) {
      mb[k] = B1 * mb[k] + (1 - B1) * gb[k];
      vb[k] = B2 * vb[k] + (1 - B2) * gb[k] * gb[k];
      b[k] -= (lr * (mb[k] / (1 - B1 ** it))) / (Math.sqrt(vb[k] / (1 - B2 ** it)) + EPS);
    }
    // `a` negativo daría la vuelta al modelo: diría que los partidos que puntúa alto
    // ocurren MENOS. Eso no es calibrar, es un ajuste que ha encontrado que el modelo
    // está del revés, y si eso pasara habría que arreglar el modelo, no taparlo aquí.
    if (a < 0.05) a = 0.05;
  }
  b[0] = 0;
  return { a, b, n: samples.length };
}

// Qué significa un número de Elo.
//
// ===========================================================================
// 1650 NO ES UNA RESPUESTA
// ===========================================================================
// Un Elo suelto no se puede interpretar. Nadie sabe si 1650 es mucho, y peor: la
// respuesta cambia por deporte y por liga, porque la escala depende de cuánta dispersión
// haya en la competición. En una liga plana, 100 puntos de diferencia son un abismo; en
// una con dos gigantes y dieciocho medianías, son ruido.
//
// Lo que SÍ se puede interpretar es la diferencia entre dos Elos, porque la fórmula la
// convierte en una probabilidad:
//
//     P(A gana a B) = 1 / (1 + 10^(-(EloA − EloB)/400))
//
// Esa es la definición del Elo, no una aproximación: el rating existe para producir ese
// número. Así que la tabla enseña «68 % contra un rival medio» al lado del 1650, y esa
// columna es la que se puede leer.
//
// El divisor 400 es el mismo en los cinco deportes de esta app —comprobado en
// football/model.ts, basketball/elo.ts, baseball/model.ts, nfl/model.ts y model/elo.ts—
// así que una sola conversión sirve para todos. Si algún día un deporte cambia de
// escala, esta función tiene que dejar de ser compartida, no ajustarse «a ojo».

/** P(gana) dado el margen de Elo. 0 de margen → 50 %. */
export function winProbability(eloDiff: number): number {
  return 1 / (1 + Math.pow(10, -eloDiff / 400));
}

/**
 * Cuánto Elo hace falta para una probabilidad dada. La inversa, para poder explicar
 * la escala en la propia interfaz («100 puntos ≈ 64 %»).
 */
export function eloForProbability(p: number): number {
  if (!(p > 0) || !(p < 1)) return 0;
  return -400 * Math.log10(1 / p - 1);
}

export interface EloSpread {
  best: number;
  worst: number;
  mean: number;
  median: number;
  /** Probabilidad de que el primero le gane al último. La competitividad, en una cifra. */
  topBeatsBottom: number;
}

/**
 * La forma de la competición, no solo su tabla.
 *
 * `topBeatsBottom` es lo que responde «¿está esto igualado?» sin tener que mirar
 * veinte filas: un 62 % es una liga apretada y un 95 % es una donde el orden está
 * decidido antes de empezar.
 */
export function spreadOf(elos: number[]): EloSpread | null {
  if (elos.length === 0) return null;
  const sorted = [...elos].sort((a, b) => a - b);
  const mean = elos.reduce((a, b) => a + b, 0) / elos.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const best = sorted[sorted.length - 1];
  const worst = sorted[0];
  return { best, worst, mean, median, topBeatsBottom: winProbability(best - worst) };
}

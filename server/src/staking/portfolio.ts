// Kelly a nivel de CARTERA: n apuestas a la vez, no n veces una apuesta.
//
// ===========================================================================
// POR QUÉ DIMENSIONAR UNA A UNA NO ES LO MISMO
// ===========================================================================
// Kelly maximiza el crecimiento logarítmico del BANCO, y el banco es uno solo. Con
// varias posiciones abiertas a la vez, lo que crece o encoge es
//
//     1 + Σ f_i · r_i
//
// y el logaritmo de esa suma no se separa en una suma de logaritmos. Dimensionar cada
// apuesta como si fuera la única y sumar los resultados es resolver un problema
// distinto del que se tiene.
//
// ===========================================================================
// LA APROXIMACIÓN, Y POR QUÉ ES HONESTA USARLA
// ===========================================================================
// El óptimo exacto necesita la distribución conjunta de los 2ⁿ resultados posibles.
// Con la aproximación cuadrática de log(1 + x) alrededor de 0:
//
//     E[log(1 + fᵀr)] ≈ fᵀμ − ½ fᵀΣf        →        f* = Σ⁻¹μ
//
// que es exactamente el problema de Markowitz. Es buena para f pequeña, y f pequeña es
// justo el régimen de esta app: Kelly de un cuarto con tope del 2 % por evento.
//
// PERO no da lo mismo que el Kelly exacto ni siquiera con una sola apuesta: el exacto es
// (p·b − q)/b y la aproximación (p·b − q)/(p·q·o²). Con cuota 2.00 coinciden casi
// exactamente; con cuota 6.00 la aproximación pide un 13 % menos.
//
// Por eso ESTE MÓDULO NO SUSTITUYE AL SIZING EXISTENTE. Devuelve un FACTOR:
//
//     factor_i = f_cartera,i / f_independiente,i
//
// con las dos calculadas bajo la MISMA aproximación, así que el error de aproximación
// se cancela en el cociente y lo que queda es únicamente el efecto de la correlación.
// Ese factor multiplica el tamaño que ya producía la política de siempre.
//
// ===========================================================================
// EL FACTOR NUNCA SUBE UN TAMAÑO
// ===========================================================================
// Con correlación negativa —«gana el local» y «ambos marcan» la tienen, medida— la
// solución de cartera pide apostar MÁS, porque las dos posiciones se cubren en parte.
// Se recorta a 1 igualmente.
//
// El motivo no es timidez: una estimación de correlación negativa es la menos fiable de
// todas y el premio por creérsela es pequeño, mientras que el castigo por equivocarse es
// apalancarse justo donde uno creía estar cubierto. Un módulo de riesgo que puede AUMENTAR
// una apuesta es una vía nueva de perder dinero, y no la hay.

import { correlationMatrix, type Position } from './correlation.ts';

export interface Candidate extends Position {
  /** Probabilidad del modelo. */
  p: number;
  /** Cuota decimal ofrecida. */
  odds: number;
}

export interface PortfolioResult {
  /** Factor por posición, en el mismo orden. Siempre en [0, 1]. */
  factors: number[];
  /** Las posiciones que la cartera deja en cero, por estar dominadas. */
  dropped: string[];
  explanation: string;
}

/**
 * Resuelve A·x = b por eliminación gaussiana con pivoteo parcial.
 *
 * El pivoteo no es opcional: sin él, un cero en la diagonal —que aparece en cuanto dos
 * posiciones son idénticas— divide por cero y devuelve NaN en silencio hasta la
 * pantalla.
 */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[best][col])) best = r;
    }
    if (Math.abs(M[best][col]) < 1e-12) return null;
    [M[col], M[best]] = [M[best], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/** Media y desviación típica del retorno por unidad apostada. */
function moments(p: number, odds: number): { mu: number; sigma: number } {
  const b = odds - 1;
  const q = 1 - p;
  return { mu: p * b - q, sigma: Math.sqrt(p * q) * odds };
}

/**
 * El factor de cartera para cada candidata.
 *
 * ===========================================================================
 * EL CONJUNTO ACTIVO
 * ===========================================================================
 * Σ⁻¹μ puede devolver componentes negativas: la solución sin restricciones dice
 * «ponte corto en esta». No se puede —el otro lado tiene su propio precio con su propio
 * margen— así que se pone a cero y se resuelve otra vez sobre las que quedan. Es el
 * método del conjunto activo, y termina siempre porque cada vuelta quita al menos una.
 *
 * Sin este bucle, un par muy correlacionado producía un factor NEGATIVO que, recortado
 * a cero, dejaba fuera una apuesta perfectamente buena en vez de encogerla.
 */
export function portfolioFactors(cands: Candidate[]): PortfolioResult {
  const n = cands.length;
  if (n === 0) return { factors: [], dropped: [], explanation: 'sin candidatas' };
  if (n === 1) {
    return {
      factors: [1],
      dropped: [],
      explanation: 'una sola posición: no hay cartera que optimizar',
    };
  }

  const m = cands.map((c) => moments(c.p, c.odds));
  const C = correlationMatrix(cands);

  // El óptimo independiente bajo la MISMA aproximación, que es el denominador del
  // factor. Usar aquí el Kelly exacto mezclaría dos aproximaciones distintas y el
  // cociente ya no aislaría el efecto de la correlación.
  const indep = m.map((x) => (x.sigma > 0 ? x.mu / (x.sigma * x.sigma) : 0));

  const active = cands.map((_, i) => indep[i] > 0);
  const dropped: string[] = [];
  let f: number[] = new Array<number>(n).fill(0);

  for (let pass = 0; pass < n + 1; pass++) {
    const idx = active.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) break;

    const k = idx.length;
    const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const rhs = new Array<number>(k).fill(0);
    for (let a = 0; a < k; a++) {
      rhs[a] = m[idx[a]].mu;
      for (let b = 0; b < k; b++) {
        A[a][b] = C[idx[a]][idx[b]] * m[idx[a]].sigma * m[idx[b]].sigma;
        // Cresta diminuta en la diagonal. La matriz construida par a par no tiene por
        // qué ser definida positiva —mezclar correlaciones medidas positivas y
        // negativas puede romperlo— y sin esto el sistema puede ser singular.
        if (a === b) A[a][b] *= 1 + 1e-6;
      }
    }

    const x = solve(A, rhs);
    if (!x) {
      // Sin solución numérica no se inventa una: se devuelve el sizing de siempre, que
      // es lo que había antes de este módulo y no es peor que un número inventado.
      return {
        factors: new Array<number>(n).fill(1),
        dropped: [],
        explanation:
          'el sistema de la cartera no se pudo resolver; se deja el tamaño por apuesta ' +
          'sin tocar, que es el comportamiento anterior a esta capa',
      };
    }

    let removed = false;
    f = new Array<number>(n).fill(0);
    for (let a = 0; a < k; a++) {
      if (x[a] <= 0) {
        active[idx[a]] = false;
        dropped.push(cands[idx[a]].key);
        removed = true;
      } else {
        f[idx[a]] = x[a];
      }
    }
    if (!removed) break;
  }

  const factors = cands.map((_, i) => {
    if (indep[i] <= 0) return 0;
    // Recortado a [0, 1]: la cartera solo puede encoger. Ver la cabecera.
    return Math.max(0, Math.min(1, f[i] / indep[i]));
  });

  const worst = factors.reduce((a, b) => Math.min(a, b), 1);
  const avg = factors.reduce((a, b) => a + b, 0) / n;
  return {
    factors,
    dropped,
    explanation:
      `${n} posiciones · factor medio ×${avg.toFixed(2)} · el más recortado ×${worst.toFixed(2)}` +
      (dropped.length > 0 ? ` · ${dropped.length} a cero por estar dominadas` : ''),
  };
}

// La capa COMÚN de evaluación: las mismas métricas, con la misma definición, para los
// cinco deportes y para cualquier origen (backtest o en vivo).
//
// ===========================================================================
// POR QUÉ EL ACIERTO NO ES LA MÉTRICA PRINCIPAL
// ===========================================================================
// El acierto solo mira si el favorito ganó. Un modelo que dice 51 % y uno que dice 90 %
// para el mismo favorito tienen el mismo acierto, y el segundo es mucho peor si el
// partido estaba igualado: con cuotas, apostar según el segundo arruina. Lo que importa
// para predecir —y para apostar— es si las PROBABILIDADES son buenas:
//
//   log loss   −media de log p(lo que pasó). Castiga sin piedad decir 95 % a algo que no
//              pasa. Es la métrica con la que se eligen los parámetros de todo el proyecto.
//   Brier      media del error cuadrático entre probabilidades y lo que pasó. Más suave con
//              los errores extremos; se lee bien: 0 perfecto, 0,25 decir siempre 50/50.
//   acierto    cuántas veces ganó el favorito. Se da, pero como dato secundario.
//   ECE        cuánto se desvía «cuando digo X %, pasa X %».
//
// Y ninguna significa nada sin una REFERENCIA: un log loss de 0,61 es bueno o malo según
// lo que diga el mercado sobre los mismos partidos. Por eso `evaluate` compara contra el
// mercado cuando hay su probabilidad, y siempre contra «no saber nada» (reparto uniforme).
//
// ===========================================================================
// DEFINICIONES (para que dos deportes midan lo mismo)
// ===========================================================================
// Cada predicción es un vector de probabilidades sobre K resultados excluyentes (K = 2
// en tenis, baloncesto, béisbol y NFL; K = 3 en fútbol) y el índice del que ocurrió.
//
//   Brier = media sobre partidos de  Σ_k (p_k − y_k)² / 2.
//           Para K = 2 es EXACTAMENTE el Brier binario clásico (p − y)², el que ya
//           publicaban los backtests. Dividir entre 2 siempre hace que el máximo sea 1 con
//           cualquier K (toda la probabilidad en un resultado que no pasó) y que decir 50/50
//           valga 0,25, como estamos acostumbrados.
//   Log loss = −media de ln(max(p_ocurrido, 1e−15)).
//   Acierto = proporción en que el resultado de mayor probabilidad fue el que ocurrió;
//             los empates de probabilidad cuentan medio.

export interface Prediccion {
  /** Probabilidades de los K resultados, en el mismo orden siempre. */
  p: number[];
  /** Índice del resultado que ocurrió. */
  y: number;
  /** Probabilidades del mercado sin margen, mismo orden, si se conocen. */
  mercado?: number[] | null;
}

const EPS = 1e-15;

function validar(x: Prediccion): void {
  if (!Number.isInteger(x.y) || x.y < 0 || x.y >= x.p.length) {
    throw new Error(`resultado fuera de rango: y=${x.y} con ${x.p.length} resultados`);
  }
  const s = x.p.reduce((a, b) => a + b, 0);
  if (!(Math.abs(s - 1) < 1e-3) || x.p.some((v) => !(v >= 0 && v <= 1))) {
    throw new Error(`probabilidades inválidas (suman ${s.toFixed(4)}): ${x.p.join(', ')}`);
  }
}

export function logLoss(xs: Prediccion[]): number {
  return xs.reduce((a, x) => a - Math.log(Math.max(x.p[x.y], EPS)), 0) / xs.length;
}

export function brier(xs: Prediccion[]): number {
  return xs.reduce((a, x) => a + x.p.reduce((s, pk, k) => s + (pk - (k === x.y ? 1 : 0)) ** 2, 0) / 2, 0) / xs.length;
}

export function accuracy(xs: Prediccion[]): number {
  let aciertos = 0;
  for (const x of xs) {
    const max = Math.max(...x.p);
    const top = x.p.map((v, i) => (v === max ? i : -1)).filter((i) => i >= 0);
    if (top.includes(x.y)) aciertos += 1 / top.length;
  }
  return aciertos / xs.length;
}

/**
 * ECE en cubetas fijas de 10 puntos, sobre CADA probabilidad dicha (todas las salidas de
 * cada partido): la misma definición que usan los estudios de calibración del proyecto.
 */
export function ece(xs: Prediccion[], cubetas = 10): number {
  const b = Array.from({ length: cubetas }, () => ({ n: 0, p: 0, y: 0 }));
  let total = 0;
  for (const x of xs) {
    x.p.forEach((pk, k) => {
      const i = Math.min(cubetas - 1, Math.floor(pk * cubetas));
      b[i].n++;
      b[i].p += pk;
      b[i].y += k === x.y ? 1 : 0;
      total++;
    });
  }
  return b.reduce((a, c) => (c.n ? a + (c.n / total) * Math.abs(c.p / c.n - c.y / c.n) : a), 0);
}

export interface Informe {
  /** De dónde salen los números. Nunca se mezclan: ver evaluation/live.ts. */
  origen: 'live' | 'backtest';
  deporte: string;
  n: number;
  logLoss: number | null;
  brier: number | null;
  accuracy: number | null;
  ece: number | null;
  /** Lo mismo con las probabilidades del mercado, sobre los partidos que las tienen. */
  mercado: { n: number; logLoss: number; brier: number; accuracy: number; modeloLogLoss: number; modeloBrier: number } | null;
  /** Log loss de no saber nada: ln K. Lo mínimo que hay que batir. */
  logLossUniforme: number | null;
  /** Brier de no saber nada: (K − 1) / 2K. 0,25 con dos resultados, 1/3 con tres. */
  brierUniforme: number | null;
}

/** Todas las métricas de un conjunto de predicciones. Vacío → nulos, no ceros. */
export function evaluate(origen: Informe['origen'], deporte: string, xs: Prediccion[]): Informe {
  for (const x of xs) validar(x);
  if (xs.length === 0) {
    return { origen, deporte, n: 0, logLoss: null, brier: null, accuracy: null, ece: null, mercado: null, logLossUniforme: null, brierUniforme: null };
  }
  const conMercado = xs.filter((x) => x.mercado && x.mercado.length === x.p.length);
  const comoMercado = conMercado.map((x) => ({ p: x.mercado as number[], y: x.y }));
  return {
    origen,
    deporte,
    n: xs.length,
    logLoss: logLoss(xs),
    brier: brier(xs),
    accuracy: accuracy(xs),
    ece: ece(xs),
    mercado: conMercado.length
      ? {
          n: conMercado.length,
          logLoss: logLoss(comoMercado),
          brier: brier(comoMercado),
          accuracy: accuracy(comoMercado),
          modeloLogLoss: logLoss(conMercado),
          modeloBrier: brier(conMercado),
        }
      : null,
    logLossUniforme: Math.log(xs[0].p.length),
    brierUniforme: (xs[0].p.length - 1) / (2 * xs[0].p.length),
  };
}

// Las dos mitades, cada una con su propio modelo.
//
// ===========================================================================
// QUÉ HABÍA ANTES Y POR QUÉ NO SE PUBLICABA
// ===========================================================================
// El marcador al descanso lleva ingerido desde el principio y model.ts tenía un modelo
// de mitades escrito, medido y DELIBERADAMENTE apagado, con el motivo escrito al lado:
// tomaba la λ del partido entero y la multiplicaba por la cuota de goles de la primera
// parte (0,4461). Los números de aquel modelo, sobre la temporada de validación:
//
//     descanso X                −4,19 pp
//     descanso +0,5 goles       +4,00 pp
//     el visitante gana una mitad   +8,35 pp
//
// Y el diagnóstico que dejó escrito era correcto y concreto: «la media es correcta por
// construcción; la FAMILIA de la distribución es la equivocada. Arreglarlo necesita una
// distribución de goles de media parte ajustada a esa forma, no la del partido entero
// reescalada — que es un trabajo de verdad y no una constante».
//
// Esto es ese trabajo. Son tres cambios, y cada uno se midió por separado:
//
//   1. UN DIXON-COLES PROPIO POR MITAD. En vez de reescalar el del partido, se ajusta
//      uno sobre los goles de la primera parte y otro sobre los de la segunda. Cada uno
//      saca su ataque, su defensa, su ventaja de campo y su ρ. No es lo mismo: un equipo
//      que sale fuerte y se apaga no se describe con un único par de números.
//
//   2. COM-POISSON EN VEZ DE POISSON. Una mitad está INFRAdispersa (ν = 1,30 ajustada
//      sobre entrenamiento): menos ceros y más unos de los que admite una Poisson con la
//      misma media. Ver markets/comPoisson.ts para la medición.
//
//   3. ρ AJUSTADA, Y SALE POSITIVA. En el partido entero ρ es negativa (más 0-0 de lo
//      que dice la independencia). En una mitad sale POSITIVA en casi todas las ligas
//      (+0,014 a +0,117). Tiene sentido y no es un error de signo: lo que sobra en una
//      mitad respecto a la independencia no son los 0-0, son los 1-1.
//
// ===========================================================================
// LO QUE MIDE AHORA, Y POR QUÉ SÍ SE PUBLICA
// ===========================================================================
// Sobre 3.634 partidos de la temporada de validación, que el ajuste no vio
// (`npm run study:thin`, que reproduce las dos columnas sobre los MISMOS partidos):
//
//     mercado                        antes      ahora
//     descanso 1                     +3,81      +1,67
//     descanso X                     −5,00      −1,72
//     descanso 2                     +1,19      +0,05
//     descanso +0,5 goles            +4,87      +2,26
//     descanso +1,5 goles            −1,75      +1,01
//     el local gana una mitad        +6,70      +3,23
//     el visitante gana una mitad    +4,67      +1,78
//
// El peor mercado pasa de 6,70 pp a 3,23, y CINCO de los siete mejoran. (El «antes» de
// esta tabla no es el de la nota vieja de model.ts, que llegaba a 8,35 pp: allí las λ
// venían del Elo y aquí del Dixon-Coles, así que la comparación de arriba es contra el
// mejor «antes» posible y no contra el peor.)
//
// Eso ya no es «un modelo que no se le puede enseñar a nadie», pero TAMPOCO es el partido
// entero, que está dentro de 1,5 pp en todo lo que publica. Así que se publica con su
// error medido al lado, mercado por mercado (`HALF_CALIBRATION`), en vez de esconderlo o
// de fingir que es igual de bueno.
//
// ===========================================================================
// LO QUE **NO** MEJORA, Y HAY QUE DECIRLO
// ===========================================================================
// El log loss del 1X2 al descanso NO se mueve: 1,06780 antes y 1,06693 ahora, una
// diferencia de −0,00088 con IC 95 % [−0,00509, +0,00321] y p = 0,67. Indistinguible.
//
// No es una contradicción con la tabla de arriba, es la diferencia entre dos cosas que se
// confunden a menudo:
//
//   · DISCRIMINAR — separar los partidos que acaban 1 de los que acaban X. Eso es lo que
//     domina el log loss, y este modelo no discrimina mejor que el anterior.
//   · CALIBRAR — que cuando dice 73 % pase el 73 % y no el 76 %. Eso es lo que ha
//     mejorado, y el log loss casi no lo penaliza a estas magnitudes.
//
// Para estos mercados la que importa es la segunda, porque el sesgo es contra lo que se
// apuesta: una línea a la que el modelo le da un 73 % cuando la verdad es un 76 % está
// mal en 3 puntos SIEMPRE, en la misma dirección, y eso se paga en cada apuesta. Un
// modelo que no discrimina mejor pero deja de estar sistemáticamente corto es
// exactamente la mejora que estos mercados necesitaban — y no la que un log loss
// enseñaría.

import {
  fitDixonColes,
  expectedGoalsDc,
  type DcMatch,
  type DcParams,
} from './bayes/dixonColes.ts';
import { comPoissonForMean, comPoissonPmf } from '../markets/comPoisson.ts';
import { dixonColesTau } from './model.ts';

/**
 * Dispersión de los goles de un equipo en una mitad, ajustada por máxima verosimilitud
 * sobre 40.324 muestras equipo-mitad de las temporadas de ENTRENAMIENTO (`study:thin`).
 *
 * 1,30 y no 1: por encima de 1 significa INFRAdispersa. La rejilla probada va de 0,6 a
 * 2,2 y el máximo cae claramente dentro, no en un borde. La log-verosimilitud es
 * −40.698,7 contra −40.809,0 de la Poisson.
 *
 * Una medición anterior, hecha a mano, daba 1,20 — porque tomaba la λ del partido
 * entero multiplicada por la cuota de goles de la primera parte en vez de la λ del
 * ajuste de la mitad. Ese es justo el error que este módulo existe para no cometer, así
 * que el número que se publica es el del script, no el de la exploración.
 */
export const HALF_NU = 1.3;

/** Hasta cuántos goles por equipo llega la rejilla de una mitad. De sobra. */
const MAX_HALF_GOALS = 8;

/**
 * El error de calibración MEDIDO de cada mercado, en puntos porcentuales.
 *
 * Positivo = la realidad ocurre más de lo que el modelo dice. Va en la respuesta de la
 * API para que la tarjeta lo pueda enseñar: publicar un 73 % que se sabe que se queda
 * 2,7 pp corto, sin decirlo, es peor que no publicarlo.
 */
export const HALF_CALIBRATION: Record<string, number> = {
  'descanso-1': 1.67,
  'descanso-X': -1.72,
  'descanso-2': 0.05,
  'descanso-over-0.5': 2.26,
  'descanso-over-1.5': 1.01,
  'local-gana-una-mitad': 3.23,
  'visitante-gana-una-mitad': 1.78,
};

/** Sobre cuántos partidos se midió lo de arriba. */
export const HALF_CALIBRATION_N = 3634;

export interface HalfParams {
  first: DcParams;
  second: DcParams;
}

/**
 * Ajustar los dos modelos de una liga.
 *
 * La segunda parte se ajusta sobre goles = final − descanso, que es una resta y no una
 * estimación: los dos números están en la base.
 */
export function fitHalves(
  rows: { date: string; homeId: string; awayId: string; hh: number; ha: number; fh: number; fa: number }[],
  hyper: Parameters<typeof fitDixonColes>[2],
): HalfParams | null {
  if (rows.length < 300) return null;
  const asOf = rows[rows.length - 1].date;
  const first: DcMatch[] = rows.map((r) => ({
    date: r.date,
    homeId: r.homeId,
    awayId: r.awayId,
    homeGoals: r.hh,
    awayGoals: r.ha,
  }));
  const second: DcMatch[] = rows.map((r) => ({
    date: r.date,
    homeId: r.homeId,
    awayId: r.awayId,
    homeGoals: r.fh - r.hh,
    awayGoals: r.fa - r.ha,
  }));
  const a = fitDixonColes(first, asOf, hyper);
  const b = fitDixonColes(second, asOf, hyper);
  return a && b ? { first: a, second: b } : null;
}

/** La rejilla de una mitad: marginales COM-Poisson acopladas por τ. */
export function halfGrid(lambdaHome: number, lambdaAway: number, rho: number): number[][] {
  const ph = comPoissonPmf(comPoissonForMean(lambdaHome, HALF_NU), MAX_HALF_GOALS);
  const pa = comPoissonPmf(comPoissonForMean(lambdaAway, HALF_NU), MAX_HALF_GOALS);
  const grid: number[][] = [];
  let z = 0;
  for (let i = 0; i <= MAX_HALF_GOALS; i++) {
    grid[i] = [];
    for (let j = 0; j <= MAX_HALF_GOALS; j++) {
      // τ se definió para marginales Poisson. Aplicarla a las COM-Poisson es una
      // extensión: corrige las mismas cuatro casillas por la misma razón, y la
      // renormalización de después garantiza que sigue siendo una distribución. Lo que
      // la justifica no es la teoría, es que ρ se ajusta CON esta forma puesta, así que
      // el número que sale ya la tiene en cuenta.
      const v = Math.max(0, ph[i] * pa[j] * dixonColesTau(i, j, lambdaHome, lambdaAway, rho));
      grid[i][j] = v;
      z += v;
    }
  }
  for (let i = 0; i <= MAX_HALF_GOALS; i++) {
    for (let j = 0; j <= MAX_HALF_GOALS; j++) grid[i][j] /= z;
  }
  return grid;
}

export interface HalfMarkets {
  /** 1X2 al descanso. */
  htHome: number;
  htDraw: number;
  htAway: number;
  /** Más de 0,5 y 1,5 goles al descanso. */
  htOver05: number;
  htOver15: number;
  /** Gana AL MENOS una de las dos mitades. Las dos pueden pasar a la vez. */
  homeWinsAHalf: number;
  awayWinsAHalf: number;
  /** Marca en las dos mitades. */
  homeScoresBoth: number;
  awayScoresBoth: number;
  /** Descanso/final: la matriz 3×3, en el orden 1/X/2 × 1/X/2. */
  htFt: number[][];
  /** Goles esperados en cada mitad. */
  expected: { first: number; second: number };
}

export function halfMarkets(p: HalfParams, homeId: string, awayId: string): HalfMarkets | null {
  if (!p.first.attack.has(homeId) || !p.first.attack.has(awayId)) return null;
  if (!p.second.attack.has(homeId) || !p.second.attack.has(awayId)) return null;
  const g1 = expectedGoalsDc(p.first, homeId, awayId);
  const g2 = expectedGoalsDc(p.second, homeId, awayId);
  const A = halfGrid(g1.home, g1.away, p.first.rho);
  const B = halfGrid(g2.home, g2.away, p.second.rho);

  let htHome = 0;
  let htDraw = 0;
  let htAway = 0;
  let htOver05 = 0;
  let htOver15 = 0;
  for (let i = 0; i <= MAX_HALF_GOALS; i++) {
    for (let j = 0; j <= MAX_HALF_GOALS; j++) {
      const v = A[i][j];
      if (i > j) htHome += v;
      else if (i === j) htDraw += v;
      else htAway += v;
      if (i + j >= 1) htOver05 += v;
      if (i + j >= 2) htOver15 += v;
    }
  }

  // Los mercados que cruzan las dos mitades necesitan la conjunta de las cuatro cifras.
  // Se recorre entera en vez de buscar un atajo: son 9^4 = 6.561 términos, que a esta
  // escala es gratis, y cualquier atajo aquí es una oportunidad de equivocarse en un
  // caso raro que nadie volvería a mirar.
  let homeWinsAHalf = 0;
  let awayWinsAHalf = 0;
  let homeScoresBoth = 0;
  let awayScoresBoth = 0;
  const htFt = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i <= MAX_HALF_GOALS; i++) {
    for (let j = 0; j <= MAX_HALF_GOALS; j++) {
      if (A[i][j] < 1e-12) continue;
      const htIdx = i > j ? 0 : i === j ? 1 : 2;
      for (let k = 0; k <= MAX_HALF_GOALS; k++) {
        for (let l = 0; l <= MAX_HALF_GOALS; l++) {
          const v = A[i][j] * B[k][l];
          if (v < 1e-15) continue;
          if (i > j || k > l) homeWinsAHalf += v;
          if (j > i || l > k) awayWinsAHalf += v;
          if (i >= 1 && k >= 1) homeScoresBoth += v;
          if (j >= 1 && l >= 1) awayScoresBoth += v;
          const fh = i + k;
          const fa = j + l;
          htFt[htIdx][fh > fa ? 0 : fh === fa ? 1 : 2] += v;
        }
      }
    }
  }

  return {
    htHome,
    htDraw,
    htAway,
    htOver05,
    htOver15,
    homeWinsAHalf,
    awayWinsAHalf,
    homeScoresBoth,
    awayScoresBoth,
    htFt,
    expected: { first: g1.home + g1.away, second: g2.home + g2.away },
  };
}

// De qué sale la `p` de la cadena: saque de uno contra resto del otro.
//
// ===========================================================================
// LA CADENA NECESITA UN NÚMERO QUE NADIE PUBLICA
// ===========================================================================
// `markov.ts` pide P(el sacador gana el punto) para cada jugador. Eso no es una
// estadística de nadie: es una propiedad del ENFRENTAMIENTO. El 68 % de puntos al saque
// de un jugador se midió contra los restadores que le tocaron, y contra un restador
// excepcional será menos.
//
// El modelo aditivo estándar, y el que se usa aquí:
//
//     p(A saca contra B) = s_A − r_B + (1 − μ)
//
// donde s_A es la tasa de A al saque, r_B la de B al resto y μ la media del circuito.
// Con los dos en la media da exactamente μ, que es la comprobación de cordura de la
// fórmula: s_A = μ y r_B = 1 − μ → p = μ − (1−μ) + (1−μ) = μ.
//
// ===========================================================================
// LO MEDIDO, EN ESTE ARCHIVO
// ===========================================================================
// `npm run study:live` lo recalcula y lo publica. Sobre 58.732 actuaciones al saque de
// la ATP:
//
//   μ (media del circuito)                      0.6369
//   dispersión ENTRE jugadores (185 con 100+)   SD 0.0267
//
// Ese 0.0267 tiene una consecuencia que conviene tener delante: la diferencia entre un
// gran sacador y uno mediocre es de unos 3 puntos porcentuales por punto. Parece poco y
// no lo es — la cadena lo amplifica, porque un juego son 4 puntos y un set son 10 juegos.

import { getDb } from '../db.ts';
import type { TourId } from '../types.ts';

/**
 * Media del circuito de P(punto ganado al saque).
 *
 * Se guarda como constante Y se recalcula: la constante es el valor por defecto cuando
 * la base no tiene datos suficientes, y el cálculo manda cuando sí los tiene. Un valor
 * fijo se queda viejo; uno solo calculado se rompe con una base recién creada.
 */
export const TOUR_BASELINE: Record<string, number> = {
  atp: 0.6369,
  wta: 0.6058,
};

export interface ServeReturn {
  /** Puntos ganados al saque / puntos servidos. */
  serve: number;
  /** Puntos ganados al resto / puntos servidos por el rival. */
  ret: number;
  /** Puntos servidos que respaldan `serve`. */
  servePoints: number;
  /** Puntos restados que respaldan `ret`. */
  returnPoints: number;
  /** Partidos con datos de saque. */
  matches: number;
}

/**
 * Saque y resto de un jugador, con el número de puntos que los respaldan.
 *
 * Los puntos van en la salida y no son un detalle: una tasa de saque sobre 80 puntos y
 * otra sobre 8.000 se imprimen igual y valen cosas distintas, y quien las use tiene que
 * poder encogerlas hacia la media del circuito.
 */
export function serveReturnOf(tour: TourId, id: number, surface?: string | null): ServeReturn {
  const surfClause = surface ? 'AND surface = ?' : '';
  // Los parámetros se arman por mitades (una por rama del UNION) porque la superficie,
  // cuando se filtra, aparece dos veces en la consulta.
  const half = (a: (string | number)[]): (string | number)[] =>
    surface ? [...a, surface] : a;
  const db = getDb();

  const own = db
    .prepare(
      `SELECT COUNT(*) AS m, COALESCE(SUM(svpt),0) AS svpt, COALESCE(SUM(won),0) AS won
       FROM (
         SELECT w_svpt svpt, w_1stWon + w_2ndWon won FROM matches
           WHERE tour = ? AND winner_id = ? AND w_svpt IS NOT NULL ${surfClause}
         UNION ALL
         SELECT l_svpt, l_1stWon + l_2ndWon FROM matches
           WHERE tour = ? AND loser_id = ? AND l_svpt IS NOT NULL ${surfClause}
       )`,
    )
    .get(...half([tour, id]), ...half([tour, id])) as unknown as {
    m: number;
    svpt: number;
    won: number;
  };

  // El resto es el complemento de lo que hizo el RIVAL al saque.
  const opp = db
    .prepare(
      `SELECT COALESCE(SUM(svpt),0) AS svpt, COALESCE(SUM(won),0) AS won
       FROM (
         SELECT l_svpt svpt, l_1stWon + l_2ndWon won FROM matches
           WHERE tour = ? AND winner_id = ? AND l_svpt IS NOT NULL ${surfClause}
         UNION ALL
         SELECT w_svpt, w_1stWon + w_2ndWon FROM matches
           WHERE tour = ? AND loser_id = ? AND w_svpt IS NOT NULL ${surfClause}
       )`,
    )
    .get(...half([tour, id]), ...half([tour, id])) as unknown as {
    svpt: number;
    won: number;
  };

  const base = TOUR_BASELINE[tour] ?? 0.63;
  return {
    serve: own.svpt > 0 ? own.won / own.svpt : base,
    ret: opp.svpt > 0 ? (opp.svpt - opp.won) / opp.svpt : 1 - base,
    servePoints: own.svpt,
    returnPoints: opp.svpt,
    matches: own.m,
  };
}

/**
 * Cuántos puntos vale el prior del circuito al estimar el saque de un jugador.
 *
 * Distinto de la κ de `bayes.ts`, y no hay que confundirlos: esa dice cuánto pesa lo que
 * está pasando EN ESTE PARTIDO frente a la carrera del jugador. Esta dice cuánto pesa la
 * carrera del jugador frente a la media del CIRCUITO, y es mucho más pequeña en efecto
 * porque unos cientos de puntos ya identifican bastante bien a un sacador.
 *
 * 200 puntos son unos tres partidos: por debajo de eso, un jugador nuevo se parece más a
 * la media del circuito que a su propia muestra.
 */
export const CAREER_PRIOR_POINTS = 200;

export interface MatchupServe {
  /** P(el jugador 1 gana un punto con su saque) contra ESTE rival. */
  p1: number;
  /** P(el jugador 2 gana un punto con su saque) contra ESTE rival. */
  p2: number;
  baseline: number;
  detail: {
    serve1: number;
    return1: number;
    serve2: number;
    return2: number;
    /** Si alguno tiene tan pocos datos que su número es casi el del circuito. */
    thin1: boolean;
    thin2: boolean;
    /**
     * Si de algún jugador no hay NINGÚN dato de saque.
     *
     * Distinto de `thin`, y la diferencia importa: «pocos datos» devuelve un número
     * encogido hacia el circuito y sigue siendo una estimación de ESE jugador; «ningún
     * dato» devuelve la media del circuito y ya está. Sin distinguirlos, un id
     * equivocado produce exactamente 0.6369 para los dos y una probabilidad de partido
     * perfectamente creíble — pasó al probar el endpoint con ids inventados.
     */
    unknown1: boolean;
    unknown2: boolean;
  };
}

/**
 * Las dos `p` del enfrentamiento, encogidas hacia el circuito según los datos que haya.
 *
 * El recorte final a [0.35, 0.90] no es cosmético: la fórmula aditiva puede salirse del
 * rango con dos extremos —un sacador del percentil 99 contra un restador del percentil 1
 * sobre muestras pequeñas— y una `p` de 0.94 metida en la cadena produce un 99,8 % de
 * ganar un juego, que no le pasa a nadie. El recorte dice donde acaba lo que este modelo
 * puede afirmar.
 */
export function matchupServe(
  tour: TourId,
  id1: number,
  id2: number,
  surface?: string | null,
): MatchupServe {
  const base = TOUR_BASELINE[tour] ?? 0.63;
  const a = serveReturnOf(tour, id1, surface);
  const b = serveReturnOf(tour, id2, surface);

  const shrink = (value: number, points: number, prior: number): number =>
    (value * points + prior * CAREER_PRIOR_POINTS) / (points + CAREER_PRIOR_POINTS);

  const s1 = shrink(a.serve, a.servePoints, base);
  const r1 = shrink(a.ret, a.returnPoints, 1 - base);
  const s2 = shrink(b.serve, b.servePoints, base);
  const r2 = shrink(b.ret, b.returnPoints, 1 - base);

  const clamp = (x: number): number => Math.min(0.9, Math.max(0.35, x));
  return {
    p1: clamp(s1 - r2 + (1 - base)),
    p2: clamp(s2 - r1 + (1 - base)),
    baseline: base,
    detail: {
      serve1: s1,
      return1: r1,
      serve2: s2,
      return2: r2,
      thin1: a.servePoints < CAREER_PRIOR_POINTS,
      thin2: b.servePoints < CAREER_PRIOR_POINTS,
      unknown1: a.servePoints === 0,
      unknown2: b.servePoints === 0,
    },
  };
}

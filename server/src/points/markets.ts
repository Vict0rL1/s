// Todos los mercados del MISMO modelo de puntos. Ninguno estimado por separado.
//
// ===========================================================================
// LA REGLA QUE ORGANIZA ESTE FICHERO
// ===========================================================================
// Hay exactamente dos números de entrada: p1 y p2, las probabilidades de ganar un punto
// al saque de cada jugador. Todo lo demás —partido, set, hándicap de juegos, total de
// juegos, marcador exacto— sale de propagarlos por la cadena. No hay un modelo de
// totales, ni uno de hándicaps, ni un ajuste que solo aplique a un mercado.
//
// Eso no es limpieza: es la única forma de que los mercados no se contradigan. Con
// modelos separados es perfectamente posible publicar un 70 % de ganar el partido y un
// total de juegos que implique un 60 %, y nadie se entera hasta que alguien suma.
//
// ===========================================================================
// LO QUE HACE FALTA Y LA CADENA DE `live/markov.ts` NO DABA
// ===========================================================================
// Esa cadena devuelve PROBABILIDADES DE GANAR. Para un hándicap de juegos o un total
// hace falta la DISTRIBUCIÓN CONJUNTA de juegos: cuántos gana cada uno, no solo quién
// gana. Así que aquí se enumera el set entero — todos los marcadores finales con su
// probabilidad — y de ahí sale todo lo demás por convolución.
//
// El espacio es diminuto: un set acaba en uno de 13 marcadores posibles, y un partido al
// mejor de 5 en secuencias de hasta 5 de ellos. Se puede enumerar exacto sin simular.

import { gameProb, tiebreakProb } from '../live/markov.ts';

export interface SetRules {
  /** Si el set se decide con tiebreak a 6-6. */
  tiebreak: boolean;
  /** Puntos del tiebreak. */
  tiebreakTo: number;
}

export const STANDARD_SET: SetRules = { tiebreak: true, tiebreakTo: 7 };

/** Un marcador final de set con su probabilidad. */
export interface SetScore {
  g1: number;
  g2: number;
  probability: number;
  /** Si acabó en tiebreak. Cuenta como un juego más en el total. */
  tiebreak: boolean;
}

/**
 * Todos los marcadores finales de un set, con su probabilidad.
 *
 * ===========================================================================
 * POR QUÉ ITERACIÓN Y NO RECURSIÓN
 * ===========================================================================
 * Se propaga la masa hacia adelante por número de juegos jugados. Con recursión hacia
 * atrás habría que memoizar por (g1, g2, servidor) y el orden de resolución es el mismo;
 * hacia adelante sale más corto y la masa total se puede comprobar en cada paso, que es
 * lo que caza un caso terminal olvidado.
 *
 * @param firstServer quién saca el PRIMER juego del set
 */
export function setScoreDistribution(
  p1: number,
  p2: number,
  firstServer: 1 | 2 = 1,
  rules: SetRules = STANDARD_SET,
): SetScore[] {
  const hold1 = gameProb(p1);
  const hold2 = gameProb(p2);
  const out: SetScore[] = [];

  // Estado activo: clave "g1|g2" → probabilidad. El servidor sale de la paridad.
  let live = new Map<string, number>([['0|0', 1]]);

  for (let played = 0; played < 13 && live.size > 0; played++) {
    const next = new Map<string, number>();
    for (const [k, prob] of live) {
      const [g1, g2] = k.split('|').map(Number);
      // Quien saca: alterna desde el primero según los juegos jugados.
      const server: 1 | 2 = (g1 + g2) % 2 === 0 ? firstServer : firstServer === 1 ? 2 : 1;

      if (rules.tiebreak && g1 === 6 && g2 === 6) {
        // El tiebreak lo abre quien tocaba sacar.
        const tb = tiebreakProb(p1, p2, 0, 0, server, rules.tiebreakTo);
        out.push({ g1: 7, g2: 6, probability: prob * tb, tiebreak: true });
        out.push({ g1: 6, g2: 7, probability: prob * (1 - tb), tiebreak: true });
        continue;
      }

      const p1WinsGame = server === 1 ? hold1 : 1 - hold2;
      for (const [winner, pw] of [
        [1, p1WinsGame],
        [2, 1 - p1WinsGame],
      ] as [1 | 2, number][]) {
        if (pw <= 0) continue;
        const n1 = g1 + (winner === 1 ? 1 : 0);
        const n2 = g2 + (winner === 2 ? 1 : 0);
        const done =
          (n1 >= 6 && n1 - n2 >= 2) ||
          (n2 >= 6 && n2 - n1 >= 2) ||
          (rules.tiebreak && (n1 === 7 || n2 === 7));
        if (done) {
          out.push({ g1: n1, g2: n2, probability: prob * pw, tiebreak: false });
        } else {
          const nk = `${n1}|${n2}`;
          next.set(nk, (next.get(nk) ?? 0) + prob * pw);
        }
      }
    }
    live = next;
  }

  // Un set sin tiebreak puede seguir indefinidamente. La masa que queda viva se reparte
  // entre los dos marcadores de «set largo» con la probabilidad de llevárselo desde un
  // empate, que es exacta. Se etiqueta 8-6/6-8 porque el número de juegos ya no está
  // acotado y hay que decir algo: es la única aproximación de este fichero y está aquí.
  if (live.size > 0) {
    const win2 = hold1 * (1 - hold2);
    const lose2 = (1 - hold1) * hold2;
    const tied = win2 + lose2 > 0 ? win2 / (win2 + lose2) : 0.5;
    let rest = 0;
    for (const v of live.values()) rest += v;
    if (rest > 0) {
      out.push({ g1: 8, g2: 6, probability: rest * tied, tiebreak: false });
      out.push({ g1: 6, g2: 8, probability: rest * (1 - tied), tiebreak: false });
    }
  }

  return out.filter((s) => s.probability > 1e-12);
}

export interface MatchRules {
  bestOf: 3 | 5;
  /** Reglas de los sets normales. */
  set: SetRules;
  /**
   * Reglas del SET DECISIVO, que cambian por torneo.
   *
   * En 2026 los cuatro Grand Slams usan tiebreak a 10 en el set final; antes cada uno
   * tenía su regla y Wimbledon y Roland Garros jugaban sets largos. Un modelo que
   * suponga «tiebreak a 7 siempre» se equivoca justo en los partidos más largos, que son
   * los que más mueven un mercado de total de juegos.
   */
  decidingSet: SetRules;
}

export const DEFAULT_MATCH: MatchRules = {
  bestOf: 3,
  set: STANDARD_SET,
  decidingSet: STANDARD_SET,
};

export interface MatchDistribution {
  /** P(gana el jugador 1). */
  matchProb: number;
  /** P(el jugador 1 gana un set cualquiera), promediada sobre el orden de saque. */
  setProb: number;
  /** Marcador en sets → probabilidad, por ejemplo "2-1". */
  setScores: { label: string; side: 1 | 2; probability: number }[];
  /** Distribución del total de juegos del partido. */
  totalGames: { games: number; probability: number }[];
  /** Distribución de la diferencia de juegos (jugador 1 menos jugador 2). */
  gameMargin: { margin: number; probability: number }[];
  /** Esperanza del total de juegos, para poder comparar con una línea. */
  expectedGames: number;
}

/**
 * Todo el partido, enumerado.
 *
 * ===========================================================================
 * EL SAQUE SE ALTERNA ENTRE SETS, Y NO ES UN DETALLE
 * ===========================================================================
 * Quien abre un set resta primero en el siguiente. Suponer que siempre abre el mismo
 * sesga los hándicaps de juegos, porque el que saca los juegos impares llega antes a 5-4.
 * Cuesta un parámetro llevarlo bien y se lleva.
 */
export function matchDistribution(
  p1: number,
  p2: number,
  firstServer: 1 | 2 = 1,
  rules: MatchRules = DEFAULT_MATCH,
): MatchDistribution {
  const need = rules.bestOf === 5 ? 3 : 2;

  // ===========================================================================
  // LOS ESTADOS SE FUSIONAN, Y ES LA DIFERENCIA ENTRE 2 SEGUNDOS Y 2 MILISEGUNDOS
  // ===========================================================================
  // La primera versión guardaba un nodo por CAMINO. Un set tiene ~14 finales posibles,
  // así que un mejor de 5 son 14^5 ≈ 537.000 caminos, y cada uno volvía a enumerar el
  // set siguiente. Medido: 2,2 segundos por partido, o sea 3,7 horas para evaluar una
  // temporada. El modelo era correcto y completamente inservible.
  //
  // Dos caminos que llegan a los mismos sets, los mismos juegos acumulados y el mismo
  // sacador son EL MISMO ESTADO: lo que pase después no depende de cómo se llegó. Se
  // suman sus probabilidades y se sigue con uno. El espacio pasa a estar acotado por los
  // juegos acumulados (unos 40 como mucho) en vez de crecer como una potencia.
  //
  // Y la enumeración del set se cachea: solo hay dos sacadores de salida y dos juegos de
  // reglas, así que son cuatro llamadas distintas por partido en vez de una por nodo.
  const setCache = new Map<string, SetScore[]>();
  const setsFor = (opener: 1 | 2, r: SetRules): SetScore[] => {
    const k = `${opener}|${r.tiebreak}|${r.tiebreakTo}`;
    let v = setCache.get(k);
    if (!v) {
      v = setScoreDistribution(p1, p2, opener, r);
      setCache.set(k, v);
    }
    return v;
  };

  interface Node {
    s1: number;
    s2: number;
    g1: number;
    g2: number;
    opener: 1 | 2;
    prob: number;
  }
  const nodeKey = (n: Omit<Node, 'prob'>): string =>
    `${n.s1}|${n.s2}|${n.g1}|${n.g2}|${n.opener}`;

  let live = new Map<string, Node>();
  const start: Node = { s1: 0, s2: 0, g1: 0, g2: 0, opener: firstServer, prob: 1 };
  live.set(nodeKey(start), start);
  const done: Node[] = [];

  for (let set = 0; set < rules.bestOf && live.size > 0; set++) {
    const next = new Map<string, Node>();
    for (const node of live.values()) {
      const isDeciding = node.s1 === need - 1 && node.s2 === need - 1;
      const setRules = isDeciding ? rules.decidingSet : rules.set;
      for (const sc of setsFor(node.opener, setRules)) {
        const won1 = sc.g1 > sc.g2;
        const child: Node = {
          s1: node.s1 + (won1 ? 1 : 0),
          s2: node.s2 + (won1 ? 0 : 1),
          g1: node.g1 + sc.g1,
          g2: node.g2 + sc.g2,
          // Quien abrió este set resta primero en el siguiente.
          opener: node.opener === 1 ? 2 : 1,
          prob: node.prob * sc.probability,
        };
        if (child.s1 >= need || child.s2 >= need) {
          done.push(child);
        } else {
          const k = nodeKey(child);
          const seen = next.get(k);
          if (seen) seen.prob += child.prob;
          else next.set(k, child);
        }
      }
    }
    live = next;
  }
  // Cualquier masa que quede viva sin partido cerrado sería un caso terminal olvidado.
  // Se suma a `done` para que la distribución siga sumando 1 y se pueda detectar.
  for (const n of live.values()) done.push(n);

  let matchProb = 0;
  const setScoreMap = new Map<string, number>();
  const totalMap = new Map<number, number>();
  const marginMap = new Map<number, number>();
  let expectedGames = 0;

  for (const n of done) {
    const winner: 1 | 2 = n.s1 > n.s2 ? 1 : 2;
    if (winner === 1) matchProb += n.prob;
    const label = `${Math.max(n.s1, n.s2)}-${Math.min(n.s1, n.s2)}`;
    const sk = `${winner}|${label}`;
    setScoreMap.set(sk, (setScoreMap.get(sk) ?? 0) + n.prob);
    const total = n.g1 + n.g2;
    totalMap.set(total, (totalMap.get(total) ?? 0) + n.prob);
    const margin = n.g1 - n.g2;
    marginMap.set(margin, (marginMap.get(margin) ?? 0) + n.prob);
    expectedGames += total * n.prob;
  }

  // P(gana un set) se recupera del partido invirtiendo la fórmula del mejor de N, que es
  // coherente por construcción con el resto en vez de ser una segunda estimación.
  const setProb = setProbFromMatch(matchProb, rules.bestOf);

  const sortNum = <T extends { probability: number }>(xs: T[]): T[] =>
    xs.sort((a, b) => b.probability - a.probability);

  return {
    matchProb,
    setProb,
    setScores: sortNum(
      [...setScoreMap.entries()].map(([k, probability]) => {
        const [side, label] = k.split('|');
        return { label, side: Number(side) as 1 | 2, probability };
      }),
    ),
    totalGames: [...totalMap.entries()]
      .map(([games, probability]) => ({ games, probability }))
      .sort((a, b) => a.games - b.games),
    gameMargin: [...marginMap.entries()]
      .map(([margin, probability]) => ({ margin, probability }))
      .sort((a, b) => a.margin - b.margin),
    expectedGames,
  };
}

/** Invierte P(partido) → P(set) para un mejor de N. Por bisección: es monótona. */
function setProbFromMatch(matchProb: number, bestOf: 3 | 5): number {
  const f = (p: number): number => {
    const q = 1 - p;
    return bestOf === 5 ? p ** 3 * (1 + 3 * q + 6 * q * q) : p * p * (3 - 2 * p);
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < matchProb) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * P(total de juegos por encima de una línea).
 *
 * Las líneas de tenis son de media unidad (22.5), así que no hay empate posible. Si
 * alguien pasa una línea entera se avisa en vez de repartir el empate en silencio.
 */
export function overGames(
  dist: MatchDistribution,
  line: number,
): { over: number; under: number; push: number } {
  let over = 0;
  let under = 0;
  let push = 0;
  for (const { games, probability } of dist.totalGames) {
    if (games > line) over += probability;
    else if (games < line) under += probability;
    else push += probability;
  }
  return { over, under, push };
}

/**
 * P(cubrir un hándicap de juegos).
 *
 * `handicap` es lo que se le SUMA al jugador 1: −3.5 significa que necesita ganar por
 * cuatro juegos o más.
 */
export function coverHandicap(
  dist: MatchDistribution,
  handicap: number,
): { cover: number; fail: number; push: number } {
  let cover = 0;
  let fail = 0;
  let push = 0;
  for (const { margin, probability } of dist.gameMargin) {
    const adj = margin + handicap;
    if (adj > 0) cover += probability;
    else if (adj < 0) fail += probability;
    else push += probability;
  }
  return { cover, fail, push };
}

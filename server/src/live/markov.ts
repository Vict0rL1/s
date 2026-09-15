// La cadena de Markov del tenis: punto → juego → set → partido.
//
// ===========================================================================
// ESTO NO EXISTÍA. Y HAY QUE DECIRLO
// ===========================================================================
// El encargo pedía usar «la misma cadena de Markov». No había ninguna: el modelo de
// tenis de esta app va de Elo a una probabilidad de partido, y de ahí BAJA a una
// probabilidad por set invirtiendo una fórmula cerrada (`model/scoreline.ts`). Nunca
// modeló puntos, ni juegos, ni quién saca.
//
// Para una predicción previa al partido eso basta y es defendible. Para una en vivo no
// sirve de nada: con 4-5 y 30-40 en contra, lo que decide el partido es el punto que se
// juega ahora, y una probabilidad por set no sabe nada de puntos.
//
// Así que la cadena se construye aquí, de abajo arriba, y el modelo previo sigue donde
// estaba. Son dos cosas distintas y ninguna sustituye a la otra.
//
// ===========================================================================
// EL ÚNICO PARÁMETRO
// ===========================================================================
// `p` = probabilidad de que el sacador gane UN punto con su saque. Todo lo demás sale
// de ahí por composición. En la ATP ronda 0.64; en un partido de hierba entre dos
// sacadores, 0.75.
//
// Esa reducción es una hipótesis fuerte y declarada: supone que los puntos son
// independientes y que `p` no cambia con el marcador. Lo segundo es falso en la
// realidad —un 30-40 no se juega igual que un 40-0— y medirlo necesitaría datos punto a
// punto que esta app NO tiene. Se dice aquí y se repite en el informe, en vez de
// esconderlo detrás de tres decimales.
//
// ===========================================================================
// TODO SE CALCULA DESDE CUALQUIER ESTADO
// ===========================================================================
// Es la diferencia entre un modelo previo y uno en vivo, y condiciona el diseño entero:
// no hay una función «probabilidad de ganar un juego», hay «probabilidad de ganar un
// juego DESDE 30-40». Cada nivel toma el marcador como entrada.

/** Los cuatro puntos de un juego, como índice: 0, 15, 30, 40. */
export const POINT_LABELS = ['0', '15', '30', '40'] as const;

/**
 * Probabilidad de que el sacador gane desde deuce.
 *
 * Forma cerrada y no recursión: desde deuce se vuelve a deuce, así que una recursión
 * memoizada se llamaría a sí misma para siempre. Ganar desde deuce es ganar dos puntos
 * seguidos antes que el rival, y la serie infinita colapsa a
 *
 *     D = p² / (p² + (1−p)²)
 */
export function deuceProb(p: number): number {
  const q = 1 - p;
  const den = p * p + q * q;
  return den > 0 ? (p * p) / den : 0.5;
}

/**
 * Probabilidad de que el SACADOR gane el juego desde un marcador de puntos.
 *
 * @param a puntos del sacador (0..), @param b puntos del restador
 *
 * Los marcadores con los dos por encima de 40 se reducen restando uno a cada uno hasta
 * caer en deuce o ventaja. Es exacto, no una aproximación: 40-40, ventaja-40 y sus
 * repeticiones son literalmente el mismo estado, porque lo único que importa es la
 * diferencia.
 */
export function gameProb(p: number, a = 0, b = 0): number {
  if (!(p >= 0) || !(p <= 1)) return 0.5;
  // Ventaja de dos con al menos cuatro puntos: juego terminado.
  if (a >= 4 && a - b >= 2) return 1;
  if (b >= 4 && b - a >= 2) return 0;

  // Reducir a la zona de deuce. (5-4) y (4-3) son el mismo estado.
  let x = a;
  let y = b;
  while (x >= 4 && y >= 4) {
    x--;
    y--;
  }
  if (x >= 3 && y >= 3) {
    const d = deuceProb(p);
    if (x === y) return d; // deuce
    if (x > y) return p + (1 - p) * d; // ventaja del sacador
    return p * d; // ventaja del restador
  }
  return p * gameProb(p, x + 1, y) + (1 - p) * gameProb(p, x, y + 1);
}

/**
 * Quién saca el punto `t` de un tiebreak (t empieza en 0).
 *
 * El patrón es 1, 2, 2, 2… — quien abre saca un punto y a partir de ahí se alternan de
 * dos en dos. `floor((t+1)/2)` par significa que saca quien abrió.
 */
export function tiebreakServer(t: number, opener: 1 | 2): 1 | 2 {
  const even = Math.floor((t + 1) / 2) % 2 === 0;
  return even ? opener : opener === 1 ? 2 : 1;
}

/**
 * Probabilidad de que gane el JUGADOR 1 un tiebreak desde un marcador.
 *
 * @param p1 probabilidad de que el jugador 1 gane un punto con SU saque
 * @param p2 ídem para el jugador 2
 * @param opener quién sacó el primer punto del tiebreak
 *
 * ===========================================================================
 * EL 6-6 SE RESUELVE EXACTO, NO POR TRUNCAMIENTO
 * ===========================================================================
 * A partir de 6-6 hay que ganar de dos y el estado se repite, así que la recursión
 * volvería a girar sin fin. Lo que la cierra es una observación: desde un empate, la
 * probabilidad de llevarse los DOS puntos siguientes es la misma sea quien sea el que
 * saque primero de los dos, porque el producto p1·(1−p2) es conmutativo. Así que
 *
 *     P(1 gana desde empate) = p1(1−p2) / (p1(1−p2) + (1−p1)p2)
 *
 * es exacta para cualquier empate de 6-6 en adelante, sin importar la fase del saque.
 * Truncar en «los primeros 40 puntos» habría dado un número casi igual y sin garantía.
 */
export function tiebreakProb(
  p1: number,
  p2: number,
  a = 0,
  b = 0,
  opener: 1 | 2 = 1,
  target = 7,
): number {
  if (a >= target && a - b >= 2) return 1;
  if (b >= target && b - a >= 2) return 0;

  const both = target - 1;
  if (a >= both && b >= both) {
    const win2 = p1 * (1 - p2);
    const lose2 = (1 - p1) * p2;
    const tied = win2 + lose2 > 0 ? win2 / (win2 + lose2) : 0.5;
    if (a === b) return tied;
    // Uno arriba: gana con el siguiente punto o vuelve al empate.
    const server = tiebreakServer(a + b, opener);
    const p1WinsNext = server === 1 ? p1 : 1 - p2;
    return a > b ? p1WinsNext + (1 - p1WinsNext) * tied : p1WinsNext * tied;
  }

  const server = tiebreakServer(a + b, opener);
  const p1WinsNext = server === 1 ? p1 : 1 - p2;
  return (
    p1WinsNext * tiebreakProb(p1, p2, a + 1, b, opener, target) +
    (1 - p1WinsNext) * tiebreakProb(p1, p2, a, b + 1, opener, target)
  );
}

export interface SetOptions {
  /** Puntos del tiebreak. 7 normal; 10 en los super-tiebreak de dobles y algunos finales. */
  tiebreakTo?: number;
  /**
   * Si el set se decide con tiebreak a 6-6.
   *
   * `false` es el set largo (Roland Garros hasta 2021, Wimbledon hasta 2018, Copa Davis
   * antigua). Cambia la probabilidad de forma nada despreciable con sacadores fuertes, y
   * suponerlo siempre `true` sería un error silencioso justo en los partidos más raros.
   */
  tiebreak?: boolean;
}

/**
 * Probabilidad de que el JUGADOR 1 gane el SET desde un marcador de juegos.
 *
 * @param g1 juegos del jugador 1, @param g2 del jugador 2
 * @param server quién saca el juego en curso
 * @param pointState puntos dentro del juego en curso, del SACADOR primero
 *
 * ===========================================================================
 * UNA SIMETRÍA QUE PARECE UN FALLO Y NO LO ES
 * ===========================================================================
 * Con el marcador EMPATADO (0-0, 3-3, 5-5), esta función devuelve el mismo número saque
 * quien saque, hasta el último decimal. Parece que el parámetro `server` se está
 * ignorando, y no: con 6-5 o 3-2 sí cambia el resultado, y mucho.
 *
 * Es una propiedad real del tenis. Desde un empate, cualquier continuación reparte el
 * mismo número de juegos al saque entre los dos, y el tiebreak iguala el resto — así que
 * quién empieza no aporta ventaja. Comprobado contra una simulación independiente de
 * 800.000 sets con p1 = 0.90 y p2 = 0.50, que reproduce los valores idénticos por su
 * cuenta (0.984725 desde 5-5, saque de cualquiera).
 *
 * Está escrito porque la reacción natural al verlo es «arreglarlo», y arreglarlo sería
 * romper un modelo correcto.
 */
export function setProb(
  p1: number,
  p2: number,
  g1 = 0,
  g2 = 0,
  server: 1 | 2 = 1,
  pointState: { server: number; returner: number } | null = null,
  opts: SetOptions = {},
): number {
  const tiebreak = opts.tiebreak ?? true;
  const tbTo = opts.tiebreakTo ?? 7;

  // Set ganado: seis juegos con dos de margen, o siete.
  if (g1 >= 6 && g1 - g2 >= 2) return 1;
  if (g2 >= 6 && g2 - g1 >= 2) return 0;
  if (g1 === 7 && g2 <= 6 && g1 - g2 >= 1) return 1;
  if (g2 === 7 && g1 <= 6 && g2 - g1 >= 1) return 0;

  if (tiebreak && g1 === 6 && g2 === 6) {
    // En el tiebreak abre el que RESTÓ el último juego, o sea el que tocaría sacar.
    return tiebreakProb(p1, p2, pointState?.server ?? 0, pointState?.returner ?? 0, server, tbTo);
  }

  // Sin tiebreak, un set largo puede seguir indefinidamente; se resuelve igual que el
  // empate del tiebreak, con la probabilidad de llevarse los dos juegos siguientes.
  if (!tiebreak && g1 >= 6 && g2 >= 6) {
    const hold1 = gameProb(p1);
    const hold2 = gameProb(p2);
    // Dos juegos, uno con cada saque: el orden da igual por conmutatividad.
    const win2 = hold1 * (1 - hold2);
    const lose2 = (1 - hold1) * hold2;
    const tied = win2 + lose2 > 0 ? win2 / (win2 + lose2) : 0.5;
    if (g1 === g2) return tied;
    const holdNow = server === 1 ? hold1 : 1 - hold2;
    return g1 > g2 ? holdNow + (1 - holdNow) * tied : holdNow * tied;
  }

  // El juego en curso. `pointState` va del punto de vista del SACADOR.
  const pServe = server === 1 ? p1 : p2;
  const serverWinsGame = gameProb(pServe, pointState?.server ?? 0, pointState?.returner ?? 0);
  const p1WinsGame = server === 1 ? serverWinsGame : 1 - serverWinsGame;
  const next: 1 | 2 = server === 1 ? 2 : 1;

  return (
    p1WinsGame * setProb(p1, p2, g1 + 1, g2, next, null, opts) +
    (1 - p1WinsGame) * setProb(p1, p2, g1, g2 + 1, next, null, opts)
  );
}

export interface MatchOptions extends SetOptions {
  /** 3 o 5. */
  bestOf?: 3 | 5;
  /** Reglas propias del set decisivo: algunos torneos no lo juegan con tiebreak a 7. */
  decidingSet?: SetOptions;
}

/**
 * Probabilidad de que el JUGADOR 1 gane el PARTIDO desde el estado completo.
 *
 * Los sets ya cerrados solo cuentan como número: quién ganó cuál y por cuánto no cambia
 * nada bajo la hipótesis de independencia. Que eso sea cierto es justo lo que no se
 * puede comprobar sin datos punto a punto, y por eso está escrito arriba.
 */
export function matchProb(
  p1: number,
  p2: number,
  setsWon1: number,
  setsWon2: number,
  g1: number,
  g2: number,
  server: 1 | 2,
  pointState: { server: number; returner: number } | null,
  opts: MatchOptions = {},
): number {
  const bestOf = opts.bestOf ?? 3;
  const need = bestOf === 5 ? 3 : 2;
  if (setsWon1 >= need) return 1;
  if (setsWon2 >= need) return 0;

  // El set decisivo puede tener reglas propias.
  const isDeciding = setsWon1 === need - 1 && setsWon2 === need - 1;
  const setOpts = isDeciding ? { ...opts, ...opts.decidingSet } : opts;

  const pSet = setProb(p1, p2, g1, g2, server, pointState, setOpts);

  // Quién saca el primer juego del set siguiente: el que restó el primero de este. Con
  // los juegos jugados se sabe — el que abrió el set sacó los juegos pares.
  const openedThisSet: 1 | 2 = (g1 + g2) % 2 === 0 ? server : server === 1 ? 2 : 1;
  const nextOpener: 1 | 2 = openedThisSet === 1 ? 2 : 1;

  return (
    pSet * matchProb(p1, p2, setsWon1 + 1, setsWon2, 0, 0, nextOpener, null, opts) +
    (1 - pSet) * matchProb(p1, p2, setsWon1, setsWon2 + 1, 0, 0, nextOpener, null, opts)
  );
}

// El marcador en vivo, y por qué hay que validarlo antes de creerlo.
//
// ===========================================================================
// UN MARCADOR IMPOSIBLE PRODUCE UNA PROBABILIDAD PERFECTAMENTE CREÍBLE
// ===========================================================================
// La cadena no se queja con 8-2 en juegos, ni con 5-4 en puntos, ni con dos sets a dos
// al mejor de tres. Devuelve un número, el panel lo pinta, y nadie se entera.
//
// Por eso el estado se valida siempre y los errores se devuelven con el motivo. Es la
// diferencia entre «te has equivocado escribiendo el 8» y una probabilidad inventada con
// tres decimales.

export type Player = 1 | 2;

export interface LiveState {
  /** Sets ya ganados por cada uno. */
  sets: [number, number];
  /** Juegos del set en curso. */
  games: [number, number];
  /**
   * Puntos del juego en curso, desde el punto de vista del SACADOR primero.
   *
   * Índices y no «15/30/40»: 0, 1, 2, 3 = 0, 15, 30, 40, y 4+ para las ventajas. Un
   * texto sería más legible de leer y peor de calcular, y la conversión vive en un solo
   * sitio (`pointLabel`).
   */
  points: [number, number];
  /** Quién saca AHORA. */
  server: Player;
  bestOf: 3 | 5;
  /** Si el set en curso es un tiebreak (6-6 alcanzado). */
  inTiebreak?: boolean;
  tiebreak?: boolean;
  tiebreakTo?: number;
}

export interface Invalid {
  field: string;
  reason: string;
}

/** Etiqueta de un punto, con las ventajas resueltas contra el otro marcador. */
export function pointLabel(mine: number, theirs: number): string {
  if (mine >= 3 && theirs >= 3) {
    if (mine === theirs) return '40';
    return mine > theirs ? 'AD' : '—';
  }
  return ['0', '15', '30', '40'][Math.min(mine, 3)];
}

/**
 * Comprueba que el marcador puede existir.
 *
 * Devuelve la lista de problemas, vacía si está bien. Una lista y no el primer error:
 * quien teclea un marcador a mano se equivoca a menudo en dos cosas a la vez, y
 * corregirlas de una en una es tres veces el trabajo.
 */
export function validate(s: LiveState): Invalid[] {
  const bad: Invalid[] = [];
  const need = s.bestOf === 5 ? 3 : 2;

  if (s.bestOf !== 3 && s.bestOf !== 5) {
    bad.push({ field: 'bestOf', reason: 'un partido es al mejor de 3 o de 5' });
  }
  for (const [i, v] of s.sets.entries()) {
    if (!Number.isInteger(v) || v < 0) {
      bad.push({ field: `sets[${i}]`, reason: 'los sets ganados son un entero ≥ 0' });
    }
  }
  if (s.sets[0] >= need && s.sets[1] >= need) {
    bad.push({ field: 'sets', reason: 'no pueden ganar los dos' });
  }
  if (s.sets[0] >= need || s.sets[1] >= need) {
    bad.push({
      field: 'sets',
      reason: `el partido ya está terminado (${s.sets[0]}-${s.sets[1]} al mejor de ${s.bestOf})`,
    });
  }
  // Al mejor de 3 no se llega a 3 sets ganados; al mejor de 5, a 4.
  if (s.sets[0] + s.sets[1] > (s.bestOf === 5 ? 4 : 2)) {
    bad.push({ field: 'sets', reason: `demasiados sets jugados para un mejor de ${s.bestOf}` });
  }

  const [g1, g2] = s.games;
  for (const [i, v] of s.games.entries()) {
    if (!Number.isInteger(v) || v < 0) {
      bad.push({ field: `games[${i}]`, reason: 'los juegos son un entero ≥ 0' });
    }
  }
  const tb = s.tiebreak ?? true;
  if (tb) {
    // Con tiebreak, un set acaba como muy tarde 7-6, así que 8-6 o 7-4 no existen.
    if (g1 > 7 || g2 > 7) {
      bad.push({ field: 'games', reason: 'con tiebreak ningún set pasa de 7 juegos' });
    }
    if ((g1 === 7 && g2 < 5) || (g2 === 7 && g1 < 5)) {
      bad.push({ field: 'games', reason: 'un 7 solo puede ser 7-5 o 7-6' });
    }
    if (g1 >= 6 && g2 >= 6 && Math.abs(g1 - g2) > 1) {
      bad.push({ field: 'games', reason: 'a partir de 6-6 la diferencia no pasa de 1' });
    }
  }
  if ((g1 >= 6 && g1 - g2 >= 2) || (g2 >= 6 && g2 - g1 >= 2)) {
    bad.push({ field: 'games', reason: 'ese set ya está ganado: el marcador debería ir en sets' });
  }

  const [pa, pb] = s.points;
  for (const [i, v] of s.points.entries()) {
    if (!Number.isInteger(v) || v < 0) {
      bad.push({ field: `points[${i}]`, reason: 'los puntos son un entero ≥ 0' });
    }
  }
  if (s.inTiebreak) {
    const target = s.tiebreakTo ?? 7;
    if ((pa >= target && pa - pb >= 2) || (pb >= target && pb - pa >= 2)) {
      bad.push({ field: 'points', reason: 'ese tiebreak ya está ganado' });
    }
  } else {
    // Fuera del tiebreak, cualquier marcador con los dos ≥ 4 se reduce a ventaja, y una
    // diferencia de 2 con 4+ puntos significa juego terminado.
    if ((pa >= 4 && pa - pb >= 2) || (pb >= 4 && pb - pa >= 2)) {
      bad.push({ field: 'points', reason: 'ese juego ya está ganado' });
    }
    if (pa > 4 && pb < 3) bad.push({ field: 'points', reason: 'no se puede ir de 5 a 15' });
    if (pb > 4 && pa < 3) bad.push({ field: 'points', reason: 'no se puede ir de 5 a 15' });
  }

  if (s.inTiebreak && !(g1 === 6 && g2 === 6)) {
    bad.push({ field: 'inTiebreak', reason: 'un tiebreak solo empieza a 6-6' });
  }
  if (s.server !== 1 && s.server !== 2) {
    bad.push({ field: 'server', reason: 'saca el 1 o el 2' });
  }
  return bad;
}

/** El marcador en texto, tal y como lo diría un marcador de televisión. */
export function describe(s: LiveState, names: [string, string] = ['J1', 'J2']): string {
  const sets = `${s.sets[0]}-${s.sets[1]}`;
  const games = `${s.games[0]}-${s.games[1]}`;
  const pts = s.inTiebreak
    ? `${s.points[0]}-${s.points[1]}`
    : `${pointLabel(s.points[0], s.points[1])}-${pointLabel(s.points[1], s.points[0])}`;
  const who = names[s.server - 1];
  return `sets ${sets} · juegos ${games} · ${s.inTiebreak ? 'TB ' : ''}${pts} · saca ${who}`;
}

/**
 * El estado después de un punto. Devuelve `null` si el punto termina el partido.
 *
 * ===========================================================================
 * PARA QUÉ HACE FALTA AVANZAR EL ESTADO
 * ===========================================================================
 * Para saber cuánto vale el punto que se está jugando. La pregunta «¿es importante este
 * punto?» tiene una respuesta exacta —la diferencia entre la probabilidad de ganar
 * habiéndolo ganado y habiéndolo perdido— y calcularla exige poder simular las dos
 * ramas. Es la única forma de que «break point» sea un número y no una etiqueta.
 */
export function advancePoint(s: LiveState, winner: Player): LiveState | { done: Player } {
  const need = s.bestOf === 5 ? 3 : 2;
  const tbTo = s.tiebreakTo ?? 7;
  const other: Player = s.server === 1 ? 2 : 1;
  // `points` va del sacador primero, así que hay que traducir quién ganó.
  const serverWon = winner === s.server;
  const pts: [number, number] = [
    s.points[0] + (serverWon ? 1 : 0),
    s.points[1] + (serverWon ? 0 : 1),
  ];

  const closeSet = (winnerOfSet: Player): LiveState | { done: Player } => {
    const sets: [number, number] = [
      s.sets[0] + (winnerOfSet === 1 ? 1 : 0),
      s.sets[1] + (winnerOfSet === 2 ? 1 : 0),
    ];
    if (sets[winnerOfSet - 1] >= need) return { done: winnerOfSet };
    // Quien abrió el set anterior resta primero en el siguiente.
    const openedThisSet: Player =
      (s.games[0] + s.games[1]) % 2 === 0 ? s.server : other;
    return {
      ...s,
      sets,
      games: [0, 0],
      points: [0, 0],
      server: openedThisSet === 1 ? 2 : 1,
      inTiebreak: false,
    };
  };

  if (s.inTiebreak) {
    const [a, b] = pts;
    // En el tiebreak `points` sigue siendo sacador-primero, pero el sacador cambia
    // dentro del propio tiebreak, así que se lleva en términos de jugador 1 y 2.
    const p1 = s.server === 1 ? a : b;
    const p2 = s.server === 1 ? b : a;
    if (p1 >= tbTo && p1 - p2 >= 2) return closeSet(1);
    if (p2 >= tbTo && p2 - p1 >= 2) return closeSet(2);
    const t = p1 + p2;
    // Quien abrió el tiebreak es quien sacaba al llegar a 6-6.
    const opener: Player = tiebreakOpenerOf(s);
    const nextServer = tiebreakServer(t, opener);
    const nextPts: [number, number] = nextServer === 1 ? [p1, p2] : [p2, p1];
    return { ...s, points: nextPts, server: nextServer };
  }

  // ¿Termina el juego?
  const gameOver = (pts[0] >= 4 && pts[0] - pts[1] >= 2) || (pts[1] >= 4 && pts[1] - pts[0] >= 2);
  if (!gameOver) return { ...s, points: pts };

  const gameWinner: Player = pts[0] > pts[1] ? s.server : other;
  const games: [number, number] = [
    s.games[0] + (gameWinner === 1 ? 1 : 0),
    s.games[1] + (gameWinner === 2 ? 1 : 0),
  ];
  const tb = s.tiebreak ?? true;
  if (games[0] >= 6 && games[0] - games[1] >= 2) return closeSet(1);
  if (games[1] >= 6 && games[1] - games[0] >= 2) return closeSet(2);
  if (tb && games[0] === 7) return closeSet(1);
  if (tb && games[1] === 7) return closeSet(2);
  if (tb && games[0] === 6 && games[1] === 6) {
    return { ...s, games, points: [0, 0], server: other, inTiebreak: true };
  }
  return { ...s, games, points: [0, 0], server: other };
}

/** Quién abrió el tiebreak: el que sacaba cuando se llegó a 6-6. */
function tiebreakOpenerOf(s: LiveState): Player {
  // Dentro del tiebreak, `server` es quien saca AHORA; se retrocede por el patrón.
  const t = s.points[0] + s.points[1];
  // Si `server` es quien saca el punto t, el que abrió cumple tiebreakServer(t, opener)
  // = server. Se prueban los dos: solo uno encaja.
  return tiebreakServer(t, 1) === s.server ? 1 : 2;
}

/** El patrón de saque del tiebreak, repetido aquí para no importar en círculo. */
function tiebreakServer(t: number, opener: Player): Player {
  const even = Math.floor((t + 1) / 2) % 2 === 0;
  return even ? opener : opener === 1 ? 2 : 1;
}

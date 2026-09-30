// Las situaciones concretas: break point, saque para el partido, y lo que valen.
//
// ===========================================================================
// UNA ETIQUETA NO ES INFORMACIÓN. UN NÚMERO SÍ
// ===========================================================================
// «Break point» pintado en rojo no dice nada que no se vea en el marcador. Lo que
// importa es CUÁNTO cambia el partido según se gane o se pierda ese punto, y eso tiene
// una respuesta exacta que la cadena puede dar:
//
//     apalancamiento = P(gana | gana este punto) − P(gana | lo pierde)
//
// Un break point a 0-40 con 2-5 en contra vale casi nada porque el set ya está perdido.
// Uno a 30-40 con 5-5 en el tercero vale muchísimo. Los dos se llaman «break point» y no
// se parecen en nada, y solo el número los distingue.
//
// ===========================================================================
// EL MOMENTUM: LO QUE NO SE PUEDE MEDIR AQUÍ, Y NO SE FINGE
// ===========================================================================
// El encargo pide «momentum tras un quiebre». Se detecta y se enseña —saber que acaba de
// haber un break es información real— pero NO se aplica ningún ajuste de probabilidad, y
// el motivo es que no se puede medir con estos datos.
//
// Comprobar si un jugador recién quebrado saca peor en el juego siguiente exige datos
// PUNTO A PUNTO, y esta app tiene agregados por partido: 29.486 partidos con el total de
// puntos al saque, sin el orden en que ocurrieron. No hay forma de mirar el juego
// siguiente a un break porque no se sabe cuándo hubo breaks.
//
// Así que se puede hacer una de dos cosas: inventarse un multiplicador «porque todo el
// mundo sabe que el momentum existe», o decir que no se ha medido. La literatura, además,
// encuentra el efecto pequeño o nulo — pero eso tampoco lo he comprobado yo aquí, así que
// tampoco vale como respaldo.
//
// La casilla queda marcada como pendiente, con lo que haría falta para llenarla.

import { matchProb } from './markov.ts';
import { advancePoint, type LiveState, type Player } from './state.ts';

export type SituationKind =
  | 'break-point'
  | 'set-point'
  | 'match-point'
  | 'saca-para-set'
  | 'saca-para-partido'
  | 'tras-quiebre';

export interface Situation {
  kind: SituationKind;
  /** A quién favorece. */
  side: Player;
  label: string;
  detail: string;
}

export interface Leverage {
  /** P(gana el jugador 1) ahora mismo. */
  now: number;
  /** P(gana el 1) si el jugador 1 gana el punto en juego. */
  ifWins1: number;
  /** P(gana el 1) si lo gana el 2. */
  ifWins2: number;
  /**
   * Cuánto se mueve el partido con este punto, en puntos porcentuales.
   *
   * Siempre positivo: es la anchura del salto, no su dirección.
   */
  swingPp: number;
}

/** La probabilidad tras un punto, resolviendo el caso de que el punto cierre el partido. */
function probAfter(s: LiveState, winner: Player, p1: number, p2: number): number {
  const next = advancePoint(s, winner);
  if ('done' in next) return next.done === 1 ? 1 : 0;
  return matchProb(
    p1,
    p2,
    next.sets[0],
    next.sets[1],
    next.games[0],
    next.games[1],
    next.server,
    // `points` ya viene en orden sacador-restador tanto dentro como fuera del tiebreak,
    // así que no hay dos casos: `advancePoint` deja el estado normalizado.
    { server: next.points[0], returner: next.points[1] },
    {
      bestOf: next.bestOf,
      tiebreak: next.tiebreak,
      tiebreakTo: next.tiebreakTo,
    },
  );
}

/** Cuánto vale el punto que se está jugando. */
export function leverage(s: LiveState, p1: number, p2: number): Leverage {
  const now = matchProb(
    p1,
    p2,
    s.sets[0],
    s.sets[1],
    s.games[0],
    s.games[1],
    s.server,
    { server: s.points[0], returner: s.points[1] },
    { bestOf: s.bestOf, tiebreak: s.tiebreak, tiebreakTo: s.tiebreakTo },
  );
  const ifWins1 = probAfter(s, 1, p1, p2);
  const ifWins2 = probAfter(s, 2, p1, p2);
  return { now, ifWins1, ifWins2, swingPp: Math.abs(ifWins1 - ifWins2) * 100 };
}

/**
 * Qué está pasando en este marcador.
 *
 * Se detecta comprobando qué pasaría si alguien ganara el punto, no reconociendo
 * marcadores de memoria. Es más corto, no se olvida de las ventajas ni del tiebreak, y
 * no puede desincronizarse de las reglas que usa la cadena: si `advancePoint` dice que
 * el partido termina, es punto de partido, y punto.
 */
export function situations(s: LiveState, lastGame?: { winner: Player; wasBreak: boolean }): Situation[] {
  const out: Situation[] = [];
  const returner: Player = s.server === 1 ? 2 : 1;

  for (const who of [1, 2] as Player[]) {
    const next = advancePoint(s, who);

    if ('done' in next) {
      out.push({
        kind: 'match-point',
        side: who,
        label: 'Punto de partido',
        detail:
          who === s.server
            ? 'Con este punto cierra su saque y gana el partido.'
            : 'Con este punto rompe y gana el partido.',
      });
      continue;
    }
    // Cuántas bolas seguidas tiene: a 0-40 son tres, a 15-40 dos, a 30-40 una.
    const serverPts = s.points[0];
    const returnerPts = s.points[1];
    const chances = returnerPts >= 3 && serverPts < 3 ? 3 - serverPts : 1;
    const breaking = who === returner && !s.inTiebreak;

    // Un set más significa que el punto cerraba el set.
    if (next.sets[who - 1] > s.sets[who - 1]) {
      out.push({
        kind: 'set-point',
        side: who,
        label: chances > 1 ? `${chances} puntos de set` : 'Punto de set',
        detail:
          `Con este punto se lleva el set (${s.games[0]}-${s.games[1]})` +
          // Que además sea al resto importa: es set Y break a la vez.
          (breaking ? ', rompiendo el saque.' : '.'),
      });
    } else if (next.games[who - 1] > s.games[who - 1] && breaking) {
      out.push({
        kind: 'break-point',
        side: who,
        label: chances > 1 ? `${chances} bolas de break` : 'Break point',
        detail: `Rompe el saque con este punto (${serverPts}-${returnerPts} en el juego).`,
      });
    }
  }

  // Sacar para el set o para el partido: el sacador ganaría set/partido con el JUEGO,
  // no necesariamente con el punto.
  if (!s.inTiebreak) {
    const need = s.bestOf === 5 ? 3 : 2;
    const g = s.games[s.server - 1];
    const gOther = s.games[(s.server === 1 ? 2 : 1) - 1];
    const winsSetWithGame = (g >= 5 && g - gOther >= 1) || (g === 6 && gOther === 5);
    if (winsSetWithGame) {
      const closesMatch = s.sets[s.server - 1] === need - 1;
      out.push({
        kind: closesMatch ? 'saca-para-partido' : 'saca-para-set',
        side: s.server,
        label: closesMatch ? 'Saca para el partido' : 'Saca para el set',
        detail: `Ganando este juego cierra ${closesMatch ? 'el partido' : 'el set'} (${s.games[0]}-${s.games[1]}).`,
      });
    }
  }

  // Tras un quiebre. Se ENSEÑA, no se ajusta — ver la cabecera del fichero.
  if (lastGame?.wasBreak) {
    out.push({
      kind: 'tras-quiebre',
      side: lastGame.winner,
      label: 'Viene de romper',
      detail:
        'El juego anterior fue un break. El modelo NO ajusta por esto: medir si el ' +
        'momentum existe exige datos punto a punto, que esta app no tiene.',
    });
  }

  return out;
}

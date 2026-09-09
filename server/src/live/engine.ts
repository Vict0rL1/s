// El motor en vivo: marcador dentro, probabilidad y discrepancias fuera.
//
// ===========================================================================
// LAS DOS PROBABILIDADES, Y POR QUÉ SE ENSEÑAN LAS DOS
// ===========================================================================
// `base` usa el saque previo al partido. `viva` usa el saque actualizado con lo que está
// pasando hoy. La diferencia entre las dos es EXACTAMENTE lo que ha aportado la
// actualización bayesiana, y verla separada es lo que permite decidir si uno se la cree.
//
// Enseñar solo la segunda escondería de dónde sale el número; enseñar solo la primera
// sería el modelo previo con un marcador encima.
//
// ===========================================================================
// LA COMPARACIÓN CONTRA EL MERCADO
// ===========================================================================
// Una discrepancia contra la cuota en vivo NO es una ventaja. En vivo, el mercado ve
// cosas que este modelo no puede ver: un jugador cojeando, un fisio en pista, la
// dirección del viento. Un modelo que solo conoce el marcador y unas medias de carrera
// va a discrepar del mercado justo cuando el mercado tiene razón.
//
// Por eso lo que se devuelve se llama «discrepancia» y no «valor», y por eso la nota que
// acompaña a las grandes es una advertencia y no una recomendación.

import { matchProb } from './markov.ts';
import { validate, type LiveState, type Invalid } from './state.ts';
import { leverage, situations, type Leverage, type Situation } from './situations.ts';
import { updateServe, serveAnomaly, KAPPA_SERVE, type ServeTally, type Updated } from './bayes.ts';
import { impliedProbabilities } from '../model/market.ts';

export interface LiveInput {
  state: LiveState;
  /** P(punto al saque) antes del partido, de `serve.ts` o puesta a mano. */
  prior: [number, number];
  /** Lo que lleva cada uno al saque EN ESTE PARTIDO. */
  tally?: [ServeTally, ServeTally];
  /** Cuotas decimales en vivo, para comparar. */
  odds?: [number, number] | null;
  /** El juego anterior, para detectar que viene de un break. */
  lastGame?: { winner: 1 | 2; wasBreak: boolean };
  /** Fuerza del prior. Se puede bajar para ver qué haría el modelo confiando más en hoy. */
  kappa?: number;
}

export interface LiveResult {
  invalid: Invalid[];
  /** Probabilidad con el saque previo, sin mirar lo que va del partido. */
  base: number;
  /** Probabilidad con el saque actualizado. Es la que manda. */
  live: number;
  serve: { p1: number; p2: number; update1: Updated; update2: Updated };
  anomalies: { side: 1 | 2; text: string }[];
  leverage: Leverage;
  situations: Situation[];
  market: {
    /** Probabilidad implícita del mercado, sin margen. */
    fair: [number, number];
    overround: number;
    /** Modelo menos mercado, en puntos porcentuales, para el jugador 1. */
    edgePp: number;
    note: string;
  } | null;
  notes: string[];
}

/** Cuánto tiene que separarse el modelo del mercado para que merezca mencionarse. */
const DISCREPANCY_PP = 5;

export function evaluate(input: LiveInput): LiveResult {
  const { state } = input;
  const invalid = validate(state);
  const kappa = input.kappa ?? KAPPA_SERVE;
  const notes: string[] = [];

  const tally: [ServeTally, ServeTally] = input.tally ?? [
    { won: 0, played: 0 },
    { won: 0, played: 0 },
  ];
  const u1 = updateServe(input.prior[0], tally[0], kappa);
  const u2 = updateServe(input.prior[1], tally[1], kappa);

  const opts = {
    bestOf: state.bestOf,
    tiebreak: state.tiebreak,
    tiebreakTo: state.tiebreakTo,
  };
  const pointState = { server: state.points[0], returner: state.points[1] };

  const base = matchProb(
    input.prior[0],
    input.prior[1],
    state.sets[0],
    state.sets[1],
    state.games[0],
    state.games[1],
    state.server,
    pointState,
    opts,
  );
  const live = matchProb(
    u1.posterior,
    u2.posterior,
    state.sets[0],
    state.sets[1],
    state.games[0],
    state.games[1],
    state.server,
    pointState,
    opts,
  );

  const anomalies: { side: 1 | 2; text: string }[] = [];
  for (const [i, u] of [u1, u2].entries()) {
    const a = serveAnomaly(u);
    if (a) anomalies.push({ side: (i + 1) as 1 | 2, text: a.text });
  }
  if (anomalies.length === 0 && (u1.n > 0 || u2.n > 0)) {
    notes.push(
      `Los dos sacan dentro de lo suyo: la actualización mueve la probabilidad ` +
        `${Math.abs(live - base) < 0.005 ? 'menos de medio punto' : `${((live - base) * 100).toFixed(1)} pp`}.`,
    );
  }
  if (u1.n === 0 && u2.n === 0) {
    notes.push(
      'Sin puntos de saque de este partido: la probabilidad viva es idéntica a la base. ' +
        'La actualización bayesiana no tiene nada que actualizar todavía.',
    );
  }

  const lev = leverage(
    state,
    u1.posterior,
    u2.posterior,
  );

  let market: LiveResult['market'] = null;
  if (input.odds && input.odds[0] > 1 && input.odds[1] > 1) {
    const m = impliedProbabilities(input.odds[0], input.odds[1]);
    if (m) {
      const edgePp = (live - m.implied1) * 100;
      const big = Math.abs(edgePp) >= DISCREPANCY_PP;
      market = {
        fair: [m.implied1, m.implied2],
        overround: m.overround,
        edgePp,
        note: big
          ? `Discrepancia de ${Math.abs(edgePp).toFixed(1)} pp a favor del jugador ` +
            `${edgePp > 0 ? '1' : '2'}. En vivo eso NO es una ventaja por sí solo: el ` +
            'mercado ve cosas que este modelo no puede ver —una lesión, un fisio en pista, ' +
            'el viento— y discrepa más justo cuando tiene razón. Sirve para mirar el ' +
            'partido, no para apostar sin mirarlo.'
          : `El modelo y el mercado están a ${Math.abs(edgePp).toFixed(1)} pp, dentro de lo normal.`,
      };
    }
  }

  return {
    invalid,
    base,
    live,
    serve: { p1: u1.posterior, p2: u2.posterior, update1: u1, update2: u2 },
    anomalies,
    leverage: lev,
    situations: situations(state, input.lastGame),
    market,
    notes,
  };
}

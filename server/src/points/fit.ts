// Estimación conjunta de saque y resto, ajustada por la calidad del rival.
//
// ===========================================================================
// POR QUÉ NO BASTA CON LA MEDIA DE CARRERA
// ===========================================================================
// «Este jugador gana el 68 % de sus puntos al saque» es un dato contaminado: se midió
// contra los restadores que le tocaron. Un jugador de challengers y uno que solo juega
// Masters tienen calendarios completamente distintos, y sus medias no son comparables.
//
// El módulo anterior (`live/serve.ts`) restaba medias de carrera:
//
//     p(A saca contra B) = s_A − r_B + (1 − μ)
//
// Es la corrección de primer orden y es mejor que nada, pero arrastra el mismo sesgo:
// s_A ya lleva dentro la calidad media de SUS rivales, y r_B la de los suyos. Restar dos
// números contaminados no descontamina ninguno.
//
// ===========================================================================
// LO QUE SE HACE EN VEZ DE ESO
// ===========================================================================
// Estimar todos los saques y todos los restos A LA VEZ, resolviendo el sistema entero:
//
//     logit P(i gana un punto sacando contra j)  =  μ_superficie + s_i − r_j
//
// Ahí `s_i` ya no es «lo que hizo contra sus rivales» sino «lo que haría contra un rival
// medio», porque la calidad de cada rival está representada por su propio `r_j` y el
// ajuste la descuenta. Es el mismo argumento por el que un Elo es mejor que un
// porcentaje de victorias.
//
// ===========================================================================
// JERÁRQUICO POR SUPERFICIE
// ===========================================================================
//     s_i,superficie = s_i + δ_i,superficie
//
// con δ encogido hacia cero. Un jugador con 400 partidos en tierra tiene su propio δ;
// uno con 6 se queda pegado a su perfil global. Sin ese encogimiento, los δ de las
// muestras pequeñas son ruido con nombre de especialista — y la hierba, con 3.204
// partidos frente a 17.361 en dura, es donde más daño haría.
//
// ===========================================================================
// CÓMO SE AJUSTA
// ===========================================================================
// Descenso de gradiente sobre la verosimilitud binomial con regularización L2. Son unos
// 1.100 jugadores × (1 saque + 1 resto + 3 δ de superficie × 2) = ~8.800 parámetros
// sobre ~59.000 observaciones. No hace falta nada más sofisticado: la función es cóncava
// en los parámetros salvo por el acoplamiento s−r, y en la práctica converge en unos
// cientos de iteraciones.
//
// La identificabilidad se fija con la regularización: sumar una constante a todos los
// `s` y restarla a todos los `r` deja la verosimilitud igual, así que sin penalización
// el óptimo sería un valle plano. La L2 elige el punto de norma mínima de ese valle.

import { getDb } from '../db.ts';
import type { TourId } from '../types.ts';

export type Surface = 'Hard' | 'Clay' | 'Grass';
export const SURFACES: Surface[] = ['Hard', 'Clay', 'Grass'];

/** Una actuación al saque: jugador i sacando contra j, k puntos ganados de n. */
export interface Obs {
  server: number;
  returner: number;
  surface: Surface;
  won: number;
  played: number;
  /** YYYYMMDD, para poder ajustar solo con el pasado. */
  date: string;
}

export interface PointsModel {
  tour: TourId;
  /** Intercepto por superficie, en logit. */
  mu: Record<Surface, number>;
  /** Saque global por jugador, en logit. */
  serve: Map<number, number>;
  /** Resto global por jugador, en logit. */
  ret: Map<number, number>;
  /** Desviación por superficie sobre el perfil global. */
  serveSurface: Map<string, number>;
  ret_surface: Map<string, number>;
  /** Puntos servidos por jugador, para poder decir de quién no se sabe nada. */
  servePoints: Map<number, number>;
  returnPoints: Map<number, number>;
  meta: {
    observations: number;
    players: number;
    iterations: number;
    logLik: number;
    lambda: number;
    lambdaSurface: number;
  };
}

const key = (id: number, s: Surface): string => `${id}|${s}`;
const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export interface FitOptions {
  /** Regularización del perfil global. */
  lambda?: number;
  /**
   * Regularización de las desviaciones por superficie. MÁS FUERTE que la global a
   * propósito: un δ de superficie se estima con una fracción de los partidos, así que
   * merece menos confianza por construcción.
   */
  lambdaSurface?: number;
  iterations?: number;
  learningRate?: number;
  /** Solo partidos anteriores a esta fecha (YYYYMMDD). Para el walk-forward. */
  before?: string;
  /** Semivida del decay temporal en días. `null` = sin decay. */
  halfLifeDays?: number | null;
}

/** Todas las actuaciones al saque del circuito, una por jugador y partido. */
export function loadObservations(tour: TourId, before?: string): Obs[] {
  const rows = getDb()
    .prepare(
      `SELECT tourney_date AS date, surface, winner_id AS w, loser_id AS l,
              w_svpt AS wn, w_1stWon + w_2ndWon AS wk,
              l_svpt AS ln, l_1stWon + l_2ndWon AS lk
       FROM matches
       WHERE tour = ? AND w_svpt IS NOT NULL AND l_svpt IS NOT NULL
         AND w_svpt > 10 AND l_svpt > 10
         AND surface IN ('Hard','Clay','Grass')
         ${before ? 'AND tourney_date < ?' : ''}
       ORDER BY tourney_date`,
    )
    .all(...(before ? [tour, before] : [tour])) as unknown as {
    date: string;
    surface: Surface;
    w: number;
    l: number;
    wn: number;
    wk: number;
    ln: number;
    lk: number;
  }[];

  const out: Obs[] = [];
  for (const r of rows) {
    // Dos observaciones por partido: cada jugador sacando contra el otro.
    out.push({ server: r.w, returner: r.l, surface: r.surface, won: r.wk, played: r.wn, date: r.date });
    out.push({ server: r.l, returner: r.w, surface: r.surface, won: r.lk, played: r.ln, date: r.date });
  }
  return out;
}

function daysBetween(a: string, b: string): number {
  const ms = (s: string): number =>
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Math.max(0, (ms(b) - ms(a)) / 86_400_000);
}

/**
 * Ajusta el modelo.
 *
 * El decay temporal está apagado por defecto y es una opción, no una decisión tomada: el
 * estudio (`npm run study:points`) compara con y sin, y lo que se publique tiene que
 * salir de esa comparación y no de que suene razonable.
 */
export function fitPoints(tour: TourId, opts: FitOptions = {}): PointsModel {
  const lambda = opts.lambda ?? 0.02;
  const lambdaSurface = opts.lambdaSurface ?? 0.20;
  const iterations = opts.iterations ?? 600;
  const lr = opts.learningRate ?? 0.5;

  const obs = loadObservations(tour, opts.before);
  if (obs.length === 0) {
    throw new Error(`Sin observaciones de saque para ${tour}${opts.before ? ` antes de ${opts.before}` : ''}`);
  }
  const last = obs[obs.length - 1].date;

  // Pesos por antigüedad. 1 para todos si no hay decay.
  const weights = obs.map((o) =>
    opts.halfLifeDays ? Math.pow(0.5, daysBetween(o.date, last) / opts.halfLifeDays) : 1,
  );

  const players = new Set<number>();
  for (const o of obs) {
    players.add(o.server);
    players.add(o.returner);
  }
  const ids = [...players];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  // Interceptos por superficie: se arrancan del logit de la media observada, que es el
  // óptimo exacto si todos los jugadores fueran iguales. Un arranque en cero convergería
  // igual pero mucho más despacio.
  const mu: Record<Surface, number> = { Hard: 0, Clay: 0, Grass: 0 };
  for (const s of SURFACES) {
    let k = 0;
    let t = 0;
    for (const [i, o] of obs.entries()) {
      if (o.surface !== s) continue;
      k += o.won * weights[i];
      t += o.played * weights[i];
    }
    mu[s] = t > 0 ? logit(Math.min(0.95, Math.max(0.05, k / t))) : 0;
  }

  const S = new Float64Array(n);
  const R = new Float64Array(n);
  // Desviaciones por superficie: [jugador][superficie]
  const dS = SURFACES.map(() => new Float64Array(n));
  const dR = SURFACES.map(() => new Float64Array(n));
  const surfIdx: Record<Surface, number> = { Hard: 0, Clay: 1, Grass: 2 };

  const gS = new Float64Array(n);
  const gR = new Float64Array(n);
  const gdS = SURFACES.map(() => new Float64Array(n));
  const gdR = SURFACES.map(() => new Float64Array(n));

  // Puntos por jugador, para normalizar el gradiente y para informar después.
  const svPts = new Float64Array(n);
  const rtPts = new Float64Array(n);
  for (const [i, o] of obs.entries()) {
    svPts[idx.get(o.server)!] += o.played * weights[i];
    rtPts[idx.get(o.returner)!] += o.played * weights[i];
  }

  let logLik = 0;
  let iter = 0;
  for (; iter < iterations; iter++) {
    gS.fill(0);
    gR.fill(0);
    for (const g of gdS) g.fill(0);
    for (const g of gdR) g.fill(0);
    logLik = 0;

    for (const [i, o] of obs.entries()) {
      const a = idx.get(o.server)!;
      const b = idx.get(o.returner)!;
      const si = surfIdx[o.surface];
      const w = weights[i];
      const eta = mu[o.surface] + (S[a] + dS[si][a]) - (R[b] + dR[si][b]);
      const p = sigmoid(eta);
      // Gradiente de la binomial: (k − n·p) por cada parámetro que entra en eta.
      const resid = (o.won - o.played * p) * w;
      gS[a] += resid;
      gdS[si][a] += resid;
      gR[b] -= resid;
      gdR[si][b] -= resid;
      logLik += w * (o.won * Math.log(Math.max(p, 1e-12)) + (o.played - o.won) * Math.log(Math.max(1 - p, 1e-12)));
    }

    // Regularización y paso. El gradiente se divide por los puntos del jugador: sin eso,
    // quien tiene 8.000 puntos da pasos mil veces más largos que quien tiene 80 y el
    // aprendizaje se vuelve inestable justo donde más datos hay.
    for (let a = 0; a < n; a++) {
      const wsv = Math.max(svPts[a], 50);
      const wrt = Math.max(rtPts[a], 50);
      S[a] += (lr * (gS[a] - lambda * S[a] * wsv)) / wsv;
      R[a] += (lr * (gR[a] - lambda * R[a] * wrt)) / wrt;
      for (let s = 0; s < 3; s++) {
        gdS[s][a] -= lambdaSurface * dS[s][a] * wsv;
        gdR[s][a] -= lambdaSurface * dR[s][a] * wrt;
        dS[s][a] += (lr * gdS[s][a]) / wsv;
        dR[s][a] += (lr * gdR[s][a]) / wrt;
      }
    }
  }

  const serve = new Map<number, number>();
  const ret = new Map<number, number>();
  const serveSurface = new Map<string, number>();
  const retSurface = new Map<string, number>();
  const servePoints = new Map<number, number>();
  const returnPoints = new Map<number, number>();
  for (const [i, id] of ids.entries()) {
    serve.set(id, S[i]);
    ret.set(id, R[i]);
    servePoints.set(id, svPts[i]);
    returnPoints.set(id, rtPts[i]);
    for (const s of SURFACES) {
      serveSurface.set(key(id, s), dS[surfIdx[s]][i]);
      retSurface.set(key(id, s), dR[surfIdx[s]][i]);
    }
  }

  return {
    tour,
    mu,
    serve,
    ret,
    serveSurface,
    ret_surface: retSurface,
    servePoints,
    returnPoints,
    meta: {
      observations: obs.length,
      players: n,
      iterations: iter,
      logLik,
      lambda,
      lambdaSurface,
    },
  };
}

export interface PointProbs {
  /** P(el jugador 1 gana un punto con su saque) contra este rival y en esta superficie. */
  p1: number;
  /** P(el jugador 2 gana un punto con su saque). */
  p2: number;
  /** Si de alguno no hay datos: sus parámetros valen 0 y el número es el de un jugador medio. */
  unknown1: boolean;
  unknown2: boolean;
  detail: {
    mu: number;
    serve1: number;
    return1: number;
    serve2: number;
    return2: number;
    surfaceDelta1: number;
    surfaceDelta2: number;
  };
}

/**
 * Las dos probabilidades de punto de un enfrentamiento.
 *
 * Un jugador desconocido sale con parámetros a cero, o sea exactamente el jugador medio
 * de esa superficie. Se marca en vez de disimularse: «no sé nada de este» y «este es
 * exactamente del montón» producen el mismo número y son cosas distintas.
 */
export function pointProbs(
  model: PointsModel,
  id1: number,
  id2: number,
  surface: Surface,
): PointProbs {
  const s1 = model.serve.get(id1) ?? 0;
  const r1 = model.ret.get(id1) ?? 0;
  const s2 = model.serve.get(id2) ?? 0;
  const r2 = model.ret.get(id2) ?? 0;
  const ds1 = model.serveSurface.get(key(id1, surface)) ?? 0;
  const dr1 = model.ret_surface.get(key(id1, surface)) ?? 0;
  const ds2 = model.serveSurface.get(key(id2, surface)) ?? 0;
  const dr2 = model.ret_surface.get(key(id2, surface)) ?? 0;
  const mu = model.mu[surface];

  return {
    p1: sigmoid(mu + (s1 + ds1) - (r2 + dr2)),
    p2: sigmoid(mu + (s2 + ds2) - (r1 + dr1)),
    unknown1: !model.serve.has(id1),
    unknown2: !model.serve.has(id2),
    detail: {
      mu,
      serve1: s1,
      return1: r1,
      serve2: s2,
      return2: r2,
      surfaceDelta1: ds1 - dr1,
      surfaceDelta2: ds2 - dr2,
    },
  };
}

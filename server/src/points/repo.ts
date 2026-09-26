// El modelo ajustado, guardado y reutilizado.
//
// ===========================================================================
// AJUSTARLO CUESTA OCHO SEGUNDOS. SERVIRLO NO PUEDE COSTAR OCHO SEGUNDOS
// ===========================================================================
// `fitPoints` recorre 58.000 observaciones y hace 600 iteraciones de descenso. Está bien
// para un script; para una petición HTTP es inaceptable, y para veinte peticiones
// simultáneas es una caída.
//
// Así que se ajusta una vez, se guarda en la base y se sirve desde memoria. El ajuste se
// rehace cuando cambian los datos (lo dispara `update-data`) o cuando alguien lo pide a
// mano.
//
// ===========================================================================
// UN MODELO GUARDADO TIENE QUE DECIR DE CUÁNDO ES
// ===========================================================================
// Un modelo ajustado hace ocho meses sigue devolviendo números perfectamente creíbles
// para jugadores que en ese momento no existían — les da el perfil medio. Por eso se
// guarda `fittedAt` y el número de partidos, y por eso quien lo sirve puede decir que
// está viejo en vez de que el lector lo suponga.

import { getMeta, setMeta } from '../db.ts';
import { fitPoints, type FitOptions, type PointsModel, SURFACES } from './fit.ts';
import type { TourId } from '../types.ts';

const KEY = (tour: TourId): string => `points:model:${tour}`;

/** Forma serializable. Los `Map` no sobreviven a JSON. */
interface Stored {
  tour: string;
  fittedAt: string;
  mu: Record<string, number>;
  serve: [number, number][];
  ret: [number, number][];
  serveSurface: [string, number][];
  retSurface: [string, number][];
  servePoints: [number, number][];
  returnPoints: [number, number][];
  meta: PointsModel['meta'];
}

export interface LoadedModel extends PointsModel {
  fittedAt: string;
  /** Días desde el ajuste. Lo que permite decir «esto está viejo». */
  ageDays: number;
}

let cache: LoadedModel | null = null;

export function saveModel(m: PointsModel): void {
  const stored: Stored = {
    tour: m.tour,
    fittedAt: new Date().toISOString(),
    mu: m.mu,
    serve: [...m.serve],
    ret: [...m.ret],
    serveSurface: [...m.serveSurface],
    retSurface: [...m.ret_surface],
    servePoints: [...m.servePoints],
    returnPoints: [...m.returnPoints],
    meta: m.meta,
  };
  setMeta(KEY(m.tour), JSON.stringify(stored));
  cache = null;
}

/** El modelo guardado, o null si no hay ninguno. NO lo ajusta: eso es explícito. */
export function loadModel(tour: TourId): LoadedModel | null {
  if (cache && cache.tour === tour) return cache;
  const raw = getMeta(KEY(tour));
  if (!raw) return null;
  let s: Stored;
  try {
    s = JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
  const mu = { Hard: 0, Clay: 0, Grass: 0 } as PointsModel['mu'];
  for (const k of SURFACES) mu[k] = s.mu[k] ?? 0;
  const m: LoadedModel = {
    tour: s.tour,
    mu,
    serve: new Map(s.serve),
    ret: new Map(s.ret),
    serveSurface: new Map(s.serveSurface),
    ret_surface: new Map(s.retSurface),
    servePoints: new Map(s.servePoints),
    returnPoints: new Map(s.returnPoints),
    meta: s.meta,
    fittedAt: s.fittedAt,
    ageDays: (Date.now() - Date.parse(s.fittedAt)) / 86_400_000,
  };
  cache = m;
  return m;
}

/** Ajusta y guarda. Lo llama `update-data` y el script del estudio. */
export function refitAndSave(tour: TourId, opts: FitOptions = {}): PointsModel {
  const m = fitPoints(tour, { ...DEFAULT_FIT, ...opts });
  saveModel(m);
  return m;
}

/**
 * Los hiperparámetros que se publican, y de dónde salen.
 *
 * `halfLifeDays: 365` NO es una elección de estilo: en el barrido de
 * `npm run study:points` es la que menos log loss da (0.64957 contra 0.66037 sin decay
 * y 0.65170 con 180 días). Sin decay, el modelo describe una carrera entera y no al
 * jugador que juega mañana.
 */
export const DEFAULT_FIT: FitOptions = { halfLifeDays: 365 };

/**
 * El modelo listo para servir, ajustándolo si no hay ninguno.
 *
 * El ajuste automático solo pasa la PRIMERA vez. Reajustar cada vez que envejece haría
 * que una petición cualquiera se comiera ocho segundos sin avisar, y a quien le tocara no
 * tendría forma de saber por qué.
 */
export function modelForServing(tour: TourId): LoadedModel | null {
  const existing = loadModel(tour);
  if (existing) return existing;
  try {
    refitAndSave(tour);
  } catch {
    return null;
  }
  return loadModel(tour);
}

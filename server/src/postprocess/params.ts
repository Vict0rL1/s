// Los parámetros ajustados de la capa de post-proceso, y de dónde salen.
//
// ===========================================================================
// POR QUÉ UN FICHERO VERSIONADO Y NO LA BASE DE DATOS
// ===========================================================================
// Igual que el registro de experimentos: `data/tennis.db` está en .gitignore y se borra
// al reingerir. Estos números son el RESULTADO de un ajuste que tarda minutos y que se
// hace sobre un tramo concreto de temporadas; si desaparecen al reingerir, la app pasa a
// publicar probabilidades sin calibrar sin que nadie se entere. Versionados, se ven en
// el diff y se sabe cuándo cambiaron y contra qué se midieron.
//
// ===========================================================================
// FALLA ABIERTA, PERO DICIÉNDOLO
// ===========================================================================
// Sin fichero, la capa NO transforma nada y la salida final es igual que la cruda. Es lo
// contrario del módulo de riesgo, que sin medición dimensiona a cero, y la diferencia
// tiene motivo: ahí el valor por defecto arriesga dinero, aquí solo deja de corregir. Lo
// que no se hace nunca es aplicar una calibración inventada.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import type { Isotonic } from './isotonic.ts';
import type { Platt } from './platt.ts';
import type { BlendParams } from './blend.ts';

export const POSTPROCESS_PATH = path.join(ROOT, 'experiments', 'postprocess.json');

/** Cuál de los dos calibradores ganó la comparación fuera de muestra. */
export type CalibratorKind = 'platt' | 'isotonic' | 'ninguno';

export interface SportPostprocess {
  /**
   * Qué calibrador se aplica. 'ninguno' NO es un hueco: significa que se probaron los
   * dos, ninguno mejoró fuera de muestra, y por eso no se aplica ninguno.
   */
  calibrator: CalibratorKind;
  platt?: Platt;
  /** Una curva por resultado (local/empate/visitante, o local/visitante). */
  isotonic?: Isotonic[];
  /**
   * La mezcla con el mercado. `null` cuando no hay cuotas históricas con las que
   * ajustar el peso — y entonces NO se mezcla, porque el encargo era optimizar el peso
   * por backtest, no ponerlo a ojo.
   */
  blend: BlendParams | null;
  /** Qué se midió al elegir todo esto, para poder citarlo sin volver a correr nada. */
  measured: {
    /** Log loss antes y después, fuera de muestra. */
    rawLogLoss: number;
    calibratedLogLoss: number;
    finalLogLoss: number | null;
    n: number;
    split: string;
    /** Por qué la mezcla está apagada, cuando lo está. */
    blendNote?: string;
  };
  measuredAt: string;
}

export type PostprocessFile = Record<string, SportPostprocess>;

export function readPostprocess(): PostprocessFile {
  if (!fs.existsSync(POSTPROCESS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(POSTPROCESS_PATH, 'utf8')) as PostprocessFile;
  } catch {
    return {};
  }
}

export function writePostprocess(f: PostprocessFile): void {
  fs.mkdirSync(path.dirname(POSTPROCESS_PATH), { recursive: true });
  fs.writeFileSync(POSTPROCESS_PATH, JSON.stringify(f, null, 2) + '\n');
}

/**
 * Caché en memoria.
 *
 * Una pantalla de sesenta partidos leería y parsearía el mismo fichero sesenta veces.
 * Se invalida por mtime, así que volver a correr el estudio se nota sin reiniciar.
 */
let cache: { mtime: number; file: PostprocessFile } | null = null;

export function getPostprocess(sport: string): SportPostprocess | null {
  let mtime = 0;
  try {
    mtime = fs.statSync(POSTPROCESS_PATH).mtimeMs;
  } catch {
    return null;
  }
  if (!cache || cache.mtime !== mtime) cache = { mtime, file: readPostprocess() };
  return cache.file[sport] ?? null;
}

export function clearPostprocessCache(): void {
  cache = null;
}

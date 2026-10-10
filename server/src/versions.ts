// Qué versión exacta produjo un número.
//
// ===========================================================================
// POR QUÉ HUELLAS Y NO NÚMEROS DE VERSIÓN
// ===========================================================================
// Un «model_version = 3» depende de que alguien se acuerde de subirlo a 4 cada vez que
// toca una constante, y la historia de este proyecto dice que no pasa: SURFACE_WEIGHT
// estuvo copiado a mano en cinco sitios y dos se quedaron atrás. Una huella del
// CONTENIDO no se puede olvidar: si el código del modelo, su configuración o su
// calibración cambian un byte, la huella cambia sola; si no cambian, no cambia.
//
//   model_version         sha-256 del código del modelo del deporte (sus .ts)
//   model_config_version  sha-256 de config/<deporte>.json
//   calibration_version   sha-256 de experiments/calibration.json + postprocess.json
//   data_version          el último partido y el número de partidos del deporte en la base
//   strategy_version      sha-256 de la política de apuestas (código + configuración)
//   git_commit            el commit del código que está corriendo, si se puede saber
//
// Con eso, «Sinner 71,4 %» de hace seis meses se puede rastrear: se busca el commit, se
// comprueba que el código del modelo en ese commit tiene la misma huella, y se sabe con
// qué calibración y con qué datos se calculó.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { getDb } from './db.ts';

import type { SportId } from './sports.ts';
export type { SportId } from './sports.ts';
export { isSportId } from './sports.ts';

const SRC = path.join(ROOT, 'server', 'src');

/** El código que DEFINE cada modelo. Si se añade un fichero al modelo, va aquí. */
export const MODEL_FILES: Record<SportId, string[]> = {
  tennis: ['model/elo.ts', 'model/predict.ts', 'model/form.ts', 'model/h2h.ts', 'model/reliability.ts', 'model/scoreline.ts', 'model/market.ts'],
  football: ['football/model.ts', 'football/predict.ts', 'football/ratings.ts', 'football/strength.ts', 'football/momentum.ts', 'football/promotion.ts', 'football/bayes/dixonColes.ts', 'football/bayes/walkforward.ts', 'postprocess/apply.ts'],
  basketball: ['basketball/elo.ts', 'basketball/predict.ts', 'basketball/ratings.ts'],
  baseball: ['baseball/model.ts', 'baseball/predict.ts', 'baseball/ratings.ts', 'baseball/parkFactors.ts'],
  nfl: ['nfl/model.ts', 'nfl/predict.ts', 'nfl/ratings.ts', 'postprocess/apply.ts'],
  nhl: ['nhl/model.ts', 'nhl/predict.ts', 'nhl/repo.ts'],
  ufc: ['ufc/model.ts', 'ufc/evaluacion.ts', 'ufc/combinado.ts', 'ufc/predict.ts', 'ufc/repo.ts'],
};
const CONFIG_FILE: Record<SportId, string> = {
  tennis: 'tournaments.json',
  football: 'football.json',
  basketball: 'basketball.json',
  baseball: 'baseball.json',
  nfl: 'americanfootball.json',
  nhl: 'nhl.json',
  ufc: 'ufc.json',
};
const STRATEGY_FILES = ['staking/policy.ts', 'staking/calibration.ts', 'paper/bankroll.ts'];

/** Huella corta de una lista de ficheros. Un fichero que falta cuenta como «(falta)». */
/**
 * La huella de un conjunto de ficheros: sha256 de (ruta relativa al repo, contenido).
 *
 * Relativa y no absoluta: con la ruta absoluta dentro del hash, el MISMO código daba otra
 * versión en cada máquina (/Users/… en un Mac, /home/… en otra), y «qué versión produjo
 * esta predicción» dejaba de poder compararse entre instalaciones.
 */
export function fingerprintDe(entradas: { nombre: string; contenido: Buffer | string | null }[]): string {
  const h = createHash('sha256');
  for (const e of entradas) {
    h.update(e.nombre);
    h.update('\0');
    h.update(e.contenido ?? '(falta)');
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

export function fingerprint(files: string[]): string {
  return fingerprintDe(
    files.map((f) => {
      let contenido: Buffer | null = null;
      try {
        contenido = fs.readFileSync(f);
      } catch {
        contenido = null;
      }
      return { nombre: path.relative(ROOT, f).split(path.sep).join('/'), contenido };
    }),
  );
}

let commit: string | null | undefined;
/** El commit en curso: variable GIT_COMMIT, o `git rev-parse`, o null si no hay git. */
export function gitCommit(): string | null {
  if (commit !== undefined) return commit;
  const fromEnv = process.env.GIT_COMMIT?.trim();
  if (fromEnv) return (commit = fromEnv.slice(0, 12));
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    commit = sha.slice(0, 12);
    // Con cambios sin commitear, el commit NO describe el código que corre: se dice.
    const sucio = execFileSync('git', ['status', '--porcelain', '--', 'server/src', 'config', 'experiments'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (sucio) commit += '+cambios';
  } catch {
    commit = null;
  }
  return commit;
}

const TABLAS_DATOS: Record<SportId, { tabla: string; fecha: string }> = {
  tennis: { tabla: 'matches', fecha: 'tourney_date' },
  football: { tabla: 'fb_matches', fecha: 'match_date' },
  basketball: { tabla: 'bb_games', fecha: 'game_date' },
  baseball: { tabla: 'bsb_games', fecha: 'game_date' },
  nfl: { tabla: 'naf_games', fecha: 'game_date' },
  nhl: { tabla: 'nhl_games', fecha: 'game_date' },
  ufc: { tabla: 'ufc_fights', fecha: 'fecha' },
};

/** La versión de los datos: hasta qué fecha y cuántos partidos hay en la base. */
export function dataVersion(sport: SportId): string {
  const t = TABLAS_DATOS[sport];
  try {
    const r = getDb().prepare(`SELECT MAX(${t.fecha}) AS d, COUNT(*) AS n FROM ${t.tabla}`).get() as { d: string | null; n: number };
    return `${String(r.d ?? 'vacío').replace(/-/g, '').slice(0, 8)}·${r.n}`;
  } catch {
    return 'sin-datos';
  }
}

export interface Versions {
  model_version: string;
  model_config_version: string;
  calibration_version: string;
  data_version: string;
  strategy_version: string;
  git_commit: string | null;
}

/**
 * Las versiones de un deporte, ahora. Las de código y ficheros se calculan una vez por
 * proceso (no cambian mientras corre); la de datos, cada vez, porque la ingesta sí la mueve.
 */
const cache = new Map<SportId, Omit<Versions, 'data_version'>>();
export function versionsFor(sport: SportId): Versions {
  let v = cache.get(sport);
  if (!v) {
    v = {
      model_version: `${sport}-${fingerprint(MODEL_FILES[sport].map((f) => path.join(SRC, f)))}`,
      model_config_version: fingerprint([path.join(ROOT, 'config', CONFIG_FILE[sport])]),
      calibration_version: fingerprint([
        path.join(ROOT, 'experiments', 'calibration.json'),
        path.join(ROOT, 'experiments', 'postprocess.json'),
      ]),
      strategy_version: fingerprint(STRATEGY_FILES.map((f) => path.join(SRC, f))),
      git_commit: gitCommit(),
    };
    cache.set(sport, v);
  }
  return { ...v, data_version: dataVersion(sport) };
}

/** Solo para tests: olvidar lo calculado. */
export function _resetVersionCache(): void {
  cache.clear();
  commit = undefined;
}

/** Las columnas de versión que llevan los registros de predicciones. */
export const VERSION_COLUMNS = ['model_version', 'model_config_version', 'calibration_version', 'data_version', 'git_commit'] as const;

/**
 * Estampa las versiones en una predicción RECIÉN registrada.
 *
 * Solo si el INSERT de verdad insertó (`changes === 1`): los registros son de escritura
 * única (`ON CONFLICT DO NOTHING`), y estampar las versiones de HOY en una predicción de
 * ayer sería inventarle un origen. Las predicciones anteriores a que esto existiera se
 * quedan sin versión, que es la verdad.
 */
export function stampPredictionVersions(
  table: string,
  keyColumn: string,
  key: string,
  sport: SportId,
  inserted: { changes: number | bigint },
): void {
  if (Number(inserted.changes) !== 1) return;
  const v = versionsFor(sport);
  getDb()
    .prepare(
      `UPDATE ${table} SET model_version = ?, model_config_version = ?, calibration_version = ?, data_version = ?, git_commit = ?
       WHERE ${keyColumn} = ? AND model_version IS NULL`,
    )
    .run(v.model_version, v.model_config_version, v.calibration_version, v.data_version, v.git_commit, key);
}

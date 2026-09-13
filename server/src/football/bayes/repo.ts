// Guardar y leer el ajuste de Dixon-Coles.
//
// Los parámetros se ajustan en `update-data:fb` y se leen en cada predicción. No se
// reajusta al predecir a propósito: un ajuste son cientos de milisegundos y una
// petición de la API pide predicciones de sesenta partidos, así que reajustar por
// petición multiplicaría por sesenta un trabajo que solo cambia cuando llegan
// resultados nuevos.

import { getDb, getMeta, setMeta } from '../../db.ts';
import type { DcParams } from './dixonColes.ts';

const KEY = (league: string): string => `fb_dc_${league}`;

interface Serialised {
  mu: number;
  gamma: number;
  rho: number;
  attack: [string, number][];
  defence: [string, number][];
  hyper: DcParams['hyper'];
  matches: number;
  effectiveMatches: number;
  through: string;
}

export function storeDcParams(league: string, p: DcParams | null): void {
  if (!p) {
    setMeta(KEY(league), '');
    return;
  }
  const s: Serialised = {
    mu: p.mu,
    gamma: p.gamma,
    rho: p.rho,
    attack: [...p.attack],
    defence: [...p.defence],
    hyper: p.hyper,
    matches: p.matches,
    effectiveMatches: p.effectiveMatches,
    through: p.through,
  };
  setMeta(KEY(league), JSON.stringify(s));
}

/**
 * Caché en memoria por liga.
 *
 * Sin ella, una pantalla con sesenta partidos parsea el mismo JSON de ~40 equipos
 * sesenta veces. La clave incluye el `through` guardado, así que una reingesta —que
 * cambia esa fecha— invalida la entrada sola.
 */
const cache = new Map<string, { raw: string; params: DcParams }>();

export function getDcParams(league: string): DcParams | null {
  const raw = getMeta(KEY(league));
  if (!raw) return null;
  const hit = cache.get(league);
  if (hit && hit.raw === raw) return hit.params;
  try {
    const s = JSON.parse(raw) as Serialised;
    const params: DcParams = {
      mu: s.mu,
      gamma: s.gamma,
      rho: s.rho,
      attack: new Map(s.attack),
      defence: new Map(s.defence),
      hyper: s.hyper,
      matches: s.matches,
      effectiveMatches: s.effectiveMatches,
      through: s.through,
    };
    cache.set(league, { raw, params });
    return params;
  } catch {
    return null;
  }
}

/**
 * ¿Tiene este equipo partidos dentro del ajuste?
 *
 * Es la pregunta que decide si se puede usar el modelo o hay que caer al camino de
 * siempre. Un equipo AUSENTE del ajuste recibiría ataque 0 y defensa 0, que en este
 * modelo significa «exactamente la media de la liga» — y para un recién ascendido eso
 * es demasiado generoso: no es un equipo medio de su nueva categoría, es el que acaba
 * de subir. Esa situación la resuelve bien el Elo, con el salto de división medido en
 * promotion.ts, así que ahí se usa aquel camino.
 */
export function dcKnowsTeam(p: DcParams | null, teamId: string): boolean {
  return !!p && p.attack.has(teamId);
}

/**
 * ¿Se puede predecir ESTE partido con el ajuste? La regla, escrita una sola vez.
 *
 * La usan producción (`predict.ts`), el backtest y los estudios. Tres copias de «si el
 * ajuste conoce a los dos» son tres sitios donde la condición puede acabar siendo
 * distinta — y si el backtest usa el Dixon-Coles en un partido donde producción cae al
 * Elo, el número medido deja de describir lo que ve el usuario.
 */
export function dcUsableFor(p: DcParams | null, homeId: string, awayId: string): boolean {
  return dcKnowsTeam(p, homeId) && dcKnowsTeam(p, awayId);
}

/** Cuántos equipos de la liga cubre el ajuste. Para diagnósticos. */
export function dcCoverage(league: string): { teams: number; through: string } | null {
  const p = getDcParams(league);
  if (!p) return null;
  return { teams: p.attack.size, through: p.through };
}

/** Limpia la caché. Solo lo necesitan los tests y la reingesta. */
export function clearDcCache(): void {
  cache.clear();
  void getDb;
}

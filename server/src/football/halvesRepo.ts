// Guardar y leer el ajuste de las dos mitades.
//
// Aparte del de `bayes/repo.ts` porque son DOS DcParams y no uno, y meterlos en la misma
// clave obligaría a que aquel supiera de mitades. El formato serializado es el mismo —
// los Map de ataque y defensa como pares— así que la conversión vive aquí una sola vez.

import { getMeta, setMeta } from '../db.ts';
import type { DcParams } from './bayes/dixonColes.ts';
import type { HalfParams } from './halves.ts';

const KEY = (league: string): string => `fb_halves_${league}`;

interface SerialisedDc {
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

const dump = (p: DcParams): SerialisedDc => ({
  mu: p.mu,
  gamma: p.gamma,
  rho: p.rho,
  attack: [...p.attack],
  defence: [...p.defence],
  hyper: p.hyper,
  matches: p.matches,
  effectiveMatches: p.effectiveMatches,
  through: p.through,
});

const load = (s: SerialisedDc): DcParams => ({
  ...s,
  attack: new Map(s.attack),
  defence: new Map(s.defence),
});

export function storeHalfParams(league: string, p: HalfParams | null): void {
  setMeta(KEY(league), p ? JSON.stringify({ first: dump(p.first), second: dump(p.second) }) : '');
}

/** Caché por liga, invalidada por el propio JSON — igual que el ajuste del partido. */
const cache = new Map<string, { raw: string; params: HalfParams }>();

export function getHalfParams(league: string): HalfParams | null {
  const raw = getMeta(KEY(league));
  if (!raw) return null;
  const hit = cache.get(league);
  if (hit && hit.raw === raw) return hit.params;
  try {
    const s = JSON.parse(raw) as { first: SerialisedDc; second: SerialisedDc };
    const params: HalfParams = { first: load(s.first), second: load(s.second) };
    cache.set(league, { raw, params });
    return params;
  } catch {
    return null;
  }
}

export function clearHalvesCache(): void {
  cache.clear();
}

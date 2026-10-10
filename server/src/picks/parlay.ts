// Combinadas con correlación (Fase 4.8).
//
// «Mi selección» multiplicaba las probabilidades como si los partidos fueran independientes.
// No lo son del todo: dos patas del mismo partido se pisan, y dos partidos de la misma liga
// y día comparten un poco de suerte (staking/correlation.ts lo midió: ρ ≈ 0,001, casi
// nada; dentro del mismo partido, mucho). Aquí la probabilidad conjunta descuenta esa
// correlación con la corrección por pares
//
//     P(A ∧ B) = p_A · p_B · (1 + ρ · √(q_A q_B / (p_A p_B)))
//
// que es exacta para dos sucesos binarios con esa ρ, y para más patas se aplica par a
// par (aproximación: con ρ pequeñas el error es de segundo orden). Dos selecciones del
// mismo partido son incompatibles: conjunta 0, y se dice. Todo etiquetado como
// aproximación; nunca se escribe en el libro mayor.
//
// ENTRE PARTIDOS DISTINTOS, ρ = 0 (lote C, C1). La ρ de «misma liga y día» que usa el libro
// manual para DIMENSIONAR es el extremo alto del intervalo medido (0,0047; punto 0,0013,
// intervalo que incluye el cero): prudente para recortar importes, pero aquí MULTIPLICABA la
// probabilidad conjunta (con dos patas al 10 %, un 4 % por par; con diez patas de la misma
// jornada, ×6). La conjunta entre partidos distintos es el producto, y la corrección solo
// puede recortar (factor ≤ 1): lo único que la mueve hacia arriba sería una ρ positiva medida
// con el intervalo entero por encima de cero, que no existe.

import { correlation, type Position } from '../staking/correlation.ts';
import type { SportId } from '../sports.ts';

export interface Pata {
  sport: SportId;
  matchKey: string;
  liga: string | null;
  /** ISO del partido. */
  cuando: string;
  seleccion: string;
  /** Índice de la selección (0 = local / primero; último = visitante / segundo). */
  indice: number;
  /** Cuántos resultados tiene el mercado (2 o 3). */
  resultados: number;
  p: number;
  cuota: number | null;
}

export interface Vinculo {
  a: string;
  b: string;
  rho: number;
  motivo: string;
}

export interface Combinada {
  patas: number;
  /** Π p: como si fueran independientes. */
  independiente: number;
  /** Con la corrección por pares. */
  conjunta: number;
  factorCorrelacion: number;
  vinculos: Vinculo[];
  /** Patas que no pueden cumplirse a la vez (dos selecciones del mismo partido). */
  incompatibles: string[];
  cuotaCombinada: number | null;
  cuotaJusta: number | null;
  ventaja: number | null;
  etiqueta: string;
}

export const ETIQUETA_COMBINADA =
  'Aproximación: entre partidos distintos la correlación medida (misma liga y día) es indistinguible de cero y se usa cero: la conjunta es el producto; ' +
  'dos selecciones del mismo partido son incompatibles. La corrección nunca sube la probabilidad. No es una predicción publicada.';

export function posicionDe(x: Pata): Position {
  return {
    key: `${x.sport}|${x.matchKey}|${x.indice}`,
    matchKey: `${x.sport}|${x.matchKey}`,
    league: x.liga ?? x.sport,
    day: x.cuando.slice(0, 10),
    market: '1x2',
    side: x.indice === 0 ? 'canonica' : x.indice === x.resultados - 1 ? 'contraria' : 'otro',
    fraction: 0,
  };
}

export function validarPatas(xs: unknown): Pata[] {
  if (!Array.isArray(xs) || xs.length === 0 || xs.length > 20) throw new Error('entre 1 y 20 patas');
  return xs.map((x, i) => {
    const o = x as Record<string, unknown>;
    const p = Number(o.p);
    if (!(p > 0 && p < 1)) throw new Error(`pata ${i + 1}: probabilidad fuera de (0, 1)`);
    const cuota = o.cuota == null ? null : Number(o.cuota);
    if (cuota != null && !(cuota > 1)) throw new Error(`pata ${i + 1}: cuota inválida`);
    if (typeof o.matchKey !== 'string' || !o.matchKey) throw new Error(`pata ${i + 1}: sin matchKey`);
    const cuando = typeof o.cuando === 'string' && Number.isFinite(Date.parse(o.cuando)) ? o.cuando : null;
    if (!cuando) throw new Error(`pata ${i + 1}: fecha inválida`);
    const resultados = Number(o.resultados) === 3 ? 3 : 2;
    const indice = Math.min(Math.max(0, Math.trunc(Number(o.indice) || 0)), resultados - 1);
    return {
      sport: String(o.sport) as SportId,
      matchKey: o.matchKey,
      liga: typeof o.liga === 'string' ? o.liga : null,
      cuando,
      seleccion: typeof o.seleccion === 'string' ? o.seleccion : `selección ${indice + 1}`,
      indice,
      resultados,
      p,
      cuota,
    };
  });
}

export function combinada(patasEntrada: Pata[]): Combinada {
  // Una misma selección dos veces es una sola pata.
  const vistas = new Set<string>();
  const patas = patasEntrada.filter((x) => {
    const k = posicionDe(x).key;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
  const independiente = patas.reduce((a, x) => a * x.p, 1);
  const vinculos: Vinculo[] = [];
  const incompatibles = new Set<string>();
  let factor = 1;
  for (let i = 0; i < patas.length; i++) {
    for (let j = i + 1; j < patas.length; j++) {
      const a = patas[i];
      const b = patas[j];
      if (a.sport === b.sport && a.matchKey === b.matchKey) {
        incompatibles.add(`${a.seleccion} y ${b.seleccion} son del mismo partido: no pueden darse las dos`);
        continue;
      }
      const c = correlation(posicionDe(a), posicionDe(b));
      if (c.rho === 0) continue;
      // Entre partidos distintos, cero: la ρ medida no se distingue de cero y la de `correlation`
      // es el extremo prudente para dimensionar, no para multiplicar probabilidades.
      const rho = a.matchKey !== b.matchKey || a.sport !== b.sport ? 0 : Math.min(0, c.rho);
      vinculos.push({ a: a.seleccion, b: b.seleccion, rho, motivo: rho === 0 ? `partidos distintos: ρ medida indistinguible de cero (${c.reason}); se usa 0` : c.reason });
      factor *= 1 + rho * Math.sqrt(((1 - a.p) * (1 - b.p)) / (a.p * b.p));
    }
  }
  // La corrección solo recorta: nunca por encima de la independencia.
  factor = Math.max(0, Math.min(1, factor));
  const minP = patas.reduce((m, x) => Math.min(m, x.p), 1);
  const conjunta = incompatibles.size ? 0 : Math.max(0, Math.min(minP, independiente * factor));
  const conCuota = patas.length > 0 && patas.every((x) => x.cuota != null);
  const cuotaCombinada = conCuota ? patas.reduce((a, x) => a * (x.cuota as number), 1) : null;
  return {
    patas: patas.length,
    independiente,
    conjunta,
    factorCorrelacion: incompatibles.size ? 0 : factor,
    vinculos,
    incompatibles: [...incompatibles],
    cuotaCombinada,
    cuotaJusta: conjunta > 0 ? 1 / conjunta : null,
    ventaja: cuotaCombinada != null && conjunta > 0 ? conjunta * cuotaCombinada - 1 : null,
    etiqueta: ETIQUETA_COMBINADA,
  };
}

// CLV histórico: lo que habría pasado apostando a la cuota temprana de Pinnacle (PS) en los
// partidos donde el modelo veía valor, medido contra el cierre de la misma casa (PSC).
//
// football-data.co.uk publica las dos para cada partido desde 2019 (antes, solo una). La
// diferencia entre ambas es la medida más limpia de «¿el modelo ve lo que el mercado acaba
// viendo?» que se puede sacar de un archivo: no depende de resultados (que tienen varianza)
// sino de hacia dónde se movió el precio. Un CLV medio positivo con cientos de apuestas
// significa que el modelo se adelanta al mercado; uno negativo, que llega tarde.
//
// Las probabilidades de Pinnacle se obtienen con Shin, no con el multiplicativo que usa el
// resto del proyecto. No es una excepción caprichosa: aquí se compara una casa consigo misma,
// y Shin modela justo el sesgo favorito-perdedor de un libro individual; en el estudio
// `npm run study:devig` los tres métodos empatan en log loss, así que elegir Shin aquí no
// mueve ninguna probabilidad publicada (regla del proyecto) y sí respeta la literatura
// sobre cuotas de cierre.

import { devigShin } from '../market/devig.ts';
import { VALUE_THRESHOLD } from '../model/market.ts';
import { roiDe } from '../evaluation/roi.ts';

export interface PartidoConPinnacle {
  /** Probabilidades del modelo [local, empate, visitante]. */
  modelo: number[];
  /** Cuotas tempranas de Pinnacle. */
  ps: [number, number, number];
  /** Cuotas de cierre de Pinnacle. */
  psc: [number, number, number];
  /** 0 local, 1 empate, 2 visitante. */
  y: number;
}

export interface ApuestaClv {
  seleccion: 0 | 1 | 2;
  cuotaApuesta: number;
  cuotaCierre: number;
  /** cuota apostada / cuota de cierre − 1: positivo si el cierre acortó la selección. */
  clv: number;
  /** Beneficio a 1 unidad sobre la cuota apostada. */
  beneficio: number;
  edge: number;
}

export interface ResumenClv {
  n: number;
  clvMedio: number | null;
  positivos: number;
  /** Beneficio total a 1 unidad por apuesta y ROI. */
  beneficio: number;
  roi: number | null;
  /** Cuántos partidos tenían las dos cuotas (aunque el modelo no viera valor). */
  conAmbas: number;
}

export function shin1X2(odds: [number, number, number]): number[] | null {
  if (odds.some((o) => !(o > 1))) return null;
  return devigShin(odds).probs;
}

/** La selección con más valor contra la cuota temprana, si supera el umbral; si no, ninguna. */
export function elegirApuesta(p: PartidoConPinnacle, umbral = VALUE_THRESHOLD): ApuestaClv | null {
  const mercado = shin1X2(p.ps);
  if (!mercado) return null;
  let mejor: ApuestaClv | null = null;
  for (const i of [0, 1, 2] as const) {
    const edge = p.modelo[i] - mercado[i];
    if (edge < umbral) continue;
    if (!(p.psc[i] > 1)) continue;
    const a: ApuestaClv = {
      seleccion: i,
      cuotaApuesta: p.ps[i],
      cuotaCierre: p.psc[i],
      clv: p.ps[i] / p.psc[i] - 1,
      beneficio: p.y === i ? p.ps[i] - 1 : -1,
      edge,
    };
    if (!mejor || a.edge > mejor.edge) mejor = a;
  }
  return mejor;
}

export function clvHistorico(partidos: PartidoConPinnacle[], umbral = VALUE_THRESHOLD): ResumenClv {
  let n = 0;
  let sumaClv = 0;
  let positivos = 0;
  let beneficio = 0;
  let conAmbas = 0;
  for (const p of partidos) {
    if (p.ps.some((o) => !(o > 1)) || p.psc.some((o) => !(o > 1))) continue;
    conAmbas++;
    const a = elegirApuesta(p, umbral);
    if (!a) continue;
    n++;
    sumaClv += a.clv;
    if (a.clv > 0) positivos++;
    beneficio += a.beneficio;
  }
  // Una unidad por apuesta: lo arriesgado es n.
  return { n, clvMedio: n ? sumaClv / n : null, positivos, beneficio, roi: roiDe(beneficio, n), conAmbas };
}

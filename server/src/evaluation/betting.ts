// El lado del DINERO de la evaluación en vivo: lo que el banco de papel prometía, lo que
// dio, y dónde.
//
// La evaluación de probabilidades (metrics.ts, live.ts) dice si el modelo acierta
// probabilidades. Esto mira las apuestas, que son otra cosa: una muestra ELEGIDA, justo
// donde el modelo discrepa del mercado. Ahí es donde un modelo demasiado seguro de sí
// mismo se nota primero, y por eso se mide aparte:
//
//   · prometido contra realizado   cada apuesta se hizo con una ventaja (p·cuota − 1). Si
//                                  el modelo tiene razón, el ROI realizado se parece a la
//                                  media de esas ventajas. Si va sistemáticamente por
//                                  debajo, el modelo sobrestima su ventaja (validation.ts
//                                  lo prueba con su intervalo).
//   · por tramos                   deporte, cuota y ventaja. Una ventaja del 15 % que no le
//                                  gana al cierre más que una del 3 % no es más ventaja: es
//                                  un partido que el modelo conoce mal.
//   · drawdown y racha             lo que habría que aguantar para ver el ROI.
//
// Solo apuestas y señales EN VIVO (paper_bets, edge_signals). Ningún backtest.

import { getDb } from '../db.ts';
import { BANCO_INICIAL } from '../paper/bankroll.ts';
import { MIN_N, probarMedia, type Prueba } from './validation.ts';
import { avisoMuestra, type AvisoMuestra } from './sample.ts';
import { roiDe } from './roi.ts';

export interface Tramo {
  etiqueta: string;
  /** Apuestas ganadas o perdidas (los empates devueltos no informan del rendimiento). */
  n: number;
  arriesgado: number;
  beneficio: number;
  roi: number | null;
  /** Lo que el modelo esperaba ganar por unidad arriesgada, con la ventaja con que apostó. */
  roiPrometido: number | null;
  clvMedio: number | null;
  conCierre: number;
  /** ⚠ cuando el número de apuestas no permite concluir (ver sample.ts). */
  aviso: AvisoMuestra;
}

export interface Rendimiento {
  total: Tramo;
  aciertos: number;
  /** Los que se esperaban con las probabilidades del modelo: Σ p. */
  aciertosEsperados: number | null;
  /** La mayor caída del banco desde un máximo, en orden de liquidación. */
  drawdown: { importe: number; pct: number; desde: string | null; hasta: string | null } | null;
  /** La racha más larga de apuestas perdidas seguidas. */
  peorRacha: number;
  porDeporte: Tramo[];
  porCuota: Tramo[];
  porEdge: Tramo[];
  /** CLV de TODAS las señales con ventaja, por tramo de ventaja: más muestra que las apuestas. */
  senalesPorEdge: (Prueba & { etiqueta: string })[];
  /** Lo que dicen los tramos de señales, en una frase, o null si no hay muestra. */
  lecturaEdge: string | null;
}

/** Tramos de cuota: favorito claro, parejo, no favorito, sorpresa. */
export const TRAMOS_CUOTA: [number, number, string][] = [
  [1, 1.8, 'cuota < 1,80'],
  [1.8, 2.5, '1,80 – 2,50'],
  [2.5, 4, '2,50 – 4,00'],
  [4, Infinity, 'cuota ≥ 4,00'],
];
/** Tramos de ventaja (p·cuota − 1) al apostar. */
export const TRAMOS_EDGE: [number, number, string][] = [
  [0, 0.03, 'ventaja < 3 %'],
  [0.03, 0.06, '3 – 6 %'],
  [0.06, 0.1, '6 – 10 %'],
  [0.1, Infinity, 'ventaja ≥ 10 %'],
];

interface Fila {
  sport: string;
  odds: number;
  stake: number;
  profit: number;
  status: string;
  settled_at: string | null;
  p: number | null;
  edge: number | null;
  clv: number | null;
}

/** La ventaja con que se apostó: la guardada, o la que sale de p y la cuota si es anterior a guardarla. */
const ventaja = (a: Fila) => (a.edge != null ? a.edge : a.p != null ? a.p * a.odds - 1 : null);

export function tramo(etiqueta: string, xs: Fila[]): Tramo {
  const arriesgado = xs.reduce((s, a) => s + a.stake, 0);
  const beneficio = xs.reduce((s, a) => s + a.profit, 0);
  const conVentaja = xs.filter((a) => ventaja(a) != null);
  const arriesgadoV = conVentaja.reduce((s, a) => s + a.stake, 0);
  const cierre = xs.filter((a) => a.clv != null);
  return {
    etiqueta,
    n: xs.length,
    arriesgado,
    beneficio,
    roi: roiDe(beneficio, arriesgado),
    // Ponderado por importe, como el ROI: si no, una apuesta de 2 € y otra de 40 € pesarían igual.
    roiPrometido: arriesgadoV > 0 ? conVentaja.reduce((s, a) => s + a.stake * (ventaja(a) as number), 0) / arriesgadoV : null,
    clvMedio: cierre.length ? cierre.reduce((s, a) => s + (a.clv as number), 0) / cierre.length : null,
    conCierre: cierre.length,
    aviso: avisoMuestra(xs.length, 'apuestas'),
  };
}

function porTramos(xs: Fila[], tramos: [number, number, string][], valor: (a: Fila) => number | null): Tramo[] {
  return tramos
    .map(([lo, hi, etiqueta]) => tramo(etiqueta, xs.filter((a) => {
      const v = valor(a);
      return v != null && v >= lo && v < hi;
    })))
    .filter((t) => t.n > 0);
}

/** Mayor caída desde un máximo, recorriendo el banco en orden de liquidación. */
export function maxDrawdown(xs: { profit: number; settled_at: string | null }[], inicial = BANCO_INICIAL): Rendimiento['drawdown'] {
  if (!xs.length) return null;
  let banco = inicial;
  let pico = inicial;
  let picoEn: string | null = null;
  let peor = { importe: 0, pct: 0, desde: null as string | null, hasta: null as string | null };
  for (const a of xs) {
    banco += a.profit;
    if (banco > pico) {
      pico = banco;
      picoEn = a.settled_at;
    }
    const caida = pico - banco;
    if (caida > peor.importe) peor = { importe: caida, pct: caida / pico, desde: picoEn, hasta: a.settled_at };
  }
  return peor;
}

export function peorRacha(xs: { status: string }[]): number {
  let racha = 0;
  let peor = 0;
  for (const a of xs) {
    if (a.status === 'lost') peor = Math.max(peor, ++racha);
    else if (a.status === 'won') racha = 0;
  }
  return peor;
}

const pp = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;

export function rendimientoEnVivo(): Rendimiento {
  const db = getDb();
  // Orden de liquidación: es el orden en que el banco subió y bajó de verdad.
  const liquidadas = db
    .prepare(
      `SELECT sport, odds, stake, profit, status, settled_at, COALESCE(model_probability_calibrated, p_model) AS p, edge, clv
         FROM paper_bets WHERE status NOT IN ('pending') AND profit IS NOT NULL
        ORDER BY settled_at, id`,
    )
    .all() as unknown as Fila[];
  // El drawdown recorre TODO lo liquidado (un empate devuelto no mueve el banco, pero está);
  // el rendimiento, solo lo que se ganó o perdió.
  const xs = liquidadas.filter((a) => a.status === 'won' || a.status === 'lost');
  const conP = xs.filter((a) => a.p != null);
  const deportes = [...new Set(xs.map((a) => a.sport))].sort();

  // Señales: la muestra grande. ¿Le gana al cierre más una ventaja grande que una pequeña?
  const senales = db
    .prepare('SELECT edge, clv FROM edge_signals WHERE edge > 0 AND clv IS NOT NULL')
    .all() as { edge: number; clv: number }[];
  const senalesPorEdge = TRAMOS_EDGE.map(([lo, hi, etiqueta]) => ({
    etiqueta,
    ...probarMedia(senales.filter((s) => s.edge >= lo && s.edge < hi).map((s) => s.clv), `CLV de las señales con ${etiqueta}`, true, pp),
  }));
  const conMuestra = senalesPorEdge.filter((t) => t.n >= MIN_N && t.lo != null && t.hi != null);
  let lecturaEdge: string | null = null;
  if (conMuestra.length >= 2) {
    // Se comparan el tramo más bajo y el más alto con muestra. Solo se afirma algo si los
    // intervalos no se tocan: dos medias distintas con intervalos solapados son ruido.
    const menor = conMuestra[0];
    const mayor = conMuestra[conMuestra.length - 1];
    const cifras = `(${mayor.etiqueta}: ${pp(mayor.media as number)}; ${menor.etiqueta}: ${pp(menor.media as number)})`;
    lecturaEdge =
      (mayor.lo as number) > (menor.hi as number)
        ? `Las ventajas grandes le ganan más al cierre que las pequeñas ${cifras}: el tamaño de la ventaja informa.`
        : (mayor.hi as number) < (menor.lo as number)
          ? `Las ventajas grandes le ganan MENOS al cierre que las pequeñas ${cifras}: una ventaja grande es sobre todo ` +
            'un partido que el modelo conoce mal, no más ventaja.'
          : `Con esta muestra, las ventajas grandes y las pequeñas no se distinguen frente al cierre ${cifras}.`;
  } else if (senales.length > 0) {
    lecturaEdge = `Hacen falta al menos ${MIN_N} señales con cierre en dos tramos de ventaja para compararlos (hay ${senales.length} en total).`;
  }

  return {
    total: tramo('total', xs),
    aciertos: xs.filter((a) => a.status === 'won').length,
    aciertosEsperados: conP.length === xs.length && xs.length ? conP.reduce((s, a) => s + (a.p as number), 0) : null,
    drawdown: maxDrawdown(liquidadas),
    peorRacha: peorRacha(liquidadas),
    porDeporte: deportes.map((d) => tramo(d, xs.filter((a) => a.sport === d))),
    porCuota: porTramos(xs, TRAMOS_CUOTA, (a) => a.odds),
    porEdge: porTramos(xs, TRAMOS_EDGE, ventaja),
    senalesPorEdge,
    lecturaEdge,
  };
}

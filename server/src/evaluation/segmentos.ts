// Acierto por segmento, en vivo (Fase 4.4).
//
// El walk-forward ya parte el backtest por segmentos (liga, descanso, abridor, favorito,
// banda, mes, día…). Esto hace lo mismo con lo que el modelo dijo EN VIVO y con lo que
// rindieron las apuestas de papel (CLV), que es otra pregunta: no «¿acertó?» sino «¿pilló
// precio antes de que el mercado se moviera?».
//
// Cada celda se publica solo con muestra: ≥ 100 predicciones para acierto y Brier, ≥ 30
// apuestas para el CLV (los umbrales de evaluation/sample.ts). Por debajo se dice cuántas
// hay y nada más: una celda con 12 partidos y «83 % de acierto» es ruido con etiqueta.

import { getDb } from '../db.ts';
import { predicciones, type PrediccionEnVivo } from './live.ts';
import { accuracy, brier, logLoss } from './metrics.ts';
import { bandaDe } from './walkforward.ts';
import { UMBRALES_MUESTRA } from './sample.ts';
import type { SportId } from '../sports.ts';
import { roiDe } from './roi.ts';

export const MIN_CELDA_PREDICCIONES = UMBRALES_MUESTRA.predicciones.insuficiente;
export const MIN_CELDA_APUESTAS = UMBRALES_MUESTRA.apuestas.insuficiente;

export interface CeldaPrediccion {
  n: number;
  /** Null por debajo del umbral: la celda existe pero no se concluye nada. */
  acierto: number | null;
  brier: number | null;
  logLoss: number | null;
  publicada: boolean;
}

export interface CeldaApuestas {
  n: number;
  /** Apuestas con cierre observado (solo esas tienen CLV). */
  conCierre: number;
  clvMedio: number | null;
  roi: number | null;
  publicada: boolean;
}

export interface Segmentos {
  deporte: SportId;
  generado: string;
  predicciones: { n: number; dimensiones: Record<string, Record<string, CeldaPrediccion>> };
  apuestas: { n: number; dimensiones: Record<string, Record<string, CeldaApuestas>> };
  umbrales: { predicciones: number; apuestas: number };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function mesDe(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const m = Number(iso.slice(5, 7));
  return m >= 1 && m <= 12 ? MESES[m - 1] : undefined;
}
function diaDe(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DIAS[new Date(t).getUTCDay()] : undefined;
}

/**
 * Las dimensiones de una predicción en vivo. El tenis no tiene local: «primero/segundo».
 * Todas se saben ANTES del partido (lote C, C9): segmentar por el desenlace («ganó el
 * visitante») describía lo que pasó y no seleccionaba nada; `lado` es el lado que favoreció el
 * modelo, con la misma forma que en las apuestas.
 */
export function dimensionesPrediccion(deporte: SportId, x: PrediccionEnVivo): Record<string, string | undefined> {
  const lados = deporte === 'tennis' ? ['el primero', 'el segundo'] : x.p.length === 3 ? ['el local', 'empate', 'el visitante'] : ['el local', 'el visitante'];
  const aLados = deporte === 'tennis' ? ['al primero', 'al segundo'] : x.p.length === 3 ? ['al local', 'al empate', 'al visitante'] : ['al local', 'al visitante'];
  const fav = x.p.indexOf(Math.max(...x.p));
  return {
    liga: x.liga ?? undefined,
    favorito: fav === 1 && x.p.length === 3 ? 'empate favorito' : `${lados[fav]} favorito`,
    lado: aLados[fav],
    'banda de probabilidad': bandaDe(x.p),
    mes: mesDe(x.cuando),
    'día de la semana': diaDe(x.cuando),
  };
}

interface ApuestaFila {
  league: string | null;
  label: string;
  selection: string;
  p_model: number;
  commence_time: string | null;
  placed_at: string;
  clv: number | null;
  profit: number | null;
  stake: number;
  status: string;
}

/** Las dimensiones de una apuesta de papel. Local/visitante sale de la etiqueta del partido. */
export function dimensionesApuesta(deporte: SportId, a: ApuestaFila): Record<string, string | undefined> {
  const arroba = deporte === 'nfl' || deporte === 'nhl';
  const sep = arroba ? ' @ ' : ' vs ';
  const partes = a.label.split(sep);
  const local = partes.length === 2 ? (arroba ? partes[1] : partes[0]) : null;
  const visitante = partes.length === 2 ? (arroba ? partes[0] : partes[1]) : null;
  const lado =
    deporte === 'tennis'
      ? a.selection === partes[0] ? 'al primero' : a.selection === partes[1] ? 'al segundo' : undefined
      : a.selection === local ? 'al local' : a.selection === visitante ? 'al visitante' : /empate|draw/i.test(a.selection) ? 'al empate' : undefined;
  const cuando = a.commence_time ?? a.placed_at;
  return {
    liga: a.league ?? undefined,
    favorito: a.p_model >= 0.5 ? 'al favorito' : 'contra el favorito',
    lado,
    'banda de probabilidad': bandaDe([a.p_model, 1 - a.p_model]),
    mes: mesDe(cuando),
    'día de la semana': diaDe(cuando),
  };
}

function agrupar<T>(xs: T[], dims: (x: T) => Record<string, string | undefined>): Record<string, Record<string, T[]>> {
  const out: Record<string, Record<string, T[]>> = {};
  for (const x of xs) {
    for (const [dim, valor] of Object.entries(dims(x))) {
      if (valor == null) continue;
      (out[dim] ??= {})[valor] ??= [];
      out[dim][valor].push(x);
    }
  }
  return out;
}

export function celdaPrediccion(xs: PrediccionEnVivo[]): CeldaPrediccion {
  const publicada = xs.length >= MIN_CELDA_PREDICCIONES;
  return {
    n: xs.length,
    acierto: publicada ? accuracy(xs) : null,
    brier: publicada ? brier(xs) : null,
    logLoss: publicada ? logLoss(xs) : null,
    publicada,
  };
}

export function celdaApuestas(xs: ApuestaFila[]): CeldaApuestas {
  const conClv = xs.filter((a) => a.clv != null);
  const liquidadas = xs.filter((a) => a.status !== 'pending' && a.profit != null);
  const publicada = conClv.length >= MIN_CELDA_APUESTAS;
  const stake = liquidadas.reduce((s, a) => s + a.stake, 0);
  return {
    n: xs.length,
    conCierre: conClv.length,
    clvMedio: publicada ? conClv.reduce((s, a) => s + (a.clv as number), 0) / conClv.length : null,
    roi: liquidadas.length >= MIN_CELDA_APUESTAS ? roiDe(liquidadas.reduce((s, a) => s + (a.profit as number), 0), stake) : null,
    publicada,
  };
}

function apuestasDe(deporte: SportId): ApuestaFila[] {
  try {
    return getDb()
      .prepare(
        `SELECT league, label, selection, p_model, commence_time, placed_at, clv, profit, stake, status
           FROM paper_bets WHERE sport = ? ORDER BY id`,
      )
      .all(deporte) as unknown as ApuestaFila[];
  } catch {
    return [];
  }
}

const aCeldas = <T, C>(g: Record<string, Record<string, T[]>>, f: (xs: T[]) => C): Record<string, Record<string, C>> =>
  Object.fromEntries(Object.entries(g).map(([dim, vs]) => [dim, Object.fromEntries(Object.entries(vs).map(([v, xs]) => [v, f(xs)]))]));

export function segmentos(deporte: SportId, xs: PrediccionEnVivo[] = predicciones(deporte), apuestas: ApuestaFila[] = apuestasDe(deporte)): Segmentos {
  return {
    deporte,
    generado: new Date().toISOString(),
    predicciones: { n: xs.length, dimensiones: aCeldas(agrupar(xs, (x) => dimensionesPrediccion(deporte, x)), celdaPrediccion) },
    apuestas: { n: apuestas.length, dimensiones: aCeldas(agrupar(apuestas, (a) => dimensionesApuesta(deporte, a)), celdaApuestas) },
    umbrales: { predicciones: MIN_CELDA_PREDICCIONES, apuestas: MIN_CELDA_APUESTAS },
  };
}

// El reajuste periódico del Dixon-Coles, para medirlo sin mirar el futuro.
//
// ===========================================================================
// POR QUÉ ESTO ES UN FICHERO Y NO UN BUCLE COPIADO EN CADA SCRIPT
// ===========================================================================
// Un backtest de Elo es directo: los ratings se actualizan partido a partido y cuando
// llegas a uno, solo han visto los anteriores. Un Dixon-Coles se AJUSTA sobre un bloque
// de historia, así que hay que decidir cada cuánto se reajusta — y ahí es facilísimo
// hacer trampa sin querer. Basta ajustar una vez con el archivo entero y puntuar sobre
// él para publicar un número precioso que no significa nada.
//
// La regla está escrita una sola vez, aquí: cada reajuste usa SOLO partidos
// estrictamente anteriores a la fecha que se va a predecir. Dos scripts con dos copias
// del bucle son dos sitios donde esa regla se puede romper por separado, y el estudio
// (`study:dc`) y el backtest (`backtest:fb`) tienen que medir exactamente lo mismo o la
// comparación entre sus salidas no dice nada.

import { fitDixonColes, type DcHyper, type DcMatch, type DcParams } from './dixonColes.ts';

/** Cada cuántos días se reajusta por defecto. */
export const DEFAULT_REFIT_DAYS = 14;

/**
 * Días de historia que se dejan fuera al principio de cada liga.
 *
 * Los primeros meses no tienen partidos suficientes para ajustar nada, y puntuarlos mete
 * ruido común —el mismo para todas las configuraciones— que aplasta las diferencias que
 * se quieren medir.
 */
export const DEFAULT_WARMUP_DAYS = 400;

export function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(
    Date.UTC(
      Number(yyyymmdd.slice(0, 4)),
      Number(yyyymmdd.slice(4, 6)) - 1,
      Number(yyyymmdd.slice(6, 8)),
    ),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface WalkForwardOptions {
  refitDays?: number;
  warmupDays?: number;
  /** Partidos mínimos en la historia para que el ajuste valga algo. */
  minHistory?: number;
}

/**
 * Da los parámetros que un modelo honesto tendría disponibles en una fecha dada.
 *
 * Se usa así: por cada partido, en orden de fecha, `paramsFor(fecha)`. Devuelve `null`
 * mientras no haya historia suficiente, y en cuanto la hay devuelve un ajuste que no ha
 * visto ese partido ni ninguno posterior.
 */
export class DcWalkForward {
  private params: DcParams | null = null;
  private nextRefit: string;
  private readonly start: string;
  private readonly refitDays: number;
  private readonly minHistory: number;
  /** Cuántas veces se ha reajustado. Solo para diagnósticos. */
  refits = 0;

  constructor(
    private readonly all: DcMatch[],
    private readonly hyper: DcHyper,
    opts: WalkForwardOptions = {},
  ) {
    this.refitDays = opts.refitDays ?? DEFAULT_REFIT_DAYS;
    this.minHistory = opts.minHistory ?? 100;
    this.start = all.length > 0 ? addDays(all[0].date, opts.warmupDays ?? DEFAULT_WARMUP_DAYS) : '';
    this.nextRefit = this.start;
  }

  paramsFor(date: string): DcParams | null {
    if (!this.start || date < this.start) return null;
    if (date >= this.nextRefit || !this.params) {
      const history = this.all.filter((h) => h.date < date);
      if (history.length < this.minHistory) return null;
      // El arranque en caliente es lo que hace esto viable: partiendo del ajuste de
      // hace dos semanas bastan 60 iteraciones en vez de 400. No es una trampa —el
      // punto de partida solo mueve dónde empieza a buscar el optimizador, y los datos
      // del ajuste siguen siendo únicamente los anteriores a `date`.
      this.params = fitDixonColes(history, date, this.hyper, {
        warmStart: this.params ?? undefined,
      });
      this.nextRefit = addDays(date, this.refitDays);
      this.refits++;
    }
    return this.params;
  }
}

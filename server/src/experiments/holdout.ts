// El holdout final: datos que el código NO deja mirar hasta el final.
//
// ===========================================================================
// POR QUÉ HACE FALTA UN CANDADO Y NO UNA BUENA INTENCIÓN
// ===========================================================================
// Hasta ahora este proyecto tenía DOS conjuntos: entrenamiento y «reservado». Y el
// reservado se miró en el barrido del decay, en los cuatro pesos de Glicko, en las
// seis ablaciones, en los tres baselines… una vez tras otra. Después de la primera
// mirada dejó de ser un holdout y pasó a ser un conjunto de validación más: si eliges
// entre veinte opciones por lo que hace un conjunto, ese conjunto ya está dentro de la
// decisión, por mucho que no se haya entrenado sobre él.
//
// No es un tecnicismo. Es la diferencia entre «este número me dice cuánto acertaré
// mañana» y «este número me dice cuánto acerté en lo que ya optimicé».
//
// Así que ahora son TRES:
//
//     entrenamiento   →  construye los ratings, ajusta lo que haya que ajustar
//     validación      →  elige entre configuraciones. Se puede mirar todas las veces
//                        que haga falta, y por eso NO sirve para el número final
//     holdout final   →  se mira UNA vez, cuando ya no queda nada que decidir
//
// ===========================================================================
// CÓMO ESTÁ CERRADO
// ===========================================================================
// No con un comentario pidiendo por favor. `evaluationSeasons()` devuelve el rango sin
// el holdout, y `assertNotFinalHoldout()` LANZA si alguien puntúa una temporada
// reservada. Para abrirlo hay que llamar a `unlockFinalHoldout(motivo)`, que deja
// constancia en el registro de experimentos — así que abrirlo es un acto que queda
// escrito y contado, no algo que se pueda hacer de puntillas «solo para mirar».
//
// La constancia importa más que el candado: un candado se salta editando este fichero,
// pero el registro convierte esa edición en algo que hay que explicar.

import { recordUnlock } from './registry.ts';

export type EvaluationSport = 'football' | 'nfl';

/**
 * La primera temporada reservada, por deporte. Todo lo igual o posterior está cerrado.
 *
 * FÚTBOL 2026: deja 2020–2025 para trabajar (26.747 partidos) y reserva 3.691. La
 * temporada 2026 es la última completa del archivo, así que es la que más se parece a
 * «lo que viene».
 *
 * NFL 2024: deja 2006–2023 con moneyline real y reserva 570 partidos con precio de
 * cierre. Son pocos, y es lo que hay: la NFL juega 285 partidos al año.
 */
export const FINAL_HOLDOUT_FROM: Record<EvaluationSport, number> = {
  football: 2026,
  nfl: 2024,
};

/**
 * Dónde acaba la validación y empieza el holdout, para partir el resto.
 *
 * La validación es la ÚLTIMA temporada abierta. Todo lo anterior es entrenamiento.
 */
export const VALIDATION_SEASON: Record<EvaluationSport, number> = {
  football: 2025,
  nfl: 2023,
};

/** ¿Esta temporada está cerrada? */
export function isFinalHoldout(sport: EvaluationSport, season: number): boolean {
  return season >= FINAL_HOLDOUT_FROM[sport];
}

/**
 * En qué tramo cae una temporada. El nombre es el que hay que citar al publicar un
 * número: decir «medido en validación» y «medido en el holdout» son afirmaciones
 * distintas y no deben confundirse nunca.
 */
export function splitOf(sport: EvaluationSport, season: number): 'train' | 'validation' | 'holdout' {
  if (isFinalHoldout(sport, season)) return 'holdout';
  return season >= VALIDATION_SEASON[sport] ? 'validation' : 'train';
}

/** Estado del candado en ESTE proceso. Se abre por proceso, nunca de forma persistente. */
let unlocked: string | null = null;

/**
 * Abrir el holdout final, dejando constancia.
 *
 * `reason` no es decorativo: va al registro y es lo que alguien leerá dentro de un año
 * al preguntarse por qué el número final se calculó tres veces. Si no hay una razón que
 * se pueda escribir en una frase, probablemente no había que abrirlo.
 */
export function unlockFinalHoldout(reason: string): void {
  if (!reason || reason.trim().length < 10) {
    throw new Error(
      'unlockFinalHoldout necesita un motivo escrito: queda registrado y es lo único ' +
        'que explica, dentro de un año, por qué se abrió.',
    );
  }
  unlocked = reason.trim();
  recordUnlock(reason.trim());
}

export function isUnlocked(): boolean {
  return unlocked !== null;
}

/**
 * Lanza si se intenta puntuar una temporada cerrada sin haber abierto el candado.
 *
 * Lanza y no avisa: un aviso en medio de la salida de un script de mil líneas es un
 * aviso que nadie ve, y para cuando se ve, el número contaminado ya está en un commit.
 */
export function assertNotFinalHoldout(sport: EvaluationSport, season: number): void {
  if (!isFinalHoldout(sport, season) || unlocked) return;
  throw new Error(
    `Temporada ${season} de ${sport} pertenece al HOLDOUT FINAL (desde ` +
      `${FINAL_HOLDOUT_FROM[sport]}) y el candado está cerrado.\n` +
      'Si de verdad toca abrirlo, llama a unlockFinalHoldout("motivo") — y ten en ' +
      'cuenta que queda registrado.',
  );
}

/**
 * Filtro de conveniencia: quédate solo con lo que se puede mirar ahora.
 *
 * Es la puerta por la que deberían entrar todos los scripts de estudio, porque hace lo
 * correcto por defecto. Un script que use esto no puede contaminar el holdout ni por
 * descuido.
 */
export function keepOpen<T>(sport: EvaluationSport, rows: T[], seasonOf: (r: T) => number): T[] {
  if (unlocked) return rows;
  return rows.filter((r) => !isFinalHoldout(sport, seasonOf(r)));
}

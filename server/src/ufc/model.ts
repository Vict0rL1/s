// El modelo de la UFC en sombra (seguimiento: NHL y UFC): un Elo de luchador.
//
// ===========================================================================
// LO QUE ES
// ===========================================================================
// Cada luchador tiene un Elo; la probabilidad de ganar es la del Elo, sin ventaja para nadie: en la
// UFC no hay «local», y el orden en que la fuente pone a los dos luchadores NO se usa (hasta ~2009
// pone primero al ganador; después, la esquina roja). El modelo es simétrico: cambiar el orden de
// los dos solo cambia qué probabilidad es cuál.
//
// Dos cosas propias de un deporte en el que cada uno pelea dos o tres veces al año:
//   · las primeras peleas en la UFC mueven más el Elo (`provisionales`, `factorProvisional`): del
//     debutante no se sabe nada y el Elo de partida es solo un punto de partida;
//   · ganar antes del límite (KO o sumisión) puede contar más que a los puntos (`bonoFinalizacion`),
//     como el margen de goles en los deportes de equipo.
// El empate cuenta medio punto; el «sin resultado» no mueve nada.

export type ParamsUfc = { inicial: number; k: number; provisionales: number; factorProvisional: number; bonoFinalizacion: number };

export const UFC: ParamsUfc = {
  /** Elo de un debutante. */
  inicial: 1500,
  /** Paso de actualización. */
  k: 48,
  /** Cuántas peleas en la UFC se consideran «de debutante». */
  provisionales: 5,
  /** Cuánto más se mueve el Elo en esas primeras peleas. */
  factorProvisional: 1.5,
  /** Cuánto más cuenta ganar por KO o sumisión que a los puntos (0 = igual). */
  bonoFinalizacion: 0,
};

export const esperado = (dr: number) => 1 / (1 + 10 ** (-dr / 400));

/** Probabilidad de que gane cada uno. Simétrica: `predecir(b, a).a === predecir(a, b).b`. */
export function predecir(eloA: number, eloB: number): { a: number; b: number } {
  const a = esperado(eloA - eloB);
  return { a, b: 1 - a };
}

/** ¿Acabó antes del límite? Los métodos de ufcstats: «KO/TKO», «TKO - Doctor's Stoppage», «Submission», «Decision - …», «DQ», «Overturned»… */
export const esFinalizacion = (metodo: string | null | undefined): boolean => /^(KO|TKO|Submission)/i.test((metodo ?? '').trim());

export type ResultadoUfc = 'A' | 'B' | 'EMPATE' | 'NC';

/**
 * Los dos Elo después de la pelea. `peleasA` y `peleasB` son las que cada uno llevaba ANTES en la UFC.
 * Con K distinta para cada uno el cambio no es de suma cero: el debutante aprende más deprisa.
 */
export function actualizar(eloA: number, eloB: number, resultado: ResultadoUfc, peleasA: number, peleasB: number, metodo: string | null = null, p: ParamsUfc = UFC): [number, number] {
  if (resultado === 'NC') return [eloA, eloB];
  const s = resultado === 'A' ? 1 : resultado === 'B' ? 0 : 0.5;
  const e = esperado(eloA - eloB);
  const mult = resultado !== 'EMPATE' && esFinalizacion(metodo) ? 1 + p.bonoFinalizacion : 1;
  const kA = p.k * mult * (peleasA < p.provisionales ? p.factorProvisional : 1);
  const kB = p.k * mult * (peleasB < p.provisionales ? p.factorProvisional : 1);
  return [eloA + kA * (s - e), eloB - kB * (s - e)];
}

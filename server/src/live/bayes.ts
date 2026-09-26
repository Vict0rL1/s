// Actualizar el saque DENTRO del partido, sin sobrerreaccionar ni ignorarlo.
//
// ===========================================================================
// EL PROBLEMA, Y POR QUÉ NO SE RESUELVE A OJO
// ===========================================================================
// Un jugador va 1 de 12 con su primer saque. ¿Es que hoy no está, o son doce puntos?
//
// Las dos respuestas fáciles están mal. «Ignorarlo» supone que el saque de alguien es una
// constante de su carrera, y no lo es. «Creérselo» convierte doce puntos en una
// probabilidad de partido, y con doce puntos no se distingue un mal día de la mala
// suerte.
//
// La respuesta correcta es un peso, y el peso se puede MEDIR. Con un prior Beta y una
// verosimilitud binomial:
//
//     p_post = (κ·μ + k) / (κ + n)
//
// donde μ es lo que sabíamos antes del partido, k de n los puntos ganados al saque en
// este partido, y κ el «tamaño» del prior en puntos. Todo el problema es κ.
//
// ===========================================================================
// κ MEDIDO: 63 PUNTOS DE SAQUE
// ===========================================================================
// Sale de una descomposición de varianza sobre 58.732 actuaciones al saque de la ATP
// (`npm run study:live`):
//
//   varianza observada dentro de un jugador   0.006805
//   componente binomial esperado             −0.003192
//   ────────────────────────────────────────────────────
//   variación REAL partido a partido          0.003613  →  κ = μ(1−μ)/T − 1 = 63
//
// Y ese número tiene una lectura que justifica la funcionalidad entera. σ real entre
// partidos = √0.003613 = 6.0 puntos porcentuales. La dispersión ENTRE jugadores es de
// 2.7 pp (185 jugadores con 100+ partidos).
//
// O sea: UN JUGADOR VARÍA MÁS CONSIGO MISMO, DE PARTIDO A PARTIDO, QUE LO QUE LOS
// JUGADORES SE DIFERENCIAN ENTRE SÍ. Comprobado por dos rutas independientes — la
// descomposición agregada y las desviaciones individuales de Zverev (6.1 pp), Djokovic
// (5.0), Bautista (6.2), Medvedev (5.5), Rublev (5.4) y Fritz (6.1).
//
// Con κ = 63, el peso de lo que pasa en el partido crece así:
//
//     10 puntos → 14 %      40 puntos → 39 %      100 puntos → 61 %
//
// Un set y medio de saque pesa casi un 40 %. Eso es «actualizar en vez de ignorarlo», con
// un ritmo que sale de los datos y no de una preferencia.

/**
 * Fuerza del prior, en puntos de saque. Medida, no elegida.
 *
 * Se puede sobrescribir por parámetro para poder comprobar en las pruebas qué hace el
 * modelo con un prior más fuerte o más débil, pero el valor por defecto es el medido.
 */
export const KAPPA_SERVE = 63;

/** Lo observado al saque de un jugador en el partido en curso. */
export interface ServeTally {
  /** Puntos ganados con su saque. */
  won: number;
  /** Puntos servidos. */
  played: number;
}

export interface Updated {
  /** La `p` de antes del partido. */
  prior: number;
  /** La `p` después de mirar el partido. */
  posterior: number;
  /** Lo observado crudo, sin encoger. `null` si no ha servido todavía. */
  observed: number | null;
  /** Cuánto pesa el partido, de 0 a 1. */
  weight: number;
  /** Puntos servidos en el partido. */
  n: number;
  /**
   * Desviación típica del posterior, para poder decir cuánto NO se sabe.
   *
   * Sin esto, un posterior de 0.58 sobre 12 puntos y otro sobre 300 se enseñan igual, y
   * son cosas muy distintas.
   */
  sd: number;
  /**
   * Cuántas desviaciones típicas se separa lo observado del prior.
   *
   * Es lo que contesta «¿está sacando muy por debajo de su media?» con un número en vez
   * de con una impresión. Por encima de 2 en valor absoluto es raro; por debajo de 1 es
   * lo normal en cualquier partido.
   */
  z: number | null;
}

/**
 * El posterior del saque de un jugador.
 *
 * @param prior  P(punto al saque) antes del partido, de `serve.ts`
 * @param tally  lo servido en este partido
 * @param kappa  fuerza del prior en puntos; por defecto la medida
 */
export function updateServe(
  prior: number,
  tally: ServeTally,
  kappa = KAPPA_SERVE,
): Updated {
  const n = Math.max(0, tally.played);
  const k = Math.min(Math.max(0, tally.won), n);
  const alpha = kappa * prior + k;
  const beta = kappa * (1 - prior) + (n - k);
  const posterior = alpha + beta > 0 ? alpha / (alpha + beta) : prior;
  const total = alpha + beta;
  const sd = total > 1 ? Math.sqrt((posterior * (1 - posterior)) / (total + 1)) : 0.5;

  // z de lo OBSERVADO contra el prior, con el error típico binomial de la muestra del
  // partido. No se usa el sd del posterior: la pregunta es si estos n puntos son
  // sorprendentes dado lo que se esperaba, no cuánta certeza queda después.
  let z: number | null = null;
  if (n >= 5) {
    const se = Math.sqrt((prior * (1 - prior)) / n);
    z = se > 0 ? (k / n - prior) / se : null;
  }

  return {
    prior,
    posterior,
    observed: n > 0 ? k / n : null,
    weight: n / (n + kappa),
    n,
    sd,
    z,
  };
}

/**
 * ¿Merece un aviso lo que está haciendo al saque?
 *
 * Dos condiciones a la vez, y las dos hacen falta: que la desviación sea grande Y que
 * haya puntos suficientes para que signifique algo. Con solo la primera, cualquier 0 de
 * 4 dispara una alarma; con solo la segunda, un partido entero normal la dispara al
 * final.
 */
export function serveAnomaly(u: Updated): { flag: boolean; text: string } | null {
  if (u.z == null || u.n < 20) return null;
  if (Math.abs(u.z) < 1.5) return null;
  const dir = u.z < 0 ? 'por debajo' : 'por encima';
  const pp = Math.abs(((u.observed ?? 0) - u.prior) * 100).toFixed(1);
  return {
    flag: true,
    text:
      `Saca ${pp} pp ${dir} de su media (${u.n} puntos, z = ${u.z.toFixed(1)}). ` +
      `El modelo ya lo ha incorporado: usa ${(u.posterior * 100).toFixed(1)} % en vez de ` +
      `${(u.prior * 100).toFixed(1)} %, con un peso del ${(u.weight * 100).toFixed(0)} % ` +
      'para lo que se ve hoy.',
  };
}

// Kelly: cuánto arriesgar dado un precio y una probabilidad. Solo aritmética.
//
// ===========================================================================
// ESTE FICHERO NO SABE NADA DEL MODELO
// ===========================================================================
// Y esa es toda la idea. El modelo contesta «¿con qué probabilidad pasa esto?»; esto
// contesta «¿cuánto pongo?». Son preguntas distintas, con criterios distintos y modos
// de fallo distintos, y mezclarlas es lo que produce el error clásico: mejorar el
// modelo y creer que por eso se puede apostar más.
//
// Aquí no entra ningún Elo, ninguna liga y ningún equipo. Entran una probabilidad, un
// precio y un banco. Se puede leer, comprobar y romper sin tocar nada de predicción.
//
// ===========================================================================
// QUÉ ES KELLY Y QUÉ NO ES
// ===========================================================================
// Kelly da la fracción del banco que MAXIMIZA EL CRECIMIENTO LOGARÍTMICO a largo plazo.
// Para una apuesta binaria a cuota decimal o, con b = o − 1:
//
//     f* = (p·b − q) / b        con q = 1 − p
//
// Lo que NO es: la apuesta que maximiza el dinero esperado (esa es siempre «todo»), ni
// una recomendación segura. Kelly completo es matemáticamente óptimo bajo una hipótesis
// que en apuestas deportivas NUNCA se cumple — que p es exacta. Con p estimada, Kelly
// completo sobreapuesta, y sobreapostar en Kelly no es «ganar un poco menos»: la curva
// de crecimiento es cóncava y pasado 2f* el crecimiento esperado es NEGATIVO aunque
// cada apuesta tenga valor esperado positivo. Un modelo con un error del 20 % en p
// puede convertir una ventaja real en ruina jugando Kelly completo.
//
// Por eso `fullKelly` está exportada pero nadie debería llamarla para apostar. La usa
// `staking/policy.ts` para multiplicarla por una fracción, y ese es el único camino.

/** Beneficio por unidad apostada. Cuota 2.50 → b = 1.50. */
export const profitPerUnit = (decimalOdds: number): number => decimalOdds - 1;

/**
 * Valor esperado de una unidad apostada, al precio ofrecido.
 *
 * Positivo = el precio paga más de lo que la probabilidad justifica. Es la condición
 * mínima para que una apuesta tenga sentido, y NO es suficiente: una ventaja pequeña
 * con una probabilidad mal estimada sigue siendo una forma de perder dinero despacio.
 */
export function expectedValue(p: number, decimalOdds: number): number {
  return p * decimalOdds - 1;
}

/**
 * La fracción de Kelly COMPLETA. No apuestes esto.
 *
 * Se devuelve 0 —y no un número negativo— cuando no hay ventaja: una fracción negativa
 * significa «apuesta al otro lado», y en un mercado real el otro lado tiene su propio
 * precio con su propio margen, así que tratarla como una apuesta sería inventarse una
 * cuota que nadie ofrece.
 */
export function fullKelly(p: number, decimalOdds: number): number {
  const b = profitPerUnit(decimalOdds);
  if (!(b > 0) || !(p > 0) || !(p < 1)) return 0;
  const f = (p * b - (1 - p)) / b;
  return f > 0 ? f : 0;
}

/**
 * Crecimiento logarítmico esperado por apuesta, apostando una fracción f.
 *
 * Es la función que Kelly maximiza, y sirve para ver de un vistazo por qué pasarse
 * castiga tanto: en f = 2·f* vale exactamente 0 —todo el crecimiento se ha evaporado—
 * y a partir de ahí es negativa.
 */
export function expectedLogGrowth(p: number, decimalOdds: number, f: number): number {
  const b = profitPerUnit(decimalOdds);
  if (f <= 0) return 0;
  if (f >= 1) return -Infinity;
  return p * Math.log(1 + f * b) + (1 - p) * Math.log(1 - f);
}

/**
 * Fracciones permitidas. NO existe la opción de Kelly completo, y es a propósito.
 *
 * No es una preferencia estética: con p estimada, la fracción óptima real es más
 * pequeña que f*, y cuánto más pequeña depende del error de estimación, que no se
 * conoce con precisión. Un cuarto y un quinto son las dos fracciones que la práctica
 * ha convergido en usar porque aguantan un error de estimación grande sin cambiar el
 * signo del crecimiento.
 *
 * Que el tipo no admita 1 significa que «probar Kelly completo un día» exige editar
 * este fichero, que es exactamente la fricción que debe tener.
 */
export type KellyFraction = 0.25 | 0.2;

/** Kelly fraccional: lo único que la política de riesgo tiene derecho a usar. */
export function fractionalKelly(
  p: number,
  decimalOdds: number,
  fraction: KellyFraction,
): number {
  return fullKelly(p, decimalOdds) * fraction;
}

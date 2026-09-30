// Regresión isotónica: la curva monótona que mejor lleva «lo que dice el modelo» a «lo
// que pasa de verdad».
//
// ===========================================================================
// QUÉ ARREGLA
// ===========================================================================
// Un modelo puede ordenar bien y mentir en el nivel. Si de todas las veces que dice
// «30 %» solo pasa el 24 %, el orden es correcto —los partidos que puntúa más alto
// ocurren más— pero el número está inflado, y el número es lo que se usa para decidir
// si una cuota es cara.
//
// La isotónica no supone ninguna forma: solo exige que la curva NO BAJE. Si el modelo
// dice más, tiene que pasar más. Esa única restricción es lo que la separa de un ajuste
// libre, que se comería el ruido y devolvería una curva que sube y baja sin sentido.
//
// ===========================================================================
// POR QUÉ SE AGRUPA ANTES DE AJUSTAR
// ===========================================================================
// Aquí las etiquetas son 0 o 1: «empataron» o «no empataron». PAVA sobre 0/1 crudos
// devuelve tramos con valor EXACTAMENTE 0 o 1 —una racha de unos al final se queda como
// una fila de tramos de valor 1— y eso dice «imposible» y «seguro» a partir de un puñado
// de partidos. En log loss, un «imposible» que ocurre vale infinito.
//
// Así que primero se agrupa en tramos de igual recuento y se ajusta sobre las MEDIAS de
// esos tramos, con su peso. Un tramo de 300 partidos con 71 empates dice 0,237, que es
// una frecuencia; 300 respuestas sueltas de 0 y 1 no dicen nada por separado. Es la
// diferencia entre medir y memorizar, y se nota: sin agrupar, la isotónica salía PEOR
// que no calibrar en las dos ligas donde se probó.
//
// ===========================================================================
// LO QUE HAY QUE VIGILARLE IGUALMENTE
// ===========================================================================
// Sigue siendo no paramétrica y sigue pudiendo sobreajustar. Por eso (1) hay un mínimo
// de puntos por debajo del cual no se ajusta, (2) se compara SIEMPRE contra Platt y
// contra no calibrar, fuera de muestra, y (3) los extremos se recortan al rango visto:
// extrapolar una curva escalonada es inventar.

/** El ajuste: una función monótona, guardada como puntos de corte y valores. */
export interface Isotonic {
  /** Probabilidad cruda representativa de cada tramo, creciente. */
  x: number[];
  /** Frecuencia observada en ese tramo, no decreciente. */
  y: number[];
  /** Puntos con los que se ajustó. Para poder decir cuánto respalda a la curva. */
  n: number;
}

interface Block {
  /** Suma de y ponderada (o sea, número de veces que ocurrió). */
  sum: number;
  /** Observaciones del tramo. */
  weight: number;
  /** Suma de x ponderada, para situar el tramo en su media. */
  xSum: number;
}

/**
 * Cuántos grupos. Raíz del número de puntos, acotada.
 *
 * Es el compromiso de siempre: pocos grupos no dejan que la curva se doble donde tiene
 * que doblarse; muchos vuelven a dejar cada grupo sin datos suficientes para que su
 * media signifique algo. √n mantiene el tamaño de grupo creciendo con los datos, que es
 * lo que hace que el método mejore al haber más en vez de sobreajustar más.
 */
function binCount(n: number): number {
  return Math.max(10, Math.min(60, Math.round(Math.sqrt(n))));
}

/**
 * Pool Adjacent Violators, con pesos.
 *
 * Mientras haya un tramo cuyo valor sea MENOR que el del anterior, se funden en uno con
 * la media ponderada de los dos. Al no quedar violaciones la secuencia es no decreciente
 * y es —demostrablemente— la que minimiza el error cuadrático entre todas las monótonas.
 */
export function fitIsotonic(
  points: { x: number; y: number }[],
  minPoints = 500,
): Isotonic | null {
  if (points.length < minPoints) return null;
  const sorted = [...points].sort((a, b) => a.x - b.x);

  // ---- 1. agrupar en tramos de igual recuento ----
  const bins = binCount(sorted.length);
  const per = Math.ceil(sorted.length / bins);
  const grouped: Block[] = [];
  for (let i = 0; i < sorted.length; i += per) {
    const slice = sorted.slice(i, i + per);
    grouped.push({
      sum: slice.reduce((s, p) => s + p.y, 0),
      weight: slice.length,
      xSum: slice.reduce((s, p) => s + p.x, 0),
    });
  }

  // ---- 2. PAVA sobre las medias de los grupos ----
  const blocks: Block[] = [];
  for (const g of grouped) {
    blocks.push({ ...g });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.weight <= b.sum / b.weight) break;
      blocks.pop();
      a.sum += b.sum;
      a.weight += b.weight;
      a.xSum += b.xSum;
    }
  }

  // ---- 3. suelo y techo, para que ningún tramo diga «imposible» ----
  // Un tramo sin un solo caso no demuestra imposibilidad, solo que no pasó en ESOS
  // partidos. Con (α, α) = (1, 1) —haber visto un caso de cada antes de empezar— un
  // tramo de 300 sin éxitos queda en 1/302 en vez de en 0. Sobre grupos de cientos el
  // efecto es despreciable donde hay datos y decisivo donde no los hay, que es
  // exactamente lo que se quiere de un suelo.
  const LAPLACE = 1;
  const x: number[] = [];
  const y: number[] = [];
  for (const b of blocks) {
    x.push(b.xSum / b.weight);
    y.push((b.sum + LAPLACE) / (b.weight + 2 * LAPLACE));
  }
  // El suelo empuja cada tramo hacia 0,5 y empuja más a los pequeños, así que puede dar
  // la vuelta a dos vecinos y romper lo único que esta curva promete. Una pasada de
  // máximo acumulado lo repara y solo toca los pares que el suelo invirtió.
  for (let i = 1; i < y.length; i++) if (y[i] < y[i - 1]) y[i] = y[i - 1];

  return { x, y, n: points.length };
}

/**
 * Evaluar la curva, interpolando linealmente entre tramos.
 *
 * Interpola en vez de devolver escalones porque los escalones dan saltos de varios
 * puntos porcentuales entre dos partidos casi idénticos, y eso se ve en pantalla: dos
 * tarjetas parecidas con números que no se parecen. Fuera del rango ajustado se RECORTA
 * al extremo, que es lo único honesto — ahí no hay datos.
 */
export function applyIsotonic(iso: Isotonic, raw: number): number {
  const { x, y } = iso;
  if (x.length === 0) return raw;
  if (raw <= x[0]) return y[0];
  if (raw >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= raw) lo = mid;
    else hi = mid;
  }
  const span = x[hi] - x[lo];
  if (span <= 0) return y[lo];
  return y[lo] + ((raw - x[lo]) / span) * (y[hi] - y[lo]);
}

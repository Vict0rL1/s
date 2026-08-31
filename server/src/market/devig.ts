// De cuotas a probabilidades: quitar el margen de la casa, bien.
//
// ===========================================================================
// POR QUÉ NO BASTA CON NORMALIZAR
// ===========================================================================
// Las cuotas de una casa implican 1/o por resultado, y esas fracciones suman MÁS de
// 1. El exceso es el margen. Repartirlo dividiendo cada una por la suma —el método
// multiplicativo, que es el que estaba en toda esta app— supone que la casa carga el
// margen en PROPORCIÓN a la probabilidad, es decir, el mismo porcentaje al favorito
// que al que no tiene opciones.
//
// Eso es exactamente lo que la literatura de apuestas lleva cincuenta años diciendo
// que no pasa. El sesgo favorito–perdedor es de los hechos más replicados del campo:
// los que pagan mucho están sistemáticamente sobrevalorados por el precio, o dicho al
// revés, la casa carga MÁS margen en las cuotas altas. Un método que reparte a
// prorrata deja ese sesgo dentro, y todo lo que se construya encima —comparar el
// modelo con el mercado, buscar valor, calibrar— lo hereda.
//
// ===========================================================================
// SHIN
// ===========================================================================
// Shin (1993) da una razón para ese sesgo en vez de un parche: la casa no se
// enfrenta solo a apostantes desinformados, sino a una proporción z de INFORMADOS
// que saben algo que ella no. Para no perder con ellos ensancha el margen, y lo
// ensancha más donde un informado haría más daño — las cuotas altas.
//
// Con ese modelo, la probabilidad real p_i se recupera de la implícita π_i = 1/o_i:
//
//     p_i = [ √( z² + 4(1−z)·π_i²/Π ) − z ] / [ 2(1−z) ]        con Π = Σ π_j
//
// y z no es libre: es el único valor que hace que las p_i sumen 1. Se resuelve
// numéricamente. z sale 0 en un libro sin margen y crece con él.
//
// ===========================================================================
// CUÁL SE USA
// ===========================================================================
// El que gane midiendo, y la medición está en `npm run study:devig`: 5.295 partidos
// de NFL con moneyline de cierre REAL de 2006 a 2025. Los resultados están al final
// de este fichero, junto a la función que se acabó usando.

/** Una cuota decimal → su probabilidad implícita, con margen dentro. */
const implied = (odds: number): number => 1 / odds;

export interface DevigResult {
  /** Probabilidades que suman 1. */
  probs: number[];
  /** Σ 1/o. 1.05 = 5 % de margen. */
  overround: number;
  /**
   * La proporción de apostantes informados que estima Shin. 0 en el multiplicativo,
   * donde el concepto no existe. Es interpretable y vale la pena enseñarla: en el
   * cierre de la NFL sale ~2 %, en mercados menos líquidos sube.
   */
  z: number;
}

/**
 * El método de siempre: dividir cada implícita por la suma.
 *
 * Rápido, sin parámetros, y supone que el margen es proporcional a la probabilidad.
 * Es el punto de partida contra el que hay que medir cualquier otra cosa.
 */
export function devigMultiplicative(odds: number[]): DevigResult {
  const raw = odds.map(implied);
  const overround = raw.reduce((a, b) => a + b, 0);
  return { probs: raw.map((p) => p / overround), overround, z: 0 };
}

/**
 * Suma de las p_i de Shin para un z dado. Vale 1 en el z correcto.
 *
 * Se saca aparte porque la búsqueda de z necesita evaluarla muchas veces y porque
 * así se puede comprobar sola: en un libro sin margen (Π = 1) tiene que dar 1 en
 * z = 0.
 */
function shinSum(raw: number[], overround: number, z: number): number {
  let s = 0;
  for (const pi of raw) {
    s += (Math.sqrt(z * z + (4 * (1 - z) * pi * pi) / overround) - z) / (2 * (1 - z));
  }
  return s;
}

/**
 * Shin: reparte el margen suponiendo que parte del dinero está informado.
 *
 * z se busca por bisección y no por una fórmula cerrada porque no la hay para más de
 * dos resultados, y tener DOS caminos —uno exacto para el mercado a dos bandas y otro
 * numérico para el resto— sería dos cosas que pueden discrepar. La bisección converge
 * en ~40 pasos a 1e-12, que en un mercado de 3 resultados es tiempo despreciable.
 */
export function devigShin(odds: number[]): DevigResult {
  const raw = odds.map(implied);
  const overround = raw.reduce((a, b) => a + b, 0);
  // Un libro sin margen (o por debajo) no tiene nada que repartir y Shin no aplica:
  // devolverlo normalizado es lo único honesto, y evita buscar una raíz que no existe.
  if (overround <= 1) return devigMultiplicative(odds);

  // Σp(0) = √Π > 1 y Σp decrece con z, así que la raíz está en (0, 1).
  let lo = 0;
  let hi = 1 - 1e-9;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (shinSum(raw, overround, mid) > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const probs = raw.map(
    (pi) => (Math.sqrt(z * z + (4 * (1 - z) * pi * pi) / overround) - z) / (2 * (1 - z)),
  );
  // La bisección deja un residuo minúsculo; renormalizar garantiza que suman
  // exactamente 1, que es una propiedad de la que depende todo lo de aguas abajo.
  const s = probs.reduce((a, b) => a + b, 0);
  return { probs: probs.map((p) => p / s), overround, z };
}

/**
 * Potencia: p_i ∝ π_i^(1/k), con k tal que sumen 1.
 *
 * No la pidió nadie y está aquí por una razón concreta: si Shin le gana al
 * multiplicativo, hay que saber si gana POR SER SHIN o simplemente por no ser
 * proporcional. La potencia también comprime las cuotas altas, sin ninguna historia
 * sobre apostantes informados detrás. Es el control de la comparación.
 */
export function devigPower(odds: number[]): DevigResult {
  const raw = odds.map(implied);
  const overround = raw.reduce((a, b) => a + b, 0);
  if (overround <= 1) return devigMultiplicative(odds);
  // k VA POR DEBAJO DE 1, y equivocarse aquí no da un error, da un método peor que
  // se puede publicar sin enterarse. Como cada π < 1, elevar a 1/k con k > 1 los
  // AGRANDA, así que la suma crece con k y en k = 1 ya vale Π > 1: la raíz solo puede
  // estar en (0, 1). Buscándola en [1, 4] el resultado salía +0.045 de log loss peor
  // que el multiplicativo, que es justo la clase de número que uno atribuye al método
  // en vez de a su propio rango de búsqueda.
  let lo = 1e-6;
  let hi = 1;
  const sum = (k: number) => raw.reduce((a, p) => a + Math.pow(p, 1 / k), 0);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) > 1) hi = mid;
    else lo = mid;
  }
  const k = (lo + hi) / 2;
  const probs = raw.map((p) => Math.pow(p, 1 / k));
  const s = probs.reduce((a, b) => a + b, 0);
  return { probs: probs.map((p) => p / s), overround, z: 0 };
}

// ===========================================================================
// EL RESULTADO DE LA MEDICIÓN  (`npm run study:devig`)
// ===========================================================================
// 5.281 partidos de NFL con moneyline de cierre real, 2006–2025. Es el único conjunto
// de este proyecto con cuotas de casa de verdad y resultados: el fútbol tiene las
// columnas de cuotas vacías y el tenis tampoco las trae.
//
//     método            log loss     Brier
//     multiplicativo     0.60946    0.21112
//     Shin               0.60932    0.21110    −0.00014
//     potencia           0.60931    0.21111    −0.00015
//
// LOS TRES SON EL MISMO NÚMERO. Shin gana en 13 de 20 temporadas, que con 20
// temporadas es lo que sale de tirar una moneda. Partiendo por margen del libro, ni
// siquiera el signo es consistente: con margen bajo Shin es PEOR (+0.00059) y con
// margen de 3–4 % es mejor (−0.00128). No hay efecto que defender.
//
// Y tiene una explicación, que es lo que evita tratarlo como un resultado universal:
// el cierre de la NFL tiene un margen del 2,72 %, de los libros más apretados que
// existen. Los tres métodos reparten el MISMO margen de formas distintas, así que
// cuando no hay casi nada que repartir tienen que coincidir. Cuánto se separan, sobre
// estos mismos partidos reescalados a otros márgenes:
//
//     margen del libro    |Δp| media   |Δp| máxima
//     2,7 % (la NFL)        0.45 pp       1.23 pp
//     5,0 %                 0.84 pp       2.29 pp
//     7,0 % (1X2 típico)    1.18 pp       3.20 pp
//     10,0 %                1.68 pp       4.46 pp
//
// O sea: en el mercado donde se midió la elección da igual, y en el 1X2 de fútbol
// —donde esta app compara modelo contra mercado, con un umbral de valor de 5 pp—
// movería en torno a 1 pp. No es nada, pero tampoco está medido allí.
//
// ===========================================================================
// QUÉ SE USA, Y POR QUÉ NO ES SHIN
// ===========================================================================
// El multiplicativo, que es lo que ya había. La regla es «cada cosa nueva justifica su
// existencia mejorando el log loss fuera de muestra, y si no, fuera», y Shin no lo
// mejora: −0.00014 con el signo cambiando entre tramos es ruido. Cambiar el método por
// el que suena mejor sin evidencia sería exactamente lo que la regla prohíbe, y aquí
// el coste de equivocarse no es teórico — estas probabilidades son las que la app
// compara con su modelo para decir la palabra «valor».
//
// Shin NO se borra, y esa es la diferencia con una feature que no funciona: la
// medición está hecha en el mercado equivocado. El cierre de la NFL es el techo de
// eficiencia; el 1X2 de fútbol tiene dos veces y media ese margen y es donde el sesgo
// favorito–perdedor está descrito. En cuanto haya cuotas de cierre de fútbol en la
// base —football-data.co.uk, que aquí no se alcanza— se vuelve a correr
// `npm run study:devig` sobre ellas y esta línea se decide con datos del sitio
// correcto. Hasta entonces, el que no hay que justificar es el que se queda.
export const devig = devigMultiplicative;

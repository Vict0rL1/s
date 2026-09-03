// El drawdown esperado: lo que hay que mirar antes que el retorno.
//
// ===========================================================================
// POR QUÉ NO BASTA CON EL RETORNO ESPERADO
// ===========================================================================
// «+4 % esperado» es una media sobre futuros posibles, y no dice nada sobre el camino.
// Dos estrategias con el mismo retorno esperado pueden tener caídas máximas del 8 % y
// del 45 %, y la diferencia entre las dos es si sigues operando cuando llegue la mala
// racha o lo dejas en el peor momento posible.
//
// El drawdown es además donde el error de estimación duele. Si p está inflada, el
// retorno esperado que calcula el sistema es mentira, pero la caída que simula sigue
// siendo REAL: el número de apuestas perdidas seguidas no depende de que hayas acertado
// la probabilidad, depende del tamaño que pusiste. Por eso la caída se simula con la p
// del modelo y también con una p RECORTADA — para ver qué pasa si el modelo es peor de
// lo que cree.
//
// ===========================================================================
// CÓMO
// ===========================================================================
// Monte Carlo sobre la secuencia de apuestas: cada camino resuelve cada apuesta con su
// probabilidad, mueve el banco, y se anota la mayor caída desde el máximo anterior.
// Con miles de caminos sale la distribución, y de ahí la mediana y el percentil 95 —
// que es el número que hay que poder soportar, no la media.

export interface PlannedBet {
  label: string;
  /** Probabilidad del modelo. */
  p: number;
  odds: number;
  /** Fracción del banco arriesgada, tal y como la decidió la política. */
  fraction: number;
  /**
   * Qué apuestas se resuelven A LA VEZ. Mismo valor = misma tanda.
   *
   * Sin esto el simulador subestimaba la COLA. La primera versión resolvía las
   * apuestas de una en una sobre el banco ya actualizado, así que perderlas todas nunca
   * costaba la suma de lo apostado: veinte al 2 % tocaban techo en 1 − 0.98²⁰ = 33,2 %,
   * cuando liquidadas juntas el mismo sábado cuestan el 40 % exacto.
   *
   * Y una precisión que la primera versión de este comentario se saltaba: agrupar NO
   * empeora el drawdown en todas partes. Empeora el extremo —que es lo que arruina— y
   * puede MEJORAR el percentil típico, porque una sola liquidación ofrece una sola
   * oportunidad de caer desde un máximo, mientras que veinte pasos sueltos pueden
   * deambular hacia abajo. Medido con veinte apuestas al 2 % y p = 0.55: p95 del 12,0 %
   * agrupadas contra 15,0 % sueltas, y peor caso 24,0 % contra 24,7 % con 4.000 caminos
   * (los extremos teóricos, 40 % y 33 %, no se alcanzan porque perder las veinte tiene
   * probabilidad de una entre un millón).
   *
   * Lo correcto es agrupar por lo que de verdad se liquida junto, ni más ni menos. Sin
   * `round`, cada apuesta va en su propia tanda y se recupera el comportamiento
   * secuencial — que es el correcto para apuestas separadas en el tiempo.
   */
  round?: string | number;
}

export interface DrawdownReport {
  paths: number;
  /** Retorno medio sobre el banco inicial, en fracción. */
  expectedReturn: number;
  /** Mediana de la máxima caída desde máximos. */
  medianMaxDrawdown: number;
  /** El percentil 95 de la caída: el mal día que hay que poder aguantar. */
  p95MaxDrawdown: number;
  /** El peor camino simulado. */
  worstMaxDrawdown: number;
  /** Proporción de caminos que acaban por debajo del banco inicial. */
  probLosing: number;
  /** Proporción que pierde la mitad del banco. Es el número de «ruina» práctica. */
  probHalved: number;
}

/**
 * Simular la secuencia y devolver la distribución de la caída.
 *
 * `pShift` desplaza TODAS las probabilidades hacia la moneda: 0 las deja como están,
 * 0.5 las convierte en 50/50. Es la palanca para preguntar «¿y si el modelo es peor de
 * lo que cree?», que es la pregunta que decide si un plan de apuestas es prudente o
 * solo afortunado.
 */
export function simulate(
  bets: PlannedBet[],
  opts: { paths?: number; pShift?: number; seed?: number } = {},
): DrawdownReport {
  const paths = opts.paths ?? 5000;
  const shift = opts.pShift ?? 0;
  let seed = opts.seed ?? 424242;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Agrupar por tanda una sola vez, fuera del bucle de caminos.
  const byRound = new Map<string, PlannedBet[]>();
  bets.forEach((b, i) => {
    const key = String(b.round ?? `__solo_${i}`);
    byRound.set(key, [...(byRound.get(key) ?? []), b]);
  });
  const groups = [...byRound.values()];

  const maxDDs: number[] = [];
  let sumFinal = 0;
  let losing = 0;
  let halved = 0;

  for (let i = 0; i < paths; i++) {
    let bank = 1;
    let peak = 1;
    let maxDD = 0;
    // Se barajan las TANDAS, no las apuestas: el orden real de las jornadas no se
    // conoce, pero lo que va junto tiene que seguir yendo junto.
    const order = groups.map((_, k) => k);
    for (let k = order.length - 1; k > 0; k--) {
      const j = (rnd() * (k + 1)) | 0;
      [order[k], order[j]] = [order[j], order[k]];
    }
    // Las tandas se recorren en orden; dentro de una tanda, TODAS las apuestas se
    // dimensionan sobre el mismo banco y se liquidan juntas. Es lo que pasa un sábado:
    // no esperas a que acabe el de las 13:00 para decidir el de las 13:00.
    let broke = false;
    for (const groupIdx of order) {
      const group = groups[groupIdx];
      const snapshot = bank;
      let delta = 0;
      for (const b of group) {
        const p = b.p + (0.5 - b.p) * shift;
        // Fracción del banco al ABRIR la tanda, no del que va quedando dentro de ella.
        const stake = snapshot * b.fraction;
        delta += rnd() < p ? stake * (b.odds - 1) : -stake;
      }
      bank += delta;
      if (bank > peak) peak = bank;
      const dd = (peak - bank) / peak;
      if (dd > maxDD) maxDD = dd;
      if (bank <= 0) {
        bank = 0;
        maxDD = 1;
        broke = true;
        break;
      }
    }
    void broke;
    maxDDs.push(maxDD);
    sumFinal += bank;
    if (bank < 1) losing++;
    if (bank <= 0.5) halved++;
  }

  maxDDs.sort((a, b) => a - b);
  return {
    paths,
    expectedReturn: sumFinal / paths - 1,
    medianMaxDrawdown: maxDDs[Math.floor(paths * 0.5)],
    p95MaxDrawdown: maxDDs[Math.floor(paths * 0.95)],
    worstMaxDrawdown: maxDDs[paths - 1],
    probLosing: losing / paths,
    probHalved: halved / paths,
  };
}

// Mezclar el modelo con el mercado, y encoger hacia el mercado cuando discrepan mucho.
//
// ===========================================================================
// POR QUÉ SE MEZCLA EN ESCALA LOGARÍTMICA
// ===========================================================================
// La media aritmética de dos probabilidades parece lo natural y no lo es. Con
// 2 % y 20 % a partes iguales, la aritmética da 11 %: mucho más cerca del pronóstico
// atrevido que de lo que dos observadores razonables concluirían. En escala logarítmica
// da 6,7 %, que respeta que la distancia entre 2 % y 20 % es la misma que entre 20 % y
// 75 % — un salto de diez veces en la cuota, las dos veces.
//
//     log q_k  =  w · log p_k  +  (1−w) · log m_k        (y se renormaliza)
//
// Esto es el «logarithmic opinion pool», y con dos resultados es exactamente mezclar
// log-odds. Tiene la propiedad que importa aquí: si los dos están de acuerdo en que algo
// es imposible, la mezcla también lo dice. La media aritmética no.
//
// ===========================================================================
// EL ENCOGIMIENTO: POR QUÉ DISCREPAR MUCHO ES MALA SEÑAL
// ===========================================================================
// Un peso fijo trata igual una discrepancia de 2 puntos que una de 30. No son iguales.
// La línea de cierre incorpora lesiones, alineaciones, clima y dinero informado; cuando
// un modelo se aleja MUCHO de ella, la explicación más frecuente no es que haya visto
// algo, sino que le falta algo que el mercado sí tiene — una baja de última hora que el
// modelo no conoce, por ejemplo. Y esas son justo las tarjetas que enseñan más «valor»,
// o sea las que más apetece apostar.
//
//     w_efectivo  =  w / (1 + κ · d)      con d = KL(modelo ‖ mercado)
//
// κ tiene lectura directa: el peso del modelo se parte por la mitad cuando la
// discrepancia llega a d = 1/κ nats. κ = 0 apaga el encogimiento y deja el peso fijo,
// que es la hipótesis nula contra la que hay que ganar.
//
// KL y no «diferencia de puntos porcentuales» porque funciona igual con dos resultados
// que con tres, y porque pesa las discrepancias donde el mercado está seguro —que son
// las informativas— más que las del centro, donde todo el mundo duda.

export interface BlendParams {
  /** Peso del modelo cuando no hay discrepancia. 1 = mercado ignorado, 0 = solo mercado. */
  w: number;
  /** Fuerza del encogimiento. 0 = peso fijo. */
  kappa: number;
}

const LOG_FLOOR = -30;
const safeLog = (p: number): number => Math.max(LOG_FLOOR, Math.log(Math.max(p, 1e-12)));

/** KL(p ‖ m) en nats: cuánto se aleja el modelo del mercado. */
export function disagreement(model: number[], market: number[]): number {
  let kl = 0;
  for (let k = 0; k < model.length; k++) {
    if (model[k] <= 0) continue;
    kl += model[k] * (safeLog(model[k]) - safeLog(market[k]));
  }
  return Math.max(0, kl);
}

export interface BlendResult {
  /** La probabilidad final. */
  probs: number[];
  /** El peso que se le acabó dando al modelo, ya encogido. */
  weight: number;
  /** La discrepancia medida, en nats. */
  disagreement: number;
}

export function blend(model: number[], market: number[], p: BlendParams): BlendResult {
  const d = disagreement(model, market);
  const w = p.w / (1 + p.kappa * d);
  const z = model.map((mo, k) => w * safeLog(mo) + (1 - w) * safeLog(market[k]));
  const max = Math.max(...z);
  const e = z.map((v) => Math.exp(v - max));
  const sum = e.reduce((s, v) => s + v, 0);
  const probs = sum > 0 ? e.map((v) => v / sum) : model.slice();
  return { probs, weight: w, disagreement: d };
}

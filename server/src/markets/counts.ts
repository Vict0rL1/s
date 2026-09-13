// Distribuciones para mercados de CONTEO: córners, tarjetas, goles de un jugador.
//
// ===========================================================================
// LA PREGUNTA NO ES «¿POISSON O BINOMIAL NEGATIVA?». ES «¿CUÁL DICEN LOS DATOS?»
// ===========================================================================
// Las dos familias se diferencian en UNA cosa: cuánta varianza admiten.
//
//     Poisson              varianza = media
//     binomial negativa    varianza = media + media²/k     (siempre MAYOR)
//
// O sea que la binomial negativa solo puede añadir dispersión, nunca quitarla. Elegirla
// «porque los conteos suelen estar sobredispersos» es exactamente el tipo de suposición
// que este proyecto mide en vez de heredar — y en los goles de fútbol la suposición es
// FALSA. Medido sobre 24.778 partidos:
//
//     goles del local, partido entero    var/media = 0.950
//     goles del visitante                var/media = 0.983
//     goles del local, 1ª parte          var/media = 0.961
//     TOTAL de goles del partido         var/media = 0.798
//
// Por equipo están *ligeramente por debajo* de Poisson, y el total mucho más — pero eso
// último no es una propiedad de la distribución de cada equipo, es que los dos equipos
// están correlacionados NEGATIVAMENTE (−0,173): cuando uno marca mucho el otro marca
// poco. Una binomial negativa sobre el total sería la respuesta equivocada a la pregunta
// equivocada: añadiría varianza donde sobra, y seguiría sin capturar el acoplamiento.
// Para los goles, la respuesta correcta es la que ya está en el modelo — dos Poisson
// acopladas por la corrección de Dixon-Coles.
//
// Las tarjetas y los córners son otra historia y es razonable esperarlos SOBREdispersos
// (el árbitro es un factor común a todo el partido: hay quien saca seis y quien saca
// una). Pero «es razonable esperar» no es una medición, así que aquí no se decide a
// mano: `fitCounts` mide la dispersión, la contrasta, y elige. Si los datos dicen
// Poisson, sale Poisson.

/** Qué familia se acabó usando, y por qué. */
export interface CountModel {
  kind: 'poisson' | 'negbin';
  /** Media de la cuenta. */
  mean: number;
  /**
   * Parámetro de forma de la binomial negativa: var = media + media²/k.
   *
   * `null` en una Poisson. Un k grande es una Poisson disfrazada — de hecho la Poisson
   * es el límite de la binomial negativa cuando k → ∞.
   */
  k: number | null;
  /** Varianza observada dividida por la media observada. 1 = Poisson exacta. */
  dispersion: number;
  /**
   * z del contraste de dispersión. Positivo = más varianza que Poisson.
   *
   * Es lo que decide, y se guarda para poder enseñarlo: un modelo que dice «binomial
   * negativa» sin enseñar cuánta sobredispersión encontró no se puede discutir.
   */
  z: number;
  n: number;
}

/**
 * Umbral de |z| para dejar la Poisson.
 *
 * 3 y no 2: con decenas de miles de partidos, una desviación de la Poisson del 1 % sale
 * «significativa» y no cambia ninguna probabilidad de forma visible. Lo que se busca no
 * es rechazar la hipótesis nula, es saber si vale la pena un parámetro más.
 */
const Z_FOR_NEGBIN = 3;

export function fitCounts(samples: number[]): CountModel | null {
  const n = samples.length;
  if (n < 100) return null;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return null;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const dispersion = variance / mean;

  // Contraste de dispersión: bajo Poisson, (n−1)·s²/x̄ se distribuye como una χ² con
  // n−1 grados de libertad, que para n grande es aproximadamente normal con media n−1 y
  // varianza 2(n−1). El z sale de ahí.
  const chi = ((n - 1) * variance) / mean;
  const z = (chi - (n - 1)) / Math.sqrt(2 * (n - 1));

  if (z <= Z_FOR_NEGBIN) {
    // Incluye el caso INFRAdisperso, y a propósito: ahí la binomial negativa no es que
    // no ayude, es que no puede — su varianza mínima es la de la Poisson. Decir Poisson
    // es reconocer que la familia se queda corta por el otro lado, no fingir que encaja.
    return { kind: 'poisson', mean, k: null, dispersion, z, n };
  }

  // Momentos para arrancar: var = μ + μ²/k  →  k = μ²/(var − μ).
  let k = (mean * mean) / Math.max(1e-9, variance - mean);
  // Y unos pasos de búsqueda sobre la verosimilitud, que es bastante mejor que momentos
  // cuando la cola es larga — que es justo el caso en el que se usa esta familia.
  k = refineK(samples, mean, k);
  return { kind: 'negbin', mean, k, dispersion, z, n };
}

function logGamma(x: number): number {
  // Lanczos. Precisión de sobra para lo que se usa aquí.
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Log-verosimilitud de la binomial negativa con media fija y forma k. */
function negBinLogLik(samples: number[], mean: number, k: number): number {
  if (!(k > 0) || !Number.isFinite(k)) return -Infinity;
  const p = k / (k + mean);
  let ll = 0;
  for (const x of samples) {
    ll += logGamma(x + k) - logGamma(k) - logGamma(x + 1) + k * Math.log(p) + x * Math.log(1 - p);
  }
  return ll;
}

/** Búsqueda ternaria sobre log(k). Unimodal en k, así que basta y no se atasca. */
function refineK(samples: number[], mean: number, start: number): number {
  let lo = Math.log(Math.max(0.05, start / 20));
  let hi = Math.log(Math.max(0.1, start * 20));
  for (let i = 0; i < 60; i++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (negBinLogLik(samples, mean, Math.exp(a)) < negBinLogLik(samples, mean, Math.exp(b))) lo = a;
    else hi = b;
  }
  return Math.exp((lo + hi) / 2);
}

/**
 * La distribución completa: P(0), P(1), … hasta `maxCount`, más la cola.
 *
 * Se devuelve la rejilla entera y no solo «más de X» porque de la rejilla salen TODOS
 * los mercados de ese conteo —más/menos de cualquier línea, el número exacto, los
 * hándicaps— y salen coherentes entre sí por construcción. Es el mismo principio que
 * sostiene la rejilla de marcadores.
 */
export function countPmf(model: CountModel, maxCount = 25): number[] {
  const out = new Array<number>(maxCount + 1).fill(0);
  if (model.kind === 'poisson') {
    let p = Math.exp(-model.mean);
    for (let i = 0; i <= maxCount; i++) {
      out[i] = p;
      p = (p * model.mean) / (i + 1);
    }
    return out;
  }
  const k = model.k as number;
  const prob = k / (k + model.mean);
  // P(0) = p^k, y de ahí la recurrencia P(x+1) = P(x) · (x+k)/(x+1) · (1−p).
  let p = Math.exp(k * Math.log(prob));
  for (let i = 0; i <= maxCount; i++) {
    out[i] = p;
    p = (p * (i + k) * (1 - prob)) / (i + 1);
  }
  return out;
}

/** P(cuenta > línea). La línea es del tipo 9.5, así que no hay empates que repartir. */
export function overCount(pmf: number[], line: number): number {
  let s = 0;
  for (let i = Math.ceil(line); i < pmf.length; i++) s += pmf[i];
  return s;
}

/**
 * Escala un modelo a otra media, conservando la forma.
 *
 * Es lo que permite ajustar la dispersión sobre TODA la liga —donde hay miles de
 * partidos— y luego aplicarla a un partido concreto con su propia media, donde hay
 * quince. Ajustar k partido a partido sería estimar un parámetro de cola con quince
 * observaciones, que es como no estimarlo.
 *
 * Para la binomial negativa se conserva k, no la dispersión relativa: k es el parámetro
 * del proceso (cuánta heterogeneidad hay entre partidos), mientras que var/media depende
 * de la media y cambiaría al escalar.
 */
export function withMean(model: CountModel, mean: number): CountModel {
  return { ...model, mean: Math.max(1e-6, mean) };
}

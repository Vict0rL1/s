// Conway-Maxwell-Poisson: la Poisson con un mando para la dispersión.
//
// ===========================================================================
// POR QUÉ HACE FALTA UNA TERCERA FAMILIA
// ===========================================================================
// La binomial negativa solo sabe AÑADIR varianza. Sirve para córners y tarjetas, donde
// se espera sobredispersión. No sirve para el problema que tiene este proyecto medido y
// escrito desde hace tiempo en model.ts: los goles de un equipo EN UNA MITAD están
// INFRAdispersos, y ahí la binomial negativa no es que no ayude, es que empuja al revés.
//
// Medido sobre 24.778 partidos, comparando lo observado con una Poisson que tiene la
// media correcta por construcción (la λ del Dixon-Coles, repartida con la cuota medida):
//
//     goles del local en la 1ª parte    real      Poisson    diferencia
//     0                                47,93 %    51,98 %     −4,05 pp
//     1                                37,00 %    33,30 %     +3,70 pp
//     2 o más                          15,07 %    14,72 %     +0,35 pp
//
// Menos ceros y más unos, con la misma cola y la misma media: eso es exactamente la
// firma de la infradispersión. Una mitad de fútbol es más «regular» que un proceso de
// Poisson — hay algo parecido a un ritmo, y los sucesos no llegan del todo al azar.
//
// El ajuste por máxima verosimilitud sobre 40.324 muestras equipo-mitad de
// entrenamiento da ν = 1,30 (`npm run study:thin`), con log-verosimilitud −40.698,7
// contra −40.809,0 de la Poisson.
//
// ===========================================================================
// LA FORMA
// ===========================================================================
//     P(x) = λ^x / ( (x!)^ν · Z(λ, ν) )        Z = Σ λ^x / (x!)^ν
//
//     ν = 1   Poisson exacta
//     ν > 1   INFRAdispersa: la masa se concentra alrededor de la media
//     ν < 1   sobredispersa (ν = 0 con λ < 1 es la geométrica)
//
// ===========================================================================
// EL DETALLE QUE MÁS SE EQUIVOCA
// ===========================================================================
// λ NO ES LA MEDIA salvo cuando ν = 1. Meterle la media del modelo directamente como λ
// da una distribución con OTRA media, y entonces se ha cambiado el pronóstico —no la
// forma— sin querer. Aquí `comPoissonForMean` resuelve la λ que produce la media pedida,
// así que cambiar ν cambia la forma y deja la media donde estaba. Es lo único que
// permite decir «la media viene del Dixon-Coles y la forma de aquí» y que sea verdad.

/** Hasta dónde se calcula la normalización. Con las medias de este proyecto sobra. */
const MAX_X = 30;

export interface ComPoisson {
  /** OJO: no es la media salvo si ν = 1. Ver `comPoissonForMean`. */
  lambda: number;
  /** Dispersión. >1 concentra, <1 dispersa, 1 = Poisson. */
  nu: number;
}

/** log(x!) acumulado, memorizado: se llama millones de veces en un backtest. */
const LOG_FACT: number[] = (() => {
  const out = [0];
  for (let i = 1; i <= MAX_X + 1; i++) out.push(out[i - 1] + Math.log(i));
  return out;
})();

/**
 * La distribución completa, normalizada.
 *
 * Se calcula en logaritmos y se resta el máximo antes de exponenciar: con ν pequeña y λ
 * grande los términos sin normalizar se desbordan, y un Infinity aquí sale por la otra
 * punta como una probabilidad NaN en una tarjeta.
 */
export function comPoissonPmf(p: ComPoisson, maxX = MAX_X): number[] {
  const logLambda = Math.log(Math.max(1e-12, p.lambda));
  const logs = new Array<number>(maxX + 1);
  for (let x = 0; x <= maxX; x++) logs[x] = x * logLambda - p.nu * LOG_FACT[x];
  const max = Math.max(...logs);
  const raw = logs.map((l) => Math.exp(l - max));
  const z = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / z);
}

export function comPoissonMean(p: ComPoisson, maxX = MAX_X): number {
  const pmf = comPoissonPmf(p, maxX);
  let m = 0;
  for (let x = 0; x <= maxX; x++) m += x * pmf[x];
  return m;
}

export function comPoissonVariance(p: ComPoisson, maxX = MAX_X): number {
  const pmf = comPoissonPmf(p, maxX);
  let m = 0;
  let m2 = 0;
  for (let x = 0; x <= maxX; x++) {
    m += x * pmf[x];
    m2 += x * x * pmf[x];
  }
  return m2 - m * m;
}

/**
 * La λ que produce la media pedida, para una ν dada.
 *
 * La media crece de forma monótona con λ, así que una bisección basta y no puede quedar
 * atrapada. 60 iteraciones dejan el error muy por debajo de lo que cualquier pantalla
 * distingue.
 */
export function comPoissonForMean(mean: number, nu: number): ComPoisson {
  if (nu === 1) return { lambda: mean, nu: 1 };
  let lo = 1e-9;
  let hi = Math.max(1, mean) * 10;
  // Asegurar que el extremo alto pasa de la media buscada antes de bisecar.
  for (let i = 0; i < 40 && comPoissonMean({ lambda: hi, nu }) < mean; i++) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (comPoissonMean({ lambda: mid, nu }) < mean) lo = mid;
    else hi = mid;
  }
  return { lambda: (lo + hi) / 2, nu };
}

/**
 * Ajustar ν por máxima verosimilitud sobre casos con media CONOCIDA y distinta cada uno.
 *
 * Ese «distinta cada uno» es lo que hace que no valga un ajuste de libro: cada partido
 * tiene su propia media —la del modelo— y lo que se busca es la ν común que mejor
 * describe la forma alrededor de esas medias. Ajustar ν sobre la muestra agregada
 * mediría la heterogeneidad ENTRE partidos en vez de la dispersión DENTRO de cada uno,
 * que es justo la confusión que hace que el total parezca infradisperso (var/media 0,80)
 * cuando cada equipo por separado está en 0,96.
 */
export function fitNu(
  samples: { mean: number; observed: number }[],
  grid = { lo: 0.6, hi: 2.2, steps: 33 },
): { nu: number; logLik: number; byNu: { nu: number; logLik: number }[] } | null {
  if (samples.length < 200) return null;
  const byNu: { nu: number; logLik: number }[] = [];
  // Las medias se redondean para poder reutilizar la pmf: sin esto son cientos de miles
  // de bisecciones y el ajuste tarda minutos en vez de segundos. El redondeo a la
  // milésima mueve la log-verosimilitud en el sexto decimal.
  const rounded = samples.map((s) => ({ key: Math.round(s.mean * 1000) / 1000, x: s.observed }));
  for (let i = 0; i < grid.steps; i++) {
    const nu = grid.lo + ((grid.hi - grid.lo) * i) / (grid.steps - 1);
    const cache = new Map<number, number[]>();
    let ll = 0;
    for (const s of rounded) {
      let pmf = cache.get(s.key);
      if (!pmf) {
        pmf = comPoissonPmf(comPoissonForMean(s.key, nu), 12);
        cache.set(s.key, pmf);
      }
      ll += Math.log(Math.max(1e-12, pmf[Math.min(s.x, 12)]));
    }
    byNu.push({ nu, logLik: ll });
  }
  const best = byNu.reduce((a, b) => (b.logLik > a.logLik ? b : a));
  return { nu: best.nu, logLik: best.logLik, byNu };
}

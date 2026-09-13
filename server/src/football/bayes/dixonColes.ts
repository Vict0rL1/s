// Dixon-Coles jerárquico: ataque y defensa por equipo, ajustados sobre los goles.
//
// ===========================================================================
// QUÉ CAMBIA RESPECTO A LO QUE YA HABÍA
// ===========================================================================
// La app YA producía una rejilla completa de marcadores con la corrección de
// Dixon-Coles, y de ahí salían el 1X2, el over/under y el «ambos marcan». Lo que NO
// tenía es de dónde salen las dos λ: venían del Elo, que resume a un equipo en UN
// número y luego lo reparte entre ataque y defensa con una proporción fija.
//
// Eso es una suposición fuerte y falsa. Un equipo que gana 1-0 todas las semanas y otro
// que gana 3-2 pueden tener el mismo Elo y distribuciones de marcador completamente
// distintas, y todo lo que se derive de la rejilla —el over, el BTTS, el hándicap— sale
// mal para los dos. Este fichero estima ataque y defensa POR SEPARADO, directamente de
// los goles.
//
// ===========================================================================
// EL MODELO
// ===========================================================================
// Para un partido del equipo i en casa contra el j:
//
//     λ = exp(μ + ataque_i + defensa_j + γ)      goles del local
//     m = exp(μ + ataque_j + defensa_i)          goles del visitante
//
// μ es el nivel de goles de la liga, γ la ventaja de campo, y `defensa` va con signo
// POSITIVO = encaja más. Los goles se distribuyen Poisson con la corrección de
// Dixon-Coles sobre los cuatro marcadores bajos:
//
//     τ(0,0) = 1 − λmρ     τ(0,1) = 1 + λρ     τ(1,0) = 1 + mρ     τ(1,1) = 1 − ρ
//
// con ρ negativo, que es lo que sube 0-0 y 1-1 por encima de lo que da la Poisson
// independiente. Es la única parte que ya estaba y se conserva tal cual.
//
// ===========================================================================
// DECAY TEMPORAL
// ===========================================================================
// Cada partido pesa exp(−ξ · días de antigüedad). Un partido de hace tres años dice
// algo sobre el club, pero no sobre esta plantilla, y sin el decay pesa lo mismo que el
// del sábado pasado. ξ se elige midiendo, no a ojo — ver `study:dc`.
//
// ===========================================================================
// PRIORS JERÁRQUICOS: PARA QUÉ SIRVEN DE VERDAD
// ===========================================================================
// ataque_i ~ N(0, σ_a²) y defensa_i ~ N(0, σ_d²). En la práctica eso es un término
// −Σataque²/(2σ_a²) en la función objetivo, o sea una penalización que empuja a cada
// equipo hacia la media de su liga.
//
// El sitio donde se nota no es el equipo con 200 partidos —ese tiene datos de sobra y la
// penalización apenas lo mueve— sino el recién ascendido con cuatro. Sin prior, cuatro
// partidos con seis goles a favor dan un ataque disparatado y el modelo publica un 4-1
// como marcador más probable. Con prior, esos cuatro partidos mueven la estimación lo
// que cuatro partidos pueden mover, y el resto lo pone la liga.
//
// Esto sustituye a lo que este proyecto hacía antes por otro camino —el salto de
// división medido en promotion.ts—, que resolvía el mismo problema para el caso
// concreto del ascenso. El encogimiento jerárquico lo resuelve para todos los casos, y
// de forma continua en vez de por categorías.
//
// ===========================================================================
// CÓMO SE AJUSTA
// ===========================================================================
// Máximo a posteriori: se maximiza la verosimilitud ponderada más los priors, por
// ascenso de gradiente con Adam. No es MCMC y no pretende serlo — no hay distribución
// posterior completa, hay una moda. Para lo que la app necesita (una rejilla de
// marcadores por partido) la moda basta, y una cadena de Markov por liga y por jornada
// no cabe en el tiempo que hay entre que se publican las alineaciones y empieza el
// partido.
//
// Los gradientes son analíticos. Con ~40 equipos por liga son ~85 parámetros y unos
// pocos miles de partidos: cada ajuste es cuestión de milisegundos.

/** Un partido, tal y como lo necesita el ajuste. */
export interface DcMatch {
  /** YYYYMMDD. */
  date: string;
  homeId: string;
  awayId: string;
  homeGoals: number;
  awayGoals: number;
}

export interface DcHyper {
  /**
   * Decay por día. 0 = sin decay.
   *
   * Se piensa mejor en semivida: ξ = ln2 / semivida_en_días.
   */
  xi: number;
  /** Desviación del prior sobre el ataque. Menor = encoge más. */
  sigmaAttack: number;
  /** Desviación del prior sobre la defensa. */
  sigmaDefence: number;
}

export interface DcParams {
  /** Nivel de goles de la liga, en log. */
  mu: number;
  /** Ventaja de campo, en log. */
  gamma: number;
  /** Corrección de marcadores bajos. Negativa en fútbol real. */
  rho: number;
  attack: Map<string, number>;
  defence: Map<string, number>;
  hyper: DcHyper;
  /** Partidos que vio el ajuste. */
  matches: number;
  /**
   * Suma de los pesos. Con decay es mucho menor que `matches` y es el número que
   * de verdad dice cuánta información hay detrás.
   */
  effectiveMatches: number;
  /** Fecha hasta la que se ajustó, YYYYMMDD. */
  through: string;
}

/**
 * ρ se mantiene en un rango donde τ no puede volverse negativo.
 *
 * τ(0,0) = 1 − λmρ, y con λ y m realistas (hasta ~4 goles esperados) un ρ de ±0.2
 * deja τ holgadamente positivo. Sin el tope, el optimizador puede empujar ρ hasta
 * hacer negativa una probabilidad, que es un estado del que la verosimilitud no
 * vuelve porque el logaritmo explota.
 */
const RHO_LIMIT = 0.2;

/** Días entre dos fechas YYYYMMDD. */
function daysBetween(from: string, to: string): number {
  const d = (s: string): number =>
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return (d(to) - d(from)) / 86_400_000;
}

/**
 * La corrección de Dixon-Coles y sus derivadas, en una sola pasada.
 *
 * Se devuelven juntas porque el gradiente las necesita todas y calcularlas por
 * separado significaría repetir el mismo `switch` cuatro veces — y, peor, tener cuatro
 * sitios donde el signo de ρ se puede escribir al revés.
 */
function tauAndGrad(
  x: number,
  y: number,
  lambda: number,
  mu: number,
  rho: number,
): { tau: number; dLambda: number; dMu: number; dRho: number } {
  if (x === 0 && y === 0) {
    return { tau: 1 - lambda * mu * rho, dLambda: -mu * rho, dMu: -lambda * rho, dRho: -lambda * mu };
  }
  if (x === 0 && y === 1) return { tau: 1 + lambda * rho, dLambda: rho, dMu: 0, dRho: lambda };
  if (x === 1 && y === 0) return { tau: 1 + mu * rho, dLambda: 0, dMu: rho, dRho: mu };
  if (x === 1 && y === 1) return { tau: 1 - rho, dLambda: 0, dMu: 0, dRho: -1 };
  return { tau: 1, dLambda: 0, dMu: 0, dRho: 0 };
}

/** El estado interno del optimizador: los parámetros en vectores planos. */
interface Fit {
  ids: string[];
  index: Map<string, number>;
  attack: Float64Array;
  defence: Float64Array;
  mu: number;
  gamma: number;
  rho: number;
}

/**
 * Ajustar el modelo a un conjunto de partidos, con los pesos del decay.
 *
 * `asOf` es la fecha desde la que se mira hacia atrás: los pesos son
 * exp(−ξ · días antes de asOf). Se pasa explícitamente en vez de usar «hoy» porque el
 * backtest tiene que poder ajustar como si fuera una fecha pasada, y un modelo que
 * mira el reloj del sistema no se puede evaluar hacia atrás.
 */
export function fitDixonColes(
  matches: DcMatch[],
  asOf: string,
  hyper: DcHyper,
  opts: { iterations?: number; warmStart?: DcParams; learningRate?: number } = {},
): DcParams | null {
  if (matches.length === 0) return null;

  const ids = [...new Set(matches.flatMap((m) => [m.homeId, m.awayId]))].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  const f: Fit = {
    ids,
    index,
    attack: new Float64Array(n),
    defence: new Float64Array(n),
    // Arranque razonable: 1.35 goles por equipo y partido es la media del fútbol de
    // liga, y la ventaja de campo vale en torno a un 25 % más de goles para el local.
    mu: Math.log(1.35),
    gamma: 0.25,
    rho: -0.05,
  };
  // Arranque en caliente desde el ajuste anterior. Es lo que hace viable reajustar
  // cada pocas jornadas en un backtest de seis temporadas: partiendo de la solución
  // de hace un mes hacen falta ~20 iteraciones en vez de ~300.
  if (opts.warmStart) {
    f.mu = opts.warmStart.mu;
    f.gamma = opts.warmStart.gamma;
    f.rho = opts.warmStart.rho;
    for (let i = 0; i < n; i++) {
      f.attack[i] = opts.warmStart.attack.get(ids[i]) ?? 0;
      f.defence[i] = opts.warmStart.defence.get(ids[i]) ?? 0;
    }
  }

  // Pesos y filtrado: un partido posterior a `asOf` no existe todavía.
  const rows: { hi: number; ai: number; x: number; y: number; w: number }[] = [];
  let weightSum = 0;
  for (const m of matches) {
    if (m.date > asOf) continue;
    const age = daysBetween(m.date, asOf);
    if (age < 0) continue;
    const w = hyper.xi > 0 ? Math.exp(-hyper.xi * age) : 1;
    // Un peso por debajo de 1e-4 no mueve nada y sí cuesta tiempo: con seis
    // temporadas y decay fuerte, saltárselos recorta el ajuste a la mitad.
    if (w < 1e-4) continue;
    rows.push({
      hi: index.get(m.homeId)!,
      ai: index.get(m.awayId)!,
      x: m.homeGoals,
      y: m.awayGoals,
      w,
    });
    weightSum += w;
  }
  if (rows.length === 0) return null;

  const iterations = opts.iterations ?? (opts.warmStart ? 60 : 400);
  const lr = opts.learningRate ?? 0.05;
  // Adam. Momento y escala adaptativa, que es lo que permite usar el mismo paso para
  // μ —que se mueve poco— y para el ataque de un equipo con cuatro partidos.
  const b1 = 0.9;
  const b2 = 0.999;
  const eps = 1e-8;
  const size = 2 * n + 3;
  const m1 = new Float64Array(size);
  const m2 = new Float64Array(size);
  const grad = new Float64Array(size);
  // Índices al final del vector plano.
  const MU = 2 * n;
  const GAMMA = 2 * n + 1;
  const RHO = 2 * n + 2;

  const invVarA = 1 / (hyper.sigmaAttack * hyper.sigmaAttack);
  const invVarD = 1 / (hyper.sigmaDefence * hyper.sigmaDefence);

  for (let it = 1; it <= iterations; it++) {
    grad.fill(0);

    for (const r of rows) {
      const lambda = Math.exp(f.mu + f.attack[r.hi] + f.defence[r.ai] + f.gamma);
      const mu = Math.exp(f.mu + f.attack[r.ai] + f.defence[r.hi]);
      const t = tauAndGrad(r.x, r.y, lambda, mu, f.rho);
      // τ acotado por abajo: con ρ dentro de su rango no debería hacer falta, pero un
      // log(0) aquí destruiría el ajuste entero y el coste de la guarda es nulo.
      const tau = Math.max(t.tau, 1e-9);

      // ∂ℓ/∂(log λ) = (x − λ) + λ·(∂τ/∂λ)/τ   — la regla de la cadena por exp().
      const gLambda = r.w * (r.x - lambda + (lambda * t.dLambda) / tau);
      const gMu = r.w * (r.y - mu + (mu * t.dMu) / tau);

      grad[r.hi] += gLambda; // ataque del local sube λ
      grad[n + r.ai] += gLambda; // defensa del visitante sube λ
      grad[r.ai] += gMu; // ataque del visitante sube m
      grad[n + r.hi] += gMu; // defensa del local sube m
      grad[MU] += gLambda + gMu;
      grad[GAMMA] += gLambda;
      grad[RHO] += (r.w * t.dRho) / tau;
    }

    // Los priors. Esta es la parte jerárquica y es literalmente esto: un tirón hacia
    // cero proporcional a lo lejos que esté el equipo, dividido por la varianza del
    // prior. Con σ grande casi no tira; con σ pequeña, encoge fuerte.
    for (let i = 0; i < n; i++) {
      grad[i] -= f.attack[i] * invVarA;
      grad[n + i] -= f.defence[i] * invVarD;
    }

    const c1 = 1 - Math.pow(b1, it);
    const c2 = 1 - Math.pow(b2, it);
    for (let k = 0; k < size; k++) {
      m1[k] = b1 * m1[k] + (1 - b1) * grad[k];
      m2[k] = b2 * m2[k] + (1 - b2) * grad[k] * grad[k];
      const step = (lr * (m1[k] / c1)) / (Math.sqrt(m2[k] / c2) + eps);
      if (k < n) f.attack[k] += step;
      else if (k < 2 * n) f.defence[k - n] += step;
      else if (k === MU) f.mu += step;
      else if (k === GAMMA) f.gamma += step;
      else f.rho += step;
    }
    f.rho = Math.min(RHO_LIMIT, Math.max(-RHO_LIMIT, f.rho));

    // Identificabilidad. ataque y defensa solo están determinados hasta una constante:
    // sumar 0.1 a todos los ataques y restarlo de μ da exactamente el mismo modelo. Sin
    // recentrar, esa dirección plana hace que los parámetros deriven sin límite y que
    // los priors —que penalizan la DISTANCIA A CERO— acaben castigando una posición
    // arbitraria en vez de la distancia a la media de la liga.
    let ma = 0;
    let md = 0;
    for (let i = 0; i < n; i++) {
      ma += f.attack[i];
      md += f.defence[i];
    }
    ma /= n;
    md /= n;
    for (let i = 0; i < n; i++) {
      f.attack[i] -= ma;
      f.defence[i] -= md;
    }
    f.mu += ma + md;
  }

  return {
    mu: f.mu,
    gamma: f.gamma,
    rho: f.rho,
    attack: new Map(ids.map((id, i) => [id, f.attack[i]])),
    defence: new Map(ids.map((id, i) => [id, f.defence[i]])),
    hyper,
    matches: rows.length,
    effectiveMatches: weightSum,
    through: asOf,
  };
}

/**
 * Las dos λ de un partido concreto.
 *
 * Un equipo que el ajuste no vio recibe 0 de ataque y 0 de defensa, que en este modelo
 * NO es «desconocido» sino «exactamente la media de la liga». Es la respuesta correcta:
 * es lo que el prior dice antes de ver un solo partido suyo, y es mucho mejor que
 * negarse a predecir.
 */
export function expectedGoalsDc(
  p: DcParams,
  homeId: string,
  awayId: string,
  opts: { neutral?: boolean } = {},
): { home: number; away: number } {
  const ah = p.attack.get(homeId) ?? 0;
  const dh = p.defence.get(homeId) ?? 0;
  const aa = p.attack.get(awayId) ?? 0;
  const da = p.defence.get(awayId) ?? 0;
  const g = opts.neutral ? 0 : p.gamma;
  return {
    home: Math.exp(p.mu + ah + da + g),
    away: Math.exp(p.mu + aa + dh),
  };
}

/** Log-verosimilitud media (sin priors) de un conjunto, para comparar ajustes. */
export function logLikelihood(p: DcParams, matches: DcMatch[]): number {
  let total = 0;
  let n = 0;
  for (const m of matches) {
    const { home: lambda, away: mu } = expectedGoalsDc(p, m.homeId, m.awayId);
    const t = tauAndGrad(m.homeGoals, m.awayGoals, lambda, mu, p.rho);
    const lp =
      Math.log(Math.max(t.tau, 1e-12)) +
      m.homeGoals * Math.log(lambda) -
      lambda -
      lgamma(m.homeGoals + 1) +
      m.awayGoals * Math.log(mu) -
      mu -
      lgamma(m.awayGoals + 1);
    total += lp;
    n++;
  }
  return n > 0 ? total / n : 0;
}

/** log(n!) para n entero pequeño. Los goles no pasan de 15 en la práctica. */
function lgamma(n: number): number {
  let s = 0;
  for (let k = 2; k < n; k++) s += Math.log(k);
  return s;
}

// El objetivo de latencia, por etapas, y cuándo hay que gritar.
//
// ===========================================================================
// QUÉ SE ESTÁ MIDIENDO, EXACTAMENTE
// ===========================================================================
// Desde que una casa publica un precio hasta que ese precio está en la pantalla hay
// cuatro tramos, y tienen dueños distintos:
//
//   ORIGEN     la casa publica  →  nosotros tenemos ese precio en la mano
//   INGESTA    lo tenemos       →  está escrito en la base
//   SERVIDOR   llega la petición del navegador  →  sale la respuesta
//   CLIENTE    llega la respuesta →  está pintado
//
// El total es la suma, pero el total NO es lo accionable. Si tardas ocho minutos, lo
// único que sirve es saber en cuál de los cuatro se van — y en esta app se van, casi
// enteros, en el primero.
//
// ===========================================================================
// LO QUE NO SE PUEDE SEPARAR, Y HAY QUE DECIRLO
// ===========================================================================
// ORIGEN son en realidad DOS cosas pegadas: «la casa publica → la API se entera» y «la
// API lo tiene → nosotros lo pedimos». No se pueden separar porque el proveedor NO
// sella cuándo recibió él el precio: devuelve `last_update`, que es la marca de la CASA.
// Así que lo que se mide es la suma de las dos, y se llama ORIGEN para no fingir una
// precisión que no hay.
//
// Dicho eso, se sabe cuál de las dos domina. La segunda mitad es, en media, medio
// intervalo de sondeo: sondeando cada 12 horas —el valor por defecto que traía esta
// app— un precio tiene de media SEIS HORAS cuando lo lees. Ninguna optimización de
// parseo o de red compite con eso; por eso el trabajo de verdad está en la cadencia.
//
// ===========================================================================
// EL OBJETIVO NO PUEDE SER UN NÚMERO ÚNICO
// ===========================================================================
// Con el plan gratuito de The Odds API son 500 peticiones al MES. Sondear un solo
// deporte cada minuto son 43.200. El objetivo depende del plan, y prometer «30
// segundos» a quien tiene 500 peticiones sería mentir con una constante.
//
// Así que el objetivo se declara y se compara contra lo que el plan permite. Si no se
// puede cumplir, el sistema lo dice en vez de fallar en silencio contra un listón que
// nunca fue alcanzable.

/** Los cuatro tramos. El orden es el del recorrido, y así se imprimen. */
export const STAGES = ['origen', 'ingesta', 'servidor', 'cliente'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  origen: 'la casa publica → lo tenemos',
  ingesta: 'lo tenemos → escrito en la base',
  servidor: 'petición → respuesta',
  cliente: 'respuesta → pintado',
};

export const STAGE_OWNER: Record<Stage, string> = {
  origen: 'la cadencia de sondeo y el proveedor',
  ingesta: 'nuestro parseo y la base de datos',
  servidor: 'nuestra API',
  cliente: 'la red y el navegador',
};

export interface LatencyBudget {
  /** Objetivo total, de la casa a la pantalla, en milisegundos. */
  totalMs: number;
  /** Reparto por etapa. Suma `totalMs`. */
  perStage: Record<Stage, number>;
}

/**
 * El objetivo por defecto: 5 minutos de punta a punta.
 *
 * De dónde sale ese 5, que no es redondo por casualidad. Un precio de fútbol
 * pre-partido se mueve en escala de minutos a horas, no de segundos; lo que hace daño
 * no es llegar 30 segundos tarde, es llegar cuando la línea ya se movió entera. Cinco
 * minutos es el punto donde un movimiento típico todavía es accionable, y a la vez es
 * alcanzable con un plan de pago modesto sin quemarlo.
 *
 * El reparto es deliberadamente asimétrico: 4 de los 5 minutos se le dan a ORIGEN
 * porque ahí es donde se va el tiempo de verdad, y apretar las otras tres etapas por
 * debajo de lo que ya tardan sería optimizar lo que no duele.
 */
export const DEFAULT_BUDGET: LatencyBudget = {
  totalMs: 5 * 60_000,
  perStage: {
    origen: 4 * 60_000,
    ingesta: 30_000,
    servidor: 20_000,
    cliente: 10_000,
  },
};

export function budgetFromEnv(): LatencyBudget {
  const total = Number(process.env.LATENCY_TARGET_MS);
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_BUDGET;
  // El reparto se escala manteniendo las proporciones: quien cambia el objetivo está
  // diciendo «quiero esto entero más rápido», no «quiero repartirlo de otra forma».
  const f = total / DEFAULT_BUDGET.totalMs;
  return {
    totalMs: total,
    perStage: {
      origen: DEFAULT_BUDGET.perStage.origen * f,
      ingesta: DEFAULT_BUDGET.perStage.ingesta * f,
      servidor: DEFAULT_BUDGET.perStage.servidor * f,
      cliente: DEFAULT_BUDGET.perStage.cliente * f,
    },
  };
}

/**
 * ¿Es siquiera alcanzable el objetivo con este plan?
 *
 * La latencia de ORIGEN no puede bajar de medio intervalo de sondeo en media, y el
 * intervalo lo fija el presupuesto de peticiones. Así que este cálculo dice si el
 * objetivo es física o solo presupuestariamente imposible — y esa distinción importa,
 * porque una se arregla con dinero y la otra no se arregla.
 *
 * @param requestsPerMonth  el tamaño del plan
 * @param requestsPerCycle  lo que cuesta refrescar todo una vez
 */
export function reachable(
  budget: LatencyBudget,
  requestsPerMonth: number | null,
  requestsPerCycle: number | null,
): { ok: boolean; bestPossibleMs: number | null; reason: string } {
  if (requestsPerMonth == null || requestsPerCycle == null || requestsPerCycle <= 0) {
    return {
      ok: true,
      bestPossibleMs: null,
      reason: 'sin datos del plan todavía: se sabrá tras el primer ciclo.',
    };
  }
  const cyclesPerMonth = requestsPerMonth / requestsPerCycle;
  const minutesBetween = 43_200 / cyclesPerMonth;
  // La antigüedad MEDIA de un precio es medio intervalo: llega uniformemente entre dos
  // sondeos. La peor es el intervalo entero.
  const bestPossibleMs = (minutesBetween / 2) * 60_000;
  if (bestPossibleMs <= budget.perStage.origen) {
    return {
      ok: true,
      bestPossibleMs,
      reason:
        `El plan da para sondear cada ${minutesBetween.toFixed(0)} min, o sea una ` +
        `antigüedad media de ${(bestPossibleMs / 60_000).toFixed(1)} min. Cabe en el objetivo.`,
    };
  }
  return {
    ok: false,
    bestPossibleMs,
    reason:
      `NO alcanzable con este plan. ${requestsPerMonth} peticiones al mes y ` +
      `${requestsPerCycle} por ciclo dan un sondeo cada ${minutesBetween.toFixed(0)} min, ` +
      `o sea ${(bestPossibleMs / 60_000).toFixed(1)} min de antigüedad media frente a los ` +
      `${(budget.perStage.origen / 60_000).toFixed(1)} del objetivo. Se arregla con un plan ` +
      'mayor o sondeando menos deportes, no con código.',
  };
}

// Avisar cuando la latencia se sale del objetivo, y empujar los cambios a la pantalla.
//
// ===========================================================================
// DOS COSAS DISTINTAS QUE VIVEN JUNTAS
// ===========================================================================
//   1. LA ALERTA DE LATENCIA. El objetivo se declara en budget.ts; aquí se comprueba
//      contra lo medido y se avisa si se pasa, diciendo QUÉ etapa se lo comió. Un aviso
//      que solo dice «vas lento» no sirve para nada.
//
//   2. EL EMPUJE A LA PANTALLA. Server-Sent Events: el servidor abre una conexión y
//      escribe cuando pasa algo. Sustituye al refresco manual, que es la última etapa
//      de latencia y la más tonta — un precio puede estar en la base desde hace veinte
//      minutos y no estar en la pantalla porque nadie ha pulsado nada.
//
// ===========================================================================
// POR QUÉ SSE Y NO WEBSOCKET AQUÍ
// ===========================================================================
// Entre NUESTRO servidor y el navegador el tráfico va en una sola dirección: el
// servidor avisa, el navegador escucha. Para eso SSE es exactamente lo que hace falta y
// un WebSocket es una dependencia y un protocolo de más. SSE además reconecta solo —el
// navegador lo hace por ti— y atraviesa proxies que a veces rompen los WebSocket.
//
// (Que el proveedor de cuotas no ofrezca WebSocket, que es otra cosa, se comprueba en
// transport.ts. Son dos tramos distintos del recorrido y no hay que confundirlos.)

import { budgetFromEnv, STAGE_LABEL, STAGE_OWNER, type Stage } from './budget.ts';
import { stageStats, totalP95 } from './record.ts';

export interface LatencyAlert {
  /**
   * `true` solo cuando se ha medido lo suficiente Y se pasa.
   *
   * Con etapas sin muestras esto es `false`, y eso NO significa que se cumpla el
   * objetivo: significa que no se sabe. Por eso existe `complete` al lado — un panel
   * que enseñe un ✓ verde por no haber medido nada es peor que uno que no enseñe nada.
   */
  breached: boolean;
  /** ¿Hay muestras de las cuatro etapas? Sin esto, `breached` no se puede interpretar. */
  complete: boolean;
  totalMs: number;
  targetMs: number;
  /** Las etapas que se pasaron de su parte del presupuesto, la peor primero. */
  offenders: { stage: Stage; p95: number; budget: number; overBy: number; owner: string }[];
  message: string;
}

export function checkLatency(hours = 24): LatencyAlert {
  const budget = budgetFromEnv();
  const stats = stageStats(hours);
  const total = totalP95(hours);

  const offenders = stats
    .filter((s) => s.n > 0 && s.p95 > budget.perStage[s.stage])
    .map((s) => ({
      stage: s.stage,
      p95: s.p95,
      budget: budget.perStage[s.stage],
      overBy: s.p95 - budget.perStage[s.stage],
      owner: STAGE_OWNER[s.stage],
    }))
    .sort((a, b) => b.overBy - a.overBy);

  // Solo se puede declarar incumplimiento con la medición completa: si falta una etapa,
  // el total está por debajo del real y un «se cumple» sería una afirmación falsa.
  const breached = total.complete && total.ms > budget.totalMs;
  const fmt = (ms: number): string =>
    ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;

  let message: string;
  if (!total.complete) {
    message =
      `Medición incompleta: sin muestras de ${total.missing.join(', ')}. ` +
      'El total de abajo es solo de las etapas que sí se han medido.';
  } else if (!breached) {
    message = `Dentro del objetivo: ${fmt(total.ms)} de ${fmt(budget.totalMs)} (p95).`;
  } else {
    const worst = offenders[0];
    message =
      `FUERA DEL OBJETIVO: ${fmt(total.ms)} contra ${fmt(budget.totalMs)}. ` +
      (worst
        ? `Lo que más se pasa es «${STAGE_LABEL[worst.stage]}» (${fmt(worst.p95)} frente a ` +
          `${fmt(worst.budget)} de presupuesto), y eso depende de ${worst.owner}.`
        : 'Ninguna etapa se pasa por su cuenta: es la suma la que no cabe.');
  }

  return {
    breached,
    complete: total.complete,
    totalMs: total.ms,
    targetMs: budget.totalMs,
    offenders,
    message,
  };
}

// ===========================================================================
// EL CANAL DE EMPUJE
// ===========================================================================

export interface PushEvent {
  type: 'odds' | 'latency';
  /** Qué cambió, en una línea que se pueda enseñar en una notificación. */
  title: string;
  body: string;
  /** El partido, para poder abrirlo desde la notificación. */
  fixtureId?: string;
  at: string;
}

type Subscriber = (e: PushEvent) => void;
const subscribers = new Set<Subscriber>();

/**
 * Últimos eventos, para que un cliente que acaba de conectarse no llegue a un canal
 * mudo. Corto a propósito: esto es un canal en vivo, no un historial.
 */
const recent: PushEvent[] = [];
const RECENT_MAX = 20;

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function publish(e: PushEvent): void {
  recent.push(e);
  if (recent.length > RECENT_MAX) recent.shift();
  for (const fn of subscribers) {
    try {
      fn(e);
    } catch {
      // Un suscriptor que revienta no puede tumbar a los demás ni al ciclo de odds.
    }
  }
}

export function recentEvents(): PushEvent[] {
  return [...recent];
}

export function subscriberCount(): number {
  return subscribers.size;
}

// El panel de latencia y el canal de empuje.
//
// Dos endpoints:
//   GET /api/latency         — el desglose por etapas, el objetivo y si se cumple
//   GET /api/latency/stream  — SSE: el servidor avisa cuando cambia un precio
//   POST /api/latency/client — el navegador cuenta cuánto tardó en pintar

import type { FastifyInstance } from 'fastify';
import { budgetFromEnv, STAGE_LABEL, STAGE_OWNER, STAGES } from '../latency/budget.ts';
import { reachable } from '../latency/budget.ts';
import { stageStats, totalP95, recordLatency } from '../latency/record.ts';
import { checkLatency, subscribe, recentEvents, subscriberCount } from '../latency/alert.ts';
import { currentTransport } from '../latency/transport.ts';
import { allocate } from '../latency/schedule.ts';
import { planTotal, lastCycleCredits } from '../oddsQuota.ts';

export async function registerLatencyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    const hours = Number((req.query as { hours?: string }).hours) || 24;
    const budget = budgetFromEnv();
    const stats = stageStats(hours);
    const total = totalP95(hours);
    const alert = checkLatency(hours);
    const plan = planTotal();
    const perCycle = lastCycleCredits();
    const feasible = reachable(budget, plan, perCycle);
    const perDay = plan != null ? plan / 30 : 0;

    return {
      windowHours: hours,
      target: {
        totalMs: budget.totalMs,
        perStage: budget.perStage,
        // Si el objetivo no es alcanzable con el plan, decirlo aquí y no en una nota al
        // pie: incumplir un listón imposible no es un fallo del código.
        feasible,
      },
      stages: stats.map((s) => ({
        ...s,
        label: STAGE_LABEL[s.stage],
        owner: STAGE_OWNER[s.stage],
        budgetMs: budget.perStage[s.stage],
        overBudget: s.n > 0 && s.p95 > budget.perStage[s.stage],
      })),
      total: {
        p95Ms: total.ms,
        complete: total.complete,
        missing: total.missing,
      },
      alert,
      transport: currentTransport(),
      schedule: perCycle ? allocate(perDay, perCycle) : null,
      push: { subscribers: subscriberCount(), recent: recentEvents() },
    };
  });

  /**
   * El canal de empuje. Sustituye al refresco manual, que es la etapa de latencia más
   * tonta de todas: un precio puede llevar veinte minutos en la base y no estar en la
   * pantalla porque nadie ha pulsado nada.
   *
   * SSE y no WebSocket porque el tráfico va en una sola dirección y el navegador
   * reconecta solo. `hijack()` saca la respuesta del ciclo normal de Fastify: esta
   * conexión no se cierra al terminar el handler, se queda abierta.
   */
  app.get('/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Sin esto, un proxy con buffer se queda los eventos hasta llenar su búfer y el
      // canal «en vivo» llega en ráfagas de diez minutos.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: unknown): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Un comentario inicial abre el flujo: sin él, algunos navegadores no consideran la
    // conexión establecida hasta el primer evento, que puede tardar horas.
    res.write(': conectado\n\n');
    for (const e of recentEvents().slice(-5)) send(e);

    const unsubscribe = subscribe(send);
    // Latido cada 25 s. Los proxies cierran conexiones ociosas alrededor del minuto, y
    // una reconexión perdida es exactamente el fallo que este canal existe para evitar.
    const beat = setInterval(() => res.write(': latido\n\n'), 25_000);
    beat.unref?.();

    const close = (): void => {
      clearInterval(beat);
      unsubscribe();
    };
    req.raw.on('close', close);
    req.raw.on('error', close);
  });

  /**
   * La última etapa la mide el navegador, porque es la única que puede.
   *
   * El servidor no sabe cuánto tardó la red del usuario ni cuánto tardó React en
   * pintar. Sin este endpoint, «latencia de punta a punta» sería en realidad «latencia
   * hasta que salió de mi máquina», que es la parte fácil.
   */
  app.post('/client', async (req) => {
    const b = req.body as { ms?: number; fixtureId?: string; sport?: string };
    const ms = Number(b?.ms);
    if (!Number.isFinite(ms) || ms < 0 || ms > 600_000) {
      return { ok: false, reason: 'ms fuera de rango' };
    }
    recordLatency({ stage: 'cliente', ms, sport: b?.sport, fixtureId: b?.fixtureId });
    return { ok: true };
  });

  app.get('/stages', async () => STAGES.map((s) => ({ stage: s, label: STAGE_LABEL[s] })));
}

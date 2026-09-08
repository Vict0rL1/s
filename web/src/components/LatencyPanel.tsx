/**
 * El panel del escáner de líneas: cuánto se tarda, en qué etapa, y qué acaba de pasar.
 *
 * ===========================================================================
 * ESTE PANEL EXISTE PARA QUE «ES LENTO» DEJE DE SER UNA OPINIÓN
 * ===========================================================================
 * Lo que enseña no es un adorno de diagnóstico. Es la respuesta a la única pregunta que
 * importa cuando una línea se movió y no lo viste: ¿dónde se fue el tiempo? Por eso cada
 * etapa sale con SU DUEÑO al lado. Saber que tardas siete minutos no sirve de nada;
 * saber que seis de ellos son «esperando al siguiente sondeo, y eso lo fija el plan»
 * sirve para decidir si pagar más o quitar deportes del ciclo.
 *
 * ===========================================================================
 * TRES COSAS QUE ESTE PANEL SE NIEGA A HACER
 * ===========================================================================
 *   1. NO enseña un ✓ verde sobre una medición incompleta. Si falta una etapa por medir,
 *      el total está por debajo del real y decir «se cumple» sería falso. Se marca con
 *      «·» y se dice qué falta.
 *   2. NO enseña «0 ms» como si fuera rapidez. Una etapa con n=0 sale en gris con su
 *      motivo, no con un cero que parece un récord.
 *   3. NO pide permiso de notificaciones al cargar. Un permiso denegado es permanente
 *      hasta que la persona lo cambie a mano en el navegador, así que pedirlo sin
 *      contexto no es un intento fallido: es haber gastado la única oportunidad.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  connectLiveOdds,
  fetchLatency,
  notificationState,
  requestNotifications,
  type LatencyReport,
  type LiveEvent,
  type StageReport,
} from '../lib/liveOdds';
import { Panel, SectionTitle, Disclosure } from './ui';

function fmt(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** Por qué una etapa no tiene muestras. Sin esto, un 0 se lee como «instantáneo». */
const WHY_EMPTY: Record<string, string> = {
  origen: 'hace falta una clave de The Odds API y un precio que cambie',
  ingesta: 'todavía no ha corrido un ciclo de refresco',
  servidor: 'aún no ha llegado ninguna petición de predicción',
  cliente: 'la mide el navegador al pintar — quédate en la app un rato',
};

function StageRow({ s }: { s: StageReport }) {
  const empty = s.n === 0;
  return (
    <div className="grid grid-cols-[7rem_3rem_1fr_1fr] items-baseline gap-2 py-1 text-[13px] tabular-nums">
      <span className="text-[#9aa1ac]">{s.stage}</span>
      <span className="text-right text-[#5c636c]">{s.n}</span>
      {empty ? (
        <span className="col-span-2 text-[#5c636c]">sin muestras — {WHY_EMPTY[s.stage] ?? ''}</span>
      ) : (
        <>
          <span className={s.overBudget ? 'text-amber-300' : 'text-[#e8eaed]'}>
            p95 {fmt(s.p95)}
            {s.overBudget && <span aria-hidden> ⚠</span>}
          </span>
          <span className="text-[#5c636c]">
            de {fmt(s.budgetMs)} · {s.owner}
          </span>
        </>
      )}
    </div>
  );
}

export default function LatencyPanel() {
  const [report, setReport] = useState<LatencyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [perm, setPerm] = useState(notificationState);

  const load = useCallback(() => {
    fetchLatency()
      .then((r) => {
        setReport(r);
        setError(null);
        // Los últimos eventos del servidor siembran la lista: un canal recién abierto
        // que está mudo es indistinguible de uno roto.
        setEvents(r.push.recent.slice().reverse());
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  // El canal en vivo. Cada evento entra en la lista Y refresca las cifras: si acaba de
  // moverse un precio, los percentiles de hace un momento ya no son los de ahora.
  useEffect(() => {
    return connectLiveOdds({
      notify: true,
      onEvent: (e) => {
        setEvents((prev) => [e, ...prev].slice(0, 12));
        load();
      },
    });
  }, [load]);

  if (error) {
    return (
      <Panel className="mb-4">
        <SectionTitle>Latencia del escáner</SectionTitle>
        <p className="text-[13px] text-[#7b828d]">No se pudo leer /api/latency: {error}</p>
      </Panel>
    );
  }
  if (!report) return null;

  const { alert, total, target, transport, schedule } = report;
  // Un ✓ sobre una medición incompleta es peor que no decir nada: parece que se cumple
  // el objetivo cuando lo que pasa es que no se ha medido.
  const mark = !total.complete ? '·' : alert.breached ? '⚠' : '✓';
  const markTone = !total.complete
    ? 'text-[#7b828d]'
    : alert.breached
      ? 'text-amber-300'
      : 'text-emerald-300';

  return (
    <Panel className="mb-4">
      <SectionTitle
        right={
          <button
            onClick={load}
            className="text-[13px] text-[#7b828d] transition hover:text-[#e8eaed]"
            title="Volver a leer las mediciones"
          >
            recargar
          </button>
        }
      >
        Latencia del escáner · últimas {report.windowHours} h
      </SectionTitle>

      <p className={`text-[14px] leading-relaxed ${markTone}`}>
        <span aria-hidden className="mr-1.5">{mark}</span>
        {alert.message}
      </p>

      {/* La factibilidad va antes que el reproche: incumplir un listón que el plan no
          permite alcanzar no es un fallo del código, y decirlo al revés manda a alguien
          a optimizar parseo cuando lo que hay que cambiar es el plan. */}
      {!target.feasible.ok && (
        <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-2.5 text-[13px] leading-relaxed text-amber-200/90">
          <strong>El objetivo no es alcanzable con este plan.</strong> {target.feasible.reason}
        </p>
      )}

      <div className="mt-3">
        {report.stages.map((s) => (
          <StageRow key={s.stage} s={s} />
        ))}
      </div>

      <p className="mt-2 text-[13px] text-[#5c636c]">
        Total p95 {fmt(total.p95Ms)} contra un objetivo de {fmt(target.totalMs)}
        {!total.complete && <> · incompleto: faltan {total.missing.join(', ')}</>}
      </p>

      <div className="mt-3">
        <Disclosure summary="Cómo se mide y por qué la suma sale pesimista">
          <div className="space-y-2 text-[13px] leading-relaxed text-[#7b828d]">
            <p>
              Sumar los p95 de cuatro etapas no da el p95 del total —solo sería cierto si
              se atascaran siempre a la vez— y sale pesimista. Se usa así a propósito:
              para un objetivo de latencia, equivocarse por el lado pesimista es el lado
              correcto.
            </p>
            <p>
              <strong className="text-[#9aa1ac]">Transporte: {transport.kind}.</strong>{' '}
              {transport.note}
            </p>
            {schedule && (
              <p>
                <strong className="text-[#9aa1ac]">Sondeo adaptativo:</strong>{' '}
                {schedule.explanation}
              </p>
            )}
            {alert.offenders.length > 0 && (
              <ul className="space-y-1">
                {alert.offenders.map((o) => (
                  <li key={o.stage} className="tabular-nums">
                    {o.stage}: {fmt(o.p95)} contra {fmt(o.budget)} — se pasa {fmt(o.overBy)}{' '}
                    ({o.owner})
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Disclosure>
      </div>

      {/* ---- EL CANAL EN VIVO ---- */}
      <div className="mt-3 border-t border-white/[0.07] pt-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[13px] text-[#7b828d]">
            En vivo · {report.push.subscribers} conectado(s)
          </span>
          {perm === 'sin-pedir' ? (
            <button
              onClick={() => void requestNotifications().then(() => setPerm(notificationState()))}
              className="rounded-full px-2.5 py-1 text-[13px] text-[#9aa1ac] ring-1 ring-inset ring-white/[0.08] transition hover:bg-white/[0.05] hover:text-[#e8eaed]"
            >
              Avisarme cuando se mueva una línea
            </button>
          ) : (
            <span className="text-[13px] text-[#5c636c]">
              {perm === 'concedido'
                ? 'avisos del sistema activados'
                : perm === 'denegado'
                  ? 'avisos bloqueados en el navegador — se cambia en su configuración'
                  : 'este navegador no tiene avisos del sistema'}
            </span>
          )}
        </div>
        {events.length === 0 ? (
          <p className="text-[13px] text-[#5c636c]">
            Escuchando. Los cambios de precio aparecen aquí solos, sin pulsar nada — que es
            justo el motivo de que exista este canal: un refresco manual depende de que
            alguien mire, y eso no cabe en ningún objetivo de latencia.
          </p>
        ) : (
          <ul className="space-y-1">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`} className="text-[13px] leading-relaxed">
                <span className="text-[#5c636c] tabular-nums">
                  {new Date(e.at).toLocaleTimeString('es')}
                </span>{' '}
                <span className="text-[#e8eaed]">{e.title}</span>{' '}
                <span className="text-[#7b828d]">{e.body}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

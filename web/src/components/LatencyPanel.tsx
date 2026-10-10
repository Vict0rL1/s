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
import { AlertIcon, CheckIcon } from './icons';
import { localeDe, useI18n, type Clave } from '../i18n';
import { num as numF } from '../lib/formato';

function fmt(ms: number): string {
  if (ms >= 60_000) return `${numF((ms / 60_000), 1)} min`;
  if (ms >= 1000) return `${numF((ms / 1000), 2)} s`;
  return `${Math.round(ms)} ms`;
}

/** Por qué una etapa no tiene muestras. Sin esto, un 0 se lee como «instantáneo». */
const WHY_EMPTY: Record<string, Clave> = {
  origen: 'lat.why.origen',
  ingesta: 'lat.why.ingesta',
  servidor: 'lat.why.servidor',
  cliente: 'lat.why.cliente',
};

function StageRow({ s }: { s: StageReport }) {
  const { t } = useI18n();
  const empty = s.n === 0;
  return (
    <div className="grid grid-cols-[7rem_3rem_1fr_1fr] items-baseline gap-2 py-1 text-[13px] tabular-nums">
      <span className="text-(--ink-soft)">{s.stage}</span>
      <span className="text-right text-(--ink-faint)">{s.n}</span>
      {empty ? (
        <span className="col-span-2 text-(--ink-faint)">{t('lat.sinMuestras', { why: WHY_EMPTY[s.stage] ? t(WHY_EMPTY[s.stage]) : '' })}</span>
      ) : (
        <>
          <span className={s.overBudget ? 'text-amber-300' : 'text-(--ink-strong)'}>
            p95 {fmt(s.p95)}
            {s.overBudget && <span aria-hidden className="ml-1 inline-flex align-[-2px]"><AlertIcon size={13} /></span>}
          </span>
          <span className="text-(--ink-faint)">
            {t('lat.de', { b: fmt(s.budgetMs), owner: s.owner })}
          </span>
        </>
      )}
    </div>
  );
}

export default function LatencyPanel() {
  const { t, idioma } = useI18n();
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
        <SectionTitle>{t('lat.titulo')}</SectionTitle>
        <p className="text-[13px] text-(--ink-muted)">{t('lat.errorLeer', { error })}</p>
      </Panel>
    );
  }
  if (!report) return null;

  const { alert, total, target, transport, schedule } = report;
  // Un ✓ sobre una medición incompleta es peor que no decir nada: parece que se cumple
  // el objetivo cuando lo que pasa es que no se ha medido.
  const mark = !total.complete ? '·' : alert.breached ? <AlertIcon size={15} /> : <CheckIcon size={15} strokeWidth={2.4} />;
  const markTone = !total.complete
    ? 'text-(--ink-muted)'
    : alert.breached
      ? 'text-amber-300'
      : 'text-emerald-300';

  return (
    <Panel className="mb-4">
      <SectionTitle
        right={
          <button
            onClick={load}
            className="text-[13px] text-(--ink-muted) transition hover:text-(--ink-strong)"
            title={t('lat.recargarTitulo')}
          >
            {t('lat.recargar')}
          </button>
        }
      >
        {t('lat.tituloVentana', { h: report.windowHours })}
      </SectionTitle>

      <p className={`text-[14px] leading-relaxed ${markTone}`}>
        <span aria-hidden className="mr-1.5 inline-flex align-[-2px]">{mark}</span>
        {alert.message}
      </p>

      {/* La factibilidad va antes que el reproche: incumplir un listón que el plan no
          permite alcanzar no es un fallo del código, y decirlo al revés manda a alguien
          a optimizar parseo cuando lo que hay que cambiar es el plan. */}
      {!target.feasible.ok && (
        <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-2.5 text-[13px] leading-relaxed text-amber-200/90">
          <strong>{t('lat.noAlcanzable')}</strong> {target.feasible.reason}
        </p>
      )}

      <div className="mt-3">
        {report.stages.map((s) => (
          <StageRow key={s.stage} s={s} />
        ))}
      </div>

      <p className="mt-2 text-[13px] text-(--ink-faint)">
        {t('lat.total', { p: fmt(total.p95Ms), o: fmt(target.totalMs) })}
        {!total.complete && <>{t('lat.incompleto', { lista: total.missing.join(', ') })}</>}
      </p>

      <div className="mt-3">
        <Disclosure summary={t('lat.comoMide')}>
          <div className="space-y-2 text-[13px] leading-relaxed text-(--ink-muted)">
            <p>{t('lat.suma')}</p>
            <p>
              <strong className="text-(--ink-soft)">{t('lat.transporte', { k: transport.kind })}</strong>{' '}
              {transport.note}
            </p>
            {schedule && (
              <p>
                <strong className="text-(--ink-soft)">{t('lat.sondeo')}</strong>{' '}
                {schedule.explanation}
              </p>
            )}
            {alert.offenders.length > 0 && (
              <ul className="space-y-1">
                {alert.offenders.map((o) => (
                  <li key={o.stage} className="tabular-nums">
                    {t('lat.ofensor', { etapa: o.stage, p: fmt(o.p95), b: fmt(o.budget), o: fmt(o.overBy), owner: o.owner })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Disclosure>
      </div>

      {/* ---- EL CANAL EN VIVO ---- */}
      <div className="mt-3 border-t border-(--line) pt-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[13px] text-(--ink-muted)">
            {t('lat.enVivo', { n: report.push.subscribers })}
          </span>
          {perm === 'sin-pedir' ? (
            <button
              onClick={() => void requestNotifications().then(() => setPerm(notificationState()))}
              className="rounded-full px-2.5 py-1 text-[13px] text-(--ink-soft) ring-1 ring-inset ring-(--line) transition hover:bg-(--raised) hover:text-(--ink-strong)"
            >
              {t('lat.avisarme')}
            </button>
          ) : (
            <span className="text-[13px] text-(--ink-faint)">
              {perm === 'concedido'
                ? t('lat.activados')
                : perm === 'denegado'
                  ? t('lat.bloqueados')
                  : t('lat.noAvisos')}
            </span>
          )}
        </div>
        {events.length === 0 ? (
          <p className="text-[13px] text-(--ink-faint)">
            {t('lat.escuchando')}
          </p>
        ) : (
          <ul className="space-y-1">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`} className="text-[13px] leading-relaxed">
                <span className="text-(--ink-faint) tabular-nums">
                  {new Date(e.at).toLocaleTimeString(localeDe(idioma))}
                </span>{' '}
                <span className="text-(--ink-strong)">{e.title}</span>{' '}
                <span className="text-(--ink-muted)">{e.body}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

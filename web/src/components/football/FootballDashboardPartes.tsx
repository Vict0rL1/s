// Piezas de FootballDashboard.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { useEffect, useState } from 'react';
import { fbApi } from '../../lib/football';
import { conNodos, useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

export function TrackRecordPanel({ league }: { league: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<Awaited<ReturnType<typeof fbApi.trackRecord>> | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    fbApi
      .trackRecord(league)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [league]);

  if (!data || (data.resolved === 0 && data.pending === 0)) return null;

  return (
    <div className="mb-4 rounded-lg border border-(--line) bg-(--raised) p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-[16px]">
          <span className="text-[14px] uppercase tracking-wide text-(--ink-muted)">
            {t('fbt.titulo')}
          </span>
          <br />
          {data.resolved === 0 ? (
            <span className="text-(--ink-body)">
              {t('fbt.pendientes', { n: data.pending })}
            </span>
          ) : (
            <span className="text-(--ink-strong)">
              {conNodos(t('fbt.rpsEn'), {
                rps: <strong className="tabular-nums">{data.rps}</strong>,
                n: <strong className="tabular-nums">{data.resolved}</strong>,
              })}
              <span className="text-(--ink-soft)">
                {' '}
                {t('fbt.acerto', { pct: numF((data.accuracy ?? 0) * 100, 1) })}
              </span>
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-(--line) pt-3 text-[14px] text-(--ink-body)">
          <p className="text-(--ink-soft)">
            {conNodos(t('fbt.rpsExplica'), { rps: <strong>RPS</strong> })}
          </p>
          {data.draws && (
            <p>
              {conNodos(t('fbt.empates'), {
                pred: <strong>{data.draws.predicted}</strong>,
                real: <strong>{data.draws.actual}</strong>,
                pct: <strong>{pctF((data.draws.meanProbability ?? 0), 1)}</strong>,
              })}
            </p>
          )}
          {data.vsMarket && (
            <p>
              {conNodos(t('fbt.vsMercado', { n: data.vsMarket.n }), {
                modelo: <strong>{data.vsMarket.modelRps}</strong>,
                mercado: <strong>{data.vsMarket.marketRps}</strong>,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

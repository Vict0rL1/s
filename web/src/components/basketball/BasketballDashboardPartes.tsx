// Piezas de BasketballDashboard.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { useEffect, useState } from 'react';
import { bbApi, type BbMeta, type BbTrackRecord } from '../../lib/basketball';
import { CheckIcon, CrossIcon } from '../icons';
import { conNodos, localeDe, useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

export function DataLine({ meta }: { meta: BbMeta }) {
  const { t, idioma } = useI18n();
  const when = meta.oddsRefreshedAt ?? meta.updatedAt;
  const whenTxt = when
    ? new Date(when).toLocaleString(localeDe(idioma), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
  return (
    <p className="mt-1 text-[14px] text-(--ink-muted)">
      {t('bk.dataLine', { partidos: meta.counts.games, equipos: meta.counts.teams, cuando: whenTxt })}
      {meta.hasOddsKey
        ? meta.autoRefreshMinutes > 0
          ? t('td.autoCada', { h: Math.round(meta.autoRefreshMinutes / 60) })
          : ''
        : t('bk.configura')}
    </p>
  );
}

/**
 * Ratings are only as current as the results behind them. In basketball this
 * matters even more than in tennis: a roster can change completely over one
 * summer, so a rating from a past season describes a team that no longer exists.
 */

/**
 * The app's own scorecard for basketball. Unlike tennis it can also report how far
 * off the predicted MARGIN was, which is the figure a handicap bet depends on.
 */
export function BbTrackRecordPanel({ league }: { league: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<BbTrackRecord | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    bbApi
      .trackRecord(league)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [league]);

  if (!data || (data.resolved === 0 && data.pending === 0)) return null;
  const thin = data.resolved > 0 && data.resolved < 30;

  return (
    <div className="mt-3 rounded-lg border border-(--line) bg-(--raised) p-3">
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
              {conNodos(t('bkt.acierto'), {
                pct: <strong className="tabular-nums">{pctF((data.accuracy ?? 0), 1)}</strong>,
                n: <strong className="tabular-nums">{data.resolved}</strong>,
              })}
              {data.marginMae != null && (
                <span className="text-(--ink-soft)"> {t('bkt.errorMargen', { n: data.marginMae })}</span>
              )}
              {thin && <span className="text-amber-400"> {t('bkt.muestraPequena')}</span>}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4 border-t border-(--line) pt-3 text-[14px]">
          <p className="text-(--ink-soft)">
            {conNodos(t('bkt.guardaAntes'), {
              antes: <strong>{t('np.antes')}</strong>,
              cmd: <code className="rounded bg-(--tint) px-1">npm run update-data:bb</code>,
            })}
          </p>
          {data.resolved > 0 && (
            <div className="grid grid-cols-4 gap-x-4 gap-y-3 border-y border-(--line) py-3">
              <Cell label={t('bkt.aciertoCol')} value={`${pctF((data.accuracy ?? 0), 1)}`} />
              <Cell label="Brier" value={(data.brier == null ? undefined : numF(data.brier, 4)) ?? '—'} />
              <Cell label={t('bkt.errorMargenCol')} value={data.marginMae != null ? t('bkt.pts', { n: data.marginMae }) : '—'} />
              <Cell
                label={t('bkt.sesgoMargen')}
                value={
                  data.marginBias != null
                    ? `${data.marginBias > 0 ? '+' : ''}${data.marginBias}`
                    : '—'
                }
                hint={t('bkt.sesgoHint')}
              />
            </div>
          )}
          {data.vsMarket && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-(--ink-muted)">
                {t('bkt.vsMercado', { n: data.vsMarket.n })}
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-(--ink-muted)">
                  <tr>
                    <th className="py-1 font-normal">&nbsp;</th>
                    <th className="py-1 font-normal">{t('bkt.aciertoCol')}</th>
                    <th className="py-1 font-normal">Brier</th>
                  </tr>
                </thead>
                <tbody className="text-(--ink-body)">
                  <tr>
                    <td className="py-1 text-(--ink-soft)">{t('pb.modelo')}</td>
                    <td>{fmtPct(data.vsMarket.modelAccuracy)}</td>
                    <td>{(data.vsMarket.modelBrier == null ? undefined : numF(data.vsMarket.modelBrier, 4)) ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-(--ink-soft)">{t('eq.mercado')}</td>
                    <td>{fmtPct(data.vsMarket.marketAccuracy)}</td>
                    <td>{(data.vsMarket.marketBrier == null ? undefined : numF(data.vsMarket.marketBrier, 4)) ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {data.recent.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-(--ink-muted)">{t('bkt.ultimas')}</div>
              <ul className="space-y-1">
                {data.recent.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={`mt-[3px] inline-flex ${r.hit ? 'text-emerald-400' : 'text-rose-400'}`} aria-label={r.hit ? t('bkt.acerto') : t('bkt.fallo')}>
                      {r.hit ? <CheckIcon size={15} strokeWidth={2.4} /> : <CrossIcon size={15} strokeWidth={2.4} />}
                    </span>
                    <span className="text-(--ink-body)">
                      {r.away} @ {r.home}
                      <span className="text-(--ink-muted)">
                        {' '}
                        {t('bkt.dijo', {
                          p: fmtPct(Math.max(r.probHome, 1 - r.probHome)),
                          equipo: (r.probHome >= 0.5 ? r.home : r.away) ?? '',
                          a: r.awayPts ?? '',
                          h: r.homePts ?? '',
                        })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-(--ink-muted)">{label}</div>
      <div className="tabular-nums text-(--ink-strong)">{value}</div>
      {hint && <div className="text-[11px] text-(--ink-faint)">{hint}</div>}
    </div>
  );
}

export function fmtPct(v: number | null): string {
  return v == null ? '—' : `${pctF(v, 1)}`;
}

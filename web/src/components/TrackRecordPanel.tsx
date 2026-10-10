import { useEffect, useState } from 'react';
import { api, type TrackRecord } from '../lib/api';
import { CheckIcon, CrossIcon } from './icons';
import { conNodos, useI18n, type Clave } from '../i18n';
import { pct as pctF, num as numF } from '../lib/formato';

/**
 * The app's own scorecard.
 *
 * `npm run backtest` reports how the model does on 20 years of history — useful,
 * but it is not evidence about the matches this user actually looked at. This
 * panel answers that instead: every prediction shown for a real fixture is
 * recorded before the match, then scored once the result arrives.
 *
 * It stays deliberately unflattering. The market's accuracy on the same matches
 * sits next to the model's, an empty record says so plainly rather than showing
 * a reassuring blank, and small samples are labelled as small.
 */
export default function TrackRecordPanel({ tour }: { tour: string }) {
  const [data, setData] = useState<TrackRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    let alive = true;
    api
      .trackRecord(tour)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [tour]);

  // Nothing recorded yet and nothing pending → don't take up space with an
  // empty widget on a fresh install.
  if (failed || !data || (data.resolved === 0 && data.pending === 0)) return null;

  const acc = data.accuracy;
  // Under ~30 resolved matches the percentage swings several points on a single
  // result, so it is presented as provisional rather than as a measurement.
  const thin = data.resolved > 0 && data.resolved < 30;

  return (
    <div className="mt-3 rounded-lg border border-(--line) bg-(--raised) p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-[16px]">
          <span className="text-[14px] uppercase tracking-wide text-(--ink-muted)">
            {t('historial.titulo')}
          </span>
          <br />
          {data.resolved === 0 ? (
            <span className="text-(--ink-body)">
              {t('historial.esperando', { n: data.pending })}
            </span>
          ) : (
            <span className="text-(--ink-strong)">
              {conNodos(t('historial.resumen'), {
                pct: <strong className="tabular-nums">{pctF((acc ?? 0), 1)}</strong>,
                n: <strong className="tabular-nums">{data.resolved}</strong>,
              })}
              {data.pending > 0 && <span className="text-(--ink-soft)">{t('historial.pendientes', { n: data.pending })}</span>}
              {thin && <span className="text-amber-400">{t('historial.muestraPequena')}</span>}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4 border-t border-(--line) pt-3 text-[14px]">
          <p className="text-(--ink-soft)">
            {conNodos(t('historial.explica'), {
              antes: <strong>{t('historial.antes')}</strong>,
              comando: <code className="rounded bg-(--tint) px-1">npm run update-data</code>,
            })}
          </p>

          {data.resolved > 0 && (
            <div className="grid grid-cols-3 gap-2">
              <Stat label={t('historial.acierto')} value={`${pctF((acc ?? 0), 1)}`} />
              <Stat label={t('historial.brier')} value={(data.brier == null ? undefined : numF(data.brier, 4)) ?? '—'} hint={t('historial.menorMejor')} />
              <Stat label={t('historial.logLoss')} value={(data.logLoss == null ? undefined : numF(data.logLoss, 4)) ?? '—'} hint={t('historial.menorMejor')} />
            </div>
          )}

          {/* The comparison that matters: same matches, model vs bookmakers. */}
          {data.vsMarket && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-(--ink-muted)">
                {t('historial.vsMercado', { n: data.vsMarket.n })}
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-(--ink-muted)">
                  <tr>
                    <th className="py-1 font-normal">&nbsp;</th>
                    <th className="py-1 font-normal">{t('historial.acierto')}</th>
                    <th className="py-1 font-normal">{t('historial.brier')}</th>
                  </tr>
                </thead>
                <tbody className="text-(--ink-body)">
                  <tr>
                    <td className="py-1 text-(--ink-soft)">{t('historial.modelo')}</td>
                    <td>{fmtPct(data.vsMarket.modelAccuracy)}</td>
                    <td>{(data.vsMarket.modelBrier == null ? undefined : numF(data.vsMarket.modelBrier, 4)) ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-(--ink-soft)">{t('historial.mercado')}</td>
                    <td>{fmtPct(data.vsMarket.marketAccuracy)}</td>
                    <td>{(data.vsMarket.marketBrier == null ? undefined : numF(data.vsMarket.marketBrier, 4)) ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
              {data.vsMarket.disagreements > 0 && (
                <p className="mt-1 text-(--ink-soft)">
                  {t('historial.discreparon', { n: data.vsMarket.disagreements, pct: fmtPct(data.vsMarket.modelRightOnDisagreement) })}
                </p>
              )}
            </div>
          )}

          {/* Does the reliability badge predict anything? Checked here. */}
          {data.byReliability.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-(--ink-muted)">
                {t('historial.porFiabilidad')}
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-(--ink-muted)">
                  <tr>
                    <th className="py-1 font-normal">{t('historial.nivel')}</th>
                    <th className="py-1 font-normal">n</th>
                    <th className="py-1 font-normal">{t('historial.acierto')}</th>
                    <th className="py-1 font-normal">{t('historial.brier')}</th>
                  </tr>
                </thead>
                <tbody className="text-(--ink-body)">
                  {data.byReliability.map((r) => (
                    <tr key={r.level}>
                      <td className="py-1 text-(--ink-soft)">{r.level in NIVEL ? t(NIVEL[r.level]) : r.level}</td>
                      <td>{r.n}</td>
                      <td>{fmtPct(r.accuracy)}</td>
                      <td>{(r.brier == null ? undefined : numF(r.brier, 4)) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-(--ink-muted)">
                {t('historial.semaforo')}
              </p>
            </div>
          )}

          {/* Calibration: does "70%" actually win 70% of the time? */}
          {data.calibration.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-(--ink-muted)">
                {t('historial.calibracion')}
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-(--ink-muted)">
                  <tr>
                    <th className="py-1 font-normal">{t('historial.banda')}</th>
                    <th className="py-1 font-normal">n</th>
                    <th className="py-1 font-normal">{t('historial.dijo')}</th>
                    <th className="py-1 font-normal">{t('historial.gano')}</th>
                  </tr>
                </thead>
                <tbody className="text-(--ink-body)">
                  {data.calibration.map((b) => (
                    <tr key={b.label}>
                      <td className="py-1 text-(--ink-soft)">{b.label}</td>
                      <td>{b.n}</td>
                      <td>{fmtPct(b.predicted)}</td>
                      <td>{fmtPct(b.observed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.recent.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-(--ink-muted)">{t('historial.ultimas')}</div>
              <ul className="space-y-1">
                {data.recent.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={`mt-[3px] inline-flex ${r.hit ? 'text-emerald-400' : 'text-rose-400'}`} aria-label={r.hit ? t('historial.acerto') : t('historial.fallo')}>
                      {r.hit ? <CheckIcon size={15} strokeWidth={2.4} /> : <CrossIcon size={15} strokeWidth={2.4} />}
                    </span>
                    <span className="text-(--ink-body)">
                      {r.p1} vs {r.p2}
                      <span className="text-(--ink-muted)">
                        {t('historial.dijoPara', { pct: fmtPct(Math.max(r.prob1, 1 - r.prob1)), favorito: (r.prob1 >= 0.5 ? r.p1 : r.p2) ?? '—', ganador: (r.winnerIsP1 ? r.p1 : r.p2) ?? '—' })}
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

const NIVEL: Record<string, Clave> = { high: 'historial.alta', medium: 'historial.media', low: 'historial.baja' };

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${pctF(v, 1)}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-(--ink-muted)">{label}</div>
      <div className="tabular-nums text-(--ink-strong)">{value}</div>
      {hint && <div className="text-[11px] text-(--ink-faint)">{hint}</div>}
    </div>
  );
}

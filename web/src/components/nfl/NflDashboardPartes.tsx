// Piezas de NflDashboard.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { useEffect, useState } from 'react';
import { nflApi, type NflMeta, type NflTrackRecord } from '../../lib/nfl';
import { conNodos, localeDe, useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

export function DataLine({ meta }: { meta: NflMeta }) {
  const { t, idioma } = useI18n();
  return (
    <p className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">
      <span className="mr-1 rounded-full px-2 py-0.5 text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
        {t('nfl.datosReales')}
      </span>
      {t('nfl.lineaDatos', { partidos: meta.counts.games.toLocaleString(localeDe(idioma)), equipos: meta.counts.teams })}
      {/* The two tracked league quantities. Worth a line of chrome: they are the
          model's own reading of how the sport is being played this year. */}
      <span className="text-(--ink-soft)">
        {t('nfl.ventaja', { v: meta.league.homeAdvantagePoints, p: meta.league.pointsPerGame })}
      </span>
      {!meta.hasOddsKey && t('eq.configuraCuotas')}
    </p>
  );
}

/**
 * The staleness warning, counted in SEASONS.
 *
 * The other tabs warn in months. Here that would fire every summer on a
 * perfectly current archive: the NFL simply does not play between February and
 * September, so "the history ends five months ago" in July means nothing is
 * missing at all.
 */

/**
 * The track record.
 *
 * The one panel in the app that can put the model and the market side by side on
 * the SAME games the app actually showed you, because this is the only sport
 * where the market's number is recorded at the moment of the call.
 */
export function NflTrackRecordPanel({ league }: { league: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<NflTrackRecord | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    nflApi
      .trackRecord(league)
      .then((d) => alive && setData(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [league]);

  if (!data || (data.resolved === 0 && data.pending === 0)) return null;

  return (
    <div className="mt-3 rounded-xl border border-(--line) bg-(--tint) p-3">
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
              {conNodos(t('nflt.acierto'), {
                pct: <strong className="tabular-nums">{pctF((data.accuracy ?? 0), 1)}</strong>,
                n: <strong className="tabular-nums">{data.resolved}</strong>,
              })}
              {data.marginMae != null && (
                <span className="text-(--ink-soft)"> {t('nflt.errorMargen', { n: data.marginMae })}</span>
              )}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-(--line) pt-3 text-[14px] text-(--ink-body)">
          {data.vsMarket && (
            <p>
              {conNodos(
                t('nflt.vsMercado', {
                  n: data.vsMarket.n,
                  m: numF((data.vsMarket.modelAccuracy ?? 0) * 100, 1),
                  k: numF((data.vsMarket.marketAccuracy ?? 0) * 100, 1),
                  bm: data.vsMarket.modelBrier ?? '',
                  bk: data.vsMarket.marketBrier ?? '',
                }),
                { contra: <strong>{t('nflt.contra')}</strong> },
              )}
            </p>
          )}
          <p className="text-(--ink-soft)">
            {t('nflt.cierre')}
          </p>
          {data.calibration.length > 0 && (
            <div>
              <div className="mb-1 text-(--ink-muted)">{t('nflt.calibracion')}</div>
              <ul className="space-y-0.5">
                {data.calibration.map((c) => (
                  <li key={c.label} className="tabular-nums">
                    {t('nflt.calibLinea', { label: c.label, p: numF(c.predicted * 100, 0), o: numF(c.observed * 100, 0), n: c.n })}
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

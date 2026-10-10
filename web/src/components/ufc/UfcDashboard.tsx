import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { rutaLuchador } from '../../rutas';
import { useFiltroQuery } from '../../lib/rutas';
import { SkeletonList, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel, DashboardHeader, EmptySlate, SlateTable } from '../ui';
import { staleLabel, staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, ufcPicks } from '../../lib/picks';
import { ufcSlate } from '../../lib/slate';
import { useStake } from '../../lib/useStake';
import { dayChipLabel, groupByDay } from '../../lib/format';
import { ufcApi, type UfcFightWithPrediction, type UfcMeta, type UfcTrackRecord } from '../../lib/ufc';
import FightCard from './FightCard';
import EloRanking from '../EloRanking';
import { conNodos, localeDe, useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';
import { conservarDia } from '../../lib/carga';

const CODIGO = 'rounded bg-(--raised) px-1 text-[12px] text-(--ink-body)';

/**
 * La pestaña de la UFC. Habla solo con /api/ufc/*.
 *
 * Sin calendario propio: la fuente del archivo trae las peleas ya disputadas, y las que vienen llegan
 * con las cuotas (The Odds API). Sin clave no hay cartelera, y aquí se dice así, sin inventar peleas.
 */
export default function UfcDashboard() {
  const { t, idioma } = useI18n();
  const [meta, setMeta] = useState<UfcMeta | null>(null);
  const [fights, setFights] = useState<UfcFightWithPrediction[]>([]);
  const [power, setPower] = useState<{ id: string; name: string; elo: number; fights: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [day, setDay] = useFiltroQuery('dia');
  const navigate = useNavigate();
  const abrirLuchador = (id: string) => navigate(rutaLuchador(id));

  useEffect(() => {
    Promise.all([ufcApi.meta(), ufcApi.upcoming(), ufcApi.power()])
      .then(([m, f, p]) => {
        setMeta(m);
        setFights(f);
        setPower(p.fighters);
      })
      .catch((e) => setError(t('ufc.errorCargar', { error: String(e) })))
      .finally(() => setLoading(false));
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await ufcApi.refresh();
      const [m, f] = await Promise.all([ufcApi.meta(), ufcApi.upcoming()]);
      setMeta(m);
      setFights(f);
    } catch (e) {
      setError(t('comun.errorActualizar', { error: String(e) }));
    } finally {
      setRefreshing(false);
    }
  }

  const dayGroups = useMemo(() => groupByDay(fights, (g) => g.fight.commence_time, idioma), [fights, idioma]);
  const dayChips = useMemo(() => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key, new Date(), idioma), count: d.items.length })), [dayGroups, idioma]);
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;
  // D8: mientras carga no hay días (o son los de la liga anterior): el ?dia= del enlace se conserva.
  useEffect(() => {
    const sigue = conservarDia(day, dayGroups.map((d) => d.key), loading);
    if (sigue !== day) setDay(sigue);
  }, [dayGroups, day, loading]);

  const picks = useMemo(() => rankPicks(ufcPicks(fights), Date.now(), { basis: 'confidence' }), [fights]);
  const [stake, setStake] = useStake();
  const slate = useMemo(() => ufcSlate(fights), [fights]);
  const stale = staleness('ufc', meta?.historyThrough);
  const n = (x: number) => x.toLocaleString(localeDe(idioma));

  return (
    <div>
      <DashboardHeader
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshTitle={t('ufc.refrescarTitulo')}
        chips={meta && <>{t('ufc.chips', { peleas: n(meta.counts.fights), luchadores: n(meta.counts.fighters) })}</>}
        alert={staleLabel(stale, idioma)}
      >
        <p className="max-w-prose text-[15px] leading-relaxed text-(--ink-soft)">{t('ufc.lema')}</p>
        {meta && (
          <p className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">
            <span className="mr-1 rounded-full px-2 py-0.5 text-emerald-300 ring-1 ring-inset ring-emerald-500/30">{t('ufc.datosReales')}</span>
            {t('ufc.lineaDatos', { peleas: n(meta.counts.fights), hasta: meta.historyThrough ?? '—', anio: meta.model.holdoutDesde })}
          </p>
        )}
        <StaleHistoryWarning info={stale} what={t('ufc.elos')} fix="npm run update-data:ufc" />
        <HistorialEnVivo />
      </DashboardHeader>

      <PicksPanel {...picks} caveat={t(CAVEATS.ufc)} demoOdds={false} confidenceReason={t('ufc.ordenConfianza')} stake={stake} onStakeChange={setStake} />

      {meta && !meta.hasOddsKey && (
        <p className="mb-4 text-[13px] leading-relaxed text-(--ink-muted)" data-testid="ufc-sin-clave">
          {conNodos(t('ufc.sinClave'), { cmd: <code className={CODIGO}>npm run clave</code> })}
        </p>
      )}
      {meta && meta.hasOddsKey && meta.oddsFallbackReason && fights.length === 0 && <p className="mb-4 text-[13px] leading-relaxed text-(--ink-muted)">{t('ufc.sinCartelera')}</p>}
      {meta && meta.descartadas > 0 && <p className="mb-4 text-[12px] leading-relaxed text-(--ink-faint)">{t('ufc.descartadas', { n: meta.descartadas })}</p>}
      <SlateTable rows={slate} demoOdds={false} refrescadas={meta?.oddsRefreshedAt} bands={meta?.bands} />

      {error && <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[15px] text-rose-200">{error}</div>}

      {loading ? (
        <SkeletonList />
      ) : meta && meta.counts.fights === 0 ? (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200" data-testid="ufc-sin-datos">
          <p className="font-medium">{t('ufc.sinDatos')}</p>
          <p className="mt-1 text-rose-300/90">{conNodos(t('ufc.sinDatosCuerpo'), { cmd: <code className="rounded bg-rose-900/40 px-1">npm run update-data:ufc</code> })}</p>
        </div>
      ) : fights.length === 0 ? (
        <EmptySlate what="UFC" reason="sin-partidos" />
      ) : (
        <>
          <DayFilter days={dayChips} selected={day} onSelect={setDay} />
          {shownGroups.map((group) => (
            <section key={group.key} className="seccion-dia mb-6">
              <DayHeading label={group.label} count={group.items.length} />
              <div className="grid gap-4 grid-cols-[minmax(0,1fr)] xl:grid-cols-[repeat(2,minmax(0,1fr))] xl:items-start">
                {group.items.map((g) => (
                  <FightCard key={g.fight.id} item={g} onOpenFighter={abrirLuchador} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      <EloRanking
        title={t('ufc.ranking')}
        rows={power.map((p) => ({
          id: p.id,
          name: p.name,
          elo: p.elo,
          onOpen: () => abrirLuchador(p.id),
          extra: [{ label: t('ufc.peleas'), value: n(p.fights), title: t('ufc.peleasTitulo') }],
        }))}
        extraHeaders={[t('ufc.peleas')]}
        footer={<>{t('ufc.eloPie')}</>}
      />
    </div>
  );
}

/** Lo que la app dijo antes de cada pelea que enseñó, y cómo le fue. */
function HistorialEnVivo() {
  const { t } = useI18n();
  const [data, setData] = useState<UfcTrackRecord | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let vivo = true;
    ufcApi
      .trackRecord()
      .then((d) => vivo && setData(d))
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);
  if (!data || (data.resolved === 0 && data.pending === 0)) return null;
  const decididas = data.resolved - data.sinGanador;
  return (
    <div className="mt-3 rounded-xl border border-(--line) bg-(--tint) p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="text-[16px]">
          <span className="text-[14px] uppercase tracking-wide text-(--ink-muted)">{t('fbt.titulo')}</span>
          <br />
          {decididas === 0 ? (
            <span className="text-(--ink-body)">{t('fbt.pendientes', { n: data.pending })}</span>
          ) : (
            <span className="text-(--ink-strong)">
              {conNodos(t('ufc.acierto'), {
                pct: <strong className="tabular-nums">{pctF((data.accuracy ?? 0), 1)}</strong>,
                n: <strong className="tabular-nums">{decididas}</strong>,
              })}
              {data.sinGanador > 0 && <span className="text-(--ink-soft)"> {t('ufc.sinGanadorNota', { n: data.sinGanador })}</span>}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-(--line) pt-3 text-[14px] text-(--ink-body)">
          {data.vsMarket && <p>{t('ufc.vsMercado', { n: data.vsMarket.n, bm: data.vsMarket.modelBrier, bk: data.vsMarket.marketBrier })}</p>}
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

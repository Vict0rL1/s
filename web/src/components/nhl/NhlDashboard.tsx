import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { rutaEquipo } from '../../rutas';
import { useFiltroQuery } from '../../lib/rutas';
import { SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel, DashboardHeader, EmptySlate, NflNoLineNote, SlateTable } from '../ui';
import { staleLabel, staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, nhlPicks } from '../../lib/picks';
import { nflSlate } from '../../lib/slate';
import { useStake } from '../../lib/useStake';
import { dayChipLabel, groupByDay } from '../../lib/format';
import { nhlApi, type NhlGameWithPrediction, type NhlMeta, type NhlTrackRecord } from '../../lib/nhl';
import GameCard from './GameCard';
import EloRanking from '../EloRanking';
import { conNodos, localeDe, useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';
import { conservarDia } from '../../lib/carga';

/**
 * La pestaña de la NHL. Habla solo con /api/nhl/*.
 *
 * Una liga, así que no hay selector de ligas: el calendario de la temporada (sin clave de cuotas)
 * o las filas de las casas (con clave), agrupados por día.
 */
export default function NhlDashboard() {
  const { t, idioma } = useI18n();
  const [meta, setMeta] = useState<NhlMeta | null>(null);
  const [games, setGames] = useState<NhlGameWithPrediction[]>([]);
  const [power, setPower] = useState<{ id: string; name: string; elo: number; games: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [day, setDay] = useFiltroQuery('dia');
  const navigate = useNavigate();
  const abrirEquipo = (id: string) => navigate(rutaEquipo('nhl', 'nhl', id));

  useEffect(() => {
    Promise.all([nhlApi.meta(), nhlApi.upcoming(), nhlApi.power()])
      .then(([m, g, p]) => {
        setMeta(m);
        setGames(g);
        setPower(p.teams);
      })
      .catch((e) => setError(t('nhl.errorCargar', { error: String(e) })))
      .finally(() => setLoading(false));
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await nhlApi.refresh();
      const [m, g] = await Promise.all([nhlApi.meta(), nhlApi.upcoming()]);
      setMeta(m);
      setGames(g);
    } catch (e) {
      setError(t('comun.errorActualizar', { error: String(e) }));
    } finally {
      setRefreshing(false);
    }
  }

  const dayGroups = useMemo(() => groupByDay(games, (g) => g.game.commence_time, idioma), [games, idioma]);
  const dayChips = useMemo(() => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key, new Date(), idioma), count: d.items.length })), [dayGroups, idioma]);
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;
  // D8: mientras carga no hay días (o son los de la liga anterior): el ?dia= del enlace se conserva.
  useEffect(() => {
    const sigue = conservarDia(day, dayGroups.map((d) => d.key), loading);
    if (sigue !== day) setDay(sigue);
  }, [dayGroups, day, loading]);

  const picks = useMemo(() => rankPicks(nhlPicks(games), Date.now(), { basis: 'confidence' }), [games]);
  const [stake, setStake] = useStake();
  const slate = useMemo(() => nflSlate(games), [games]);
  const stale = staleness('nhl', meta?.historyThrough);

  return (
    <div>
      <DashboardHeader
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshTitle={t('eq.refrescarTitulo')}
        chips={meta && <>{t('eq.chipsEquipos', { partidos: meta.counts.games.toLocaleString(localeDe(idioma)), equipos: meta.counts.teams })}</>}
        alert={staleLabel(stale, idioma)}
      >
        <p className="max-w-prose text-[15px] leading-relaxed text-(--ink-soft)">{t('nhl.lema')}</p>
        {meta && (
          <p className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">
            <span className="mr-1 rounded-full px-2 py-0.5 text-emerald-300 ring-1 ring-inset ring-emerald-500/30">{t('nfl.datosReales')}</span>
            {t('nhl.lineaDatos', { partidos: meta.counts.games.toLocaleString(localeDe(idioma)), hasta: meta.historyThrough ?? '—', campo: meta.league.homeAdvantageElo })}
            {!meta.hasOddsKey && t('eq.configuraCuotas')}
          </p>
        )}
        <StaleHistoryWarning info={stale} what={t('nhl.elos')} fix="npm run update-data:nhl" />
        <HistorialEnVivo />
      </DashboardHeader>

      <PicksPanel {...picks} caveat={t(CAVEATS.nhl)} demoOdds={false} confidenceReason={t('nhl.ordenConfianza')} stake={stake} onStakeChange={setStake} />

      {/* Como la NFL: el calendario es real aunque no haya precio, y aquí se dice por qué no lo hay. */}
      <NflNoLineNote reason={meta?.oddsFallbackReason} detail={meta?.oddsFallbackDetail} hasKey={meta?.hasOddsKey ?? false} />
      <SlateTable rows={slate} demoOdds={false} refrescadas={meta?.oddsRefreshedAt} bands={meta?.bands} />

      {error && <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[15px] text-rose-200">{error}</div>}

      {loading ? (
        <SkeletonList />
      ) : meta && meta.counts.games === 0 ? (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200" data-testid="nhl-sin-datos">
          <p className="font-medium">{t('nhl.sinDatos')}</p>
          <p className="mt-1 text-rose-300/90">{conNodos(t('nhl.sinDatosCuerpo'), { cmd: <code className="rounded bg-rose-900/40 px-1">npm run update-data:nhl</code> })}</p>
        </div>
      ) : games.length === 0 ? (
        <EmptySlate what="NHL" reason="sin-partidos" />
      ) : (
        <>
          <DayFilter days={dayChips} selected={day} onSelect={setDay} />
          {shownGroups.map((group) => (
            <section key={group.key} className="seccion-dia mb-6">
              <DayHeading label={group.label} count={group.items.length} />
              <div className="grid gap-4 grid-cols-[minmax(0,1fr)] xl:grid-cols-[repeat(2,minmax(0,1fr))] xl:items-start">
                {group.items.map((g) => (
                  <GameCard key={g.game.id} item={g} onOpenTeam={abrirEquipo} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      <EloRanking
        title={t('eq.todosLosEquipos', { liga: 'NHL' })}
        rows={power.map((p) => ({
          id: p.id,
          name: p.name,
          elo: p.elo,
          badge: <TeamCrest league="nhl" name={p.name} code={p.id} size={16} />,
          onOpen: () => abrirEquipo(p.id),
          extra: [{ label: t('nhl.partidos'), value: p.games.toLocaleString(localeDe(idioma)), title: t('nhl.partidosTitulo') }],
        }))}
        extraHeaders={[t('nhl.partidos')]}
        footer={<>{t('nhl.eloPie')}</>}
      />
    </div>
  );
}

/** Lo que la app dijo antes de cada partido que enseñó, y cómo le fue. */
function HistorialEnVivo() {
  const { t } = useI18n();
  const [data, setData] = useState<NhlTrackRecord | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let vivo = true;
    nhlApi
      .trackRecord()
      .then((d) => vivo && setData(d))
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);
  if (!data || (data.resolved === 0 && data.pending === 0)) return null;
  return (
    <div className="mt-3 rounded-xl border border-(--line) bg-(--tint) p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="text-[16px]">
          <span className="text-[14px] uppercase tracking-wide text-(--ink-muted)">{t('fbt.titulo')}</span>
          <br />
          {data.resolved === 0 ? (
            <span className="text-(--ink-body)">{t('fbt.pendientes', { n: data.pending })}</span>
          ) : (
            <span className="text-(--ink-strong)">
              {conNodos(t('nflt.acierto'), {
                pct: <strong className="tabular-nums">{pctF((data.accuracy ?? 0), 1)}</strong>,
                n: <strong className="tabular-nums">{data.resolved}</strong>,
              })}
              {data.totalMae != null && <span className="text-(--ink-soft)"> {t('nhl.errorTotal', { n: String(data.totalMae).replace('.', ',') })}</span>}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-(--line) pt-3 text-[14px] text-(--ink-body)">
          {data.vsMarket && <p>{t('nhl.vsMercado', { n: data.vsMarket.n, bm: data.vsMarket.modelBrier, bk: data.vsMarket.marketBrier })}</p>}
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

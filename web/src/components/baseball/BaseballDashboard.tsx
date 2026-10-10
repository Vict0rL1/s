import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { rutaEquipo } from '../../rutas';
import { useLigaEnRuta, ligaRecordada, useFiltroQuery } from '../../lib/rutas';
import {
  pillClass, SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel, DashboardHeader,
  EmptySlate, LeagueFlag, SlateTable, VacioPorqueNoHayCuotas} from '../ui';
import { staleLabel, staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, baseballPicks } from '../../lib/picks';
import { baseballSlate } from '../../lib/slate';
import { useStake } from '../../lib/useStake';
import {
  bsbApi,
  type BsbGameWithPrediction,
  type BsbLeague,
  type BsbMeta,
  type BsbPowerTeam,
  type BsbTrackRecord,
} from '../../lib/baseball';
import GameCard from './GameCard';
import EloRanking from '../EloRanking';
import { formatDate, formatDateTime, dayChipLabel, groupByDay } from '../../lib/format';
import { conNodos, localeDe, useI18n, type Traducir } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';
import { conservarDia, contadorDePeticiones } from '../../lib/carga';

/**
 * The whole baseball tab. Holds its own state and talks only to /api/baseball/*,
 * so switching sports never mixes the four — the other three are untouched while
 * this one is mounted.
 */
export default function BaseballDashboard() {
  const { t: tr, idioma } = useI18n();
  const [meta, setMeta] = useState<BsbMeta | null>(null);
  const [leagues, setLeagues] = useState<BsbLeague[]>([]);
  const [league, setLeague] = useLigaEnRuta('/beisbol', 'predictor.baseball.league');
  const [games, setGames] = useState<BsbGameWithPrediction[]>([]);
  const [power, setPower] = useState<BsbPowerTeam[]>([]);
  const [loading, setLoading] = useState(false);
  const [peticiones] = useState(contadorDePeticiones);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Un equipo abre su página (Fase 5.12): una URL, no un modal.
  const setTeam = (t: { league: string; id: string }) => navigate(rutaEquipo('baseball', t.league, t.id));
  const [refreshing, setRefreshing] = useState(false);
  // null = every day, which is the default: someone who has not asked to filter
  // should see the whole schedule.
  const [day, setDay] = useFiltroQuery('dia');

  useEffect(() => {
    Promise.all([bsbApi.meta(), bsbApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) =>
        setError(tr('bsb.errorCargar', { error: String(e) })),
      );
  }, []);

  const selectable = useMemo(
    () => leagues.filter((l) => l.hasUpcoming || l.games > 0),
    [leagues],
  );
  useEffect(() => {
    if (leagues.length === 0) return;
    if (league && selectable.some((l) => l.id === league)) return;
    const recordada = ligaRecordada('predictor.baseball.league');
    if (recordada && selectable.some((l) => l.id === recordada)) {
      setLeague(recordada);
      return;
    }
    const withGames = selectable.find((l) => l.hasUpcoming) ?? selectable[0];
    setLeague(withGames?.id ?? null);
  }, [selectable, league, leagues.length, setLeague]);

  useEffect(() => {
    if (!league) {
      setGames([]);
      setPower([]);
      return;
    }
    // D8: cambiar dos veces de liga no deja los partidos de la que contestó tarde.
    const n = peticiones.nueva();
    setLoading(true);
    Promise.all([bsbApi.upcoming(league), bsbApi.power(league, 40)])
      .then(([g, p]) => {
        if (!peticiones.esUltima(n)) return;
        setGames(g);
        setPower(p.teams);
      })
      .catch((e) => peticiones.esUltima(n) && setError(String(e)))
      .finally(() => peticiones.esUltima(n) && setLoading(false));
  }, [league]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await bsbApi.refresh();
      const [m, l, g] = await Promise.all([
        bsbApi.meta(),
        bsbApi.leagues(),
        league ? bsbApi.upcoming(league) : Promise.resolve([]),
      ]);
      setMeta(m);
      setLeagues(l);
      setGames(g);
    } catch (e) {
      setError(tr('comun.errorActualizar', { error: String(e) }));
    } finally {
      setRefreshing(false);
    }
  }

  // Grouped by the reader's own local day, and filtered to one of them if asked.
  const dayGroups = useMemo(() => groupByDay(games, (g) => g.game.commence_time, idioma), [games, idioma]);
  const dayChips = useMemo(
    () => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key, new Date(), idioma), count: d.items.length })),
    [dayGroups, idioma],
  );
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;

  // Ranked markets, from the rows already fetched. Recomputed only when those
  // change: it is pure arithmetic over what is on screen, no extra request.
  const picks = useMemo(() => rankPicks(baseballPicks(games)), [games]);
  const [stake, setStake] = useStake();
  // Every price on screen invented by this app rather than fetched — see picks.ts.
  const slate = useMemo(() => baseballSlate(games), [games]);
  const demoOdds = games.length > 0 && games.every((r) => r.game.source === 'fixture');
  // A day that no longer exists after switching league would filter everything
  // away and look like "no games", so the choice is dropped rather than kept.
  // D8: mientras carga no hay días (o son los de la liga anterior): el ?dia= del enlace se conserva.
  useEffect(() => {
    const sigue = conservarDia(day, dayGroups.map((d) => d.key), loading);
    if (sigue !== day) setDay(sigue);
  }, [dayGroups, day, loading]);

  const activeLeague = leagues.find((l) => l.id === league) ?? null;
  const leagueMeta = meta?.leagues.find((l) => l.id === league) ?? null;
  // Computed here rather than inline: the collapsed header needs the short
  // version of this and the expanded one needs the full paragraph, and they must
  // be the same judgement.
  const stale = staleness('baseball', leagueMeta?.historyThrough, meta?.dataSource === 'seed');

  return (
    <div>
      <DashboardHeader
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshTitle={tr('bsb.refrescarTitulo')}
        chips={
          meta && (
            <>
              {tr('eq.chipsEquipos', { partidos: meta.counts.games.toLocaleString(localeDe(idioma)), equipos: meta.counts.teams })}
            </>
          )
        }
        alert={staleLabel(stale, idioma)}
      >
        <p className="max-w-prose text-[15px] leading-relaxed text-(--ink-soft)">
          {conNodos(tr('bsb.lema'), { abridor: <strong>{tr('bsb.abridor')}</strong> })}
        </p>
        {meta && <DataLine meta={meta} />}
        <StaleHistoryWarning
          info={stale}
          what={tr('bsb.elos')}
          fix="npm run update-data:bsb"
        />
        {league && <TrackRecordPanel league={league} />}
      </DashboardHeader>

      {/* The ranked-markets panel. Built from the SAME rows the cards below
          render, so the two can never disagree about a number. */}
      <PicksPanel {...picks} caveat={tr(CAVEATS.baseball)} demoOdds={demoOdds} stake={stake} onStakeChange={setStake} />

      <SlateTable rows={slate} demoOdds={demoOdds} refrescadas={meta?.oddsRefreshedAt} bands={meta?.bands} />

      {games.length === 0 && !loading && (
        <VacioPorqueNoHayCuotas
          reason={meta?.oddsFallbackReason}
          detail={meta?.oddsFallbackDetail}
          hasKey={meta ? meta.hasOddsKey : null}
          demoFixtures={meta?.demoFixtures ?? true}
        />
      )}

      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[15px] text-rose-200">
          {error}
        </div>
      )}

      {selectable.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {selectable.map((l) => (
            <button
              key={l.id}
              onClick={() => setLeague(l.id)}
              title={l.label}
              className={pillClass(league === l.id)}
            >
                <LeagueFlag country={l.country} className="mr-1.5" />
              {l.name}
              {l.upcomingCount > 0 && <span className="ml-1.5 text-(--ink-soft)">{l.upcomingCount}</span>}
              {!l.hasModel && <span className="ml-1.5 text-amber-400" title={tr('eq.sinModeloElo')}>◦</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200">
          <p className="font-medium">{tr('bsb.sinDatos')}</p>
          <p className="mt-1 text-rose-300/90">
            {conNodos(tr('bsb.sinDatosCuerpo'), { cmd: <code className="rounded bg-rose-900/40 px-1">npm run update-data:bsb</code> })}
          </p>
        </div>
      )}

      {activeLeague && !activeLeague.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[15px] leading-relaxed text-amber-200/90">
          <strong>{tr('bsb.sinModeloTitulo', { liga: activeLeague.name })}</strong>{' '}
          {conNodos(tr('bsb.sinModeloCuerpo'), { implicitas: <em>{tr('eq.implicitasMercado')}</em> })}
        </div>
      )}

      {loading ? (
        <SkeletonList />
      ) : games.length === 0 ? (
        <EmptySlate what={activeLeague?.name ?? tr('eq.estaLiga')} reason="sin-partidos" />
      ) : (
        <>
          <DayFilter days={dayChips} selected={day} onSelect={setDay} />
          {shownGroups.map((group) => (
            <section key={group.key} className="seccion-dia mb-6">
              <DayHeading label={group.label} count={group.items.length} />
              {/* Two-up from 1280px. The shell got wider (see SHELL_WIDTH in
                  App.tsx) and a card does not want to BE wider — it wants a
                  neighbour. `items-start` so a card with its breakdown open does
                  not stretch the one beside it.

                  minmax(0,1fr) and NOT grid-cols-1/2: a grid track is `minmax(auto,
                  1fr)` by default, and `auto` means "at least the widest thing that
                  cannot shrink". One nowrap badge inside a card was enough to push
                  the track past the viewport — 5px of horizontal page scroll on a
                  390px phone. Block flow (the `space-y-4` this replaced) clamped the
                  card and let the content overflow internally instead, so the bug
                  arrived with the grid. */}
              <div className="grid gap-4 grid-cols-[minmax(0,1fr)] xl:grid-cols-[repeat(2,minmax(0,1fr))] xl:items-start">
                {group.items.map((g) => (
                  <GameCard key={g.game.id} item={g} onOpenTeam={(lg, id) => setTeam({ league: lg, id })} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      <EloRanking
        title={tr('eq.todosLosEquipos', { liga: activeLeague?.name ?? '' })}
        rows={power.map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          elo: t.elo,
          matches: t.games,
          badge: <TeamCrest league={league!} name={t.name ?? t.id} code={t.id} size={16} />,
          onOpen: () => setTeam({ league: league!, id: t.id }),
          extra: [
            { label: tr('bsb.cfp'), value: (t.rs == null ? undefined : numF(t.rs, 2)) ?? '—', title: tr('bsb.cfpTitulo') },
            { label: tr('bsb.ccp'), value: (t.ra == null ? undefined : numF(t.ra, 2)) ?? '—', title: tr('bsb.ccpTitulo') },
            { label: tr('bsb.partidos'), value: String(t.games), title: tr('bsb.partidosTitulo') },
          ],
        }))}
        extraHeaders={[tr('bsb.cfp'), tr('bsb.ccp'), tr('bsb.partidos')]}
        footer={
          <>{tr('bsb.eloPie')}</>
        }
      />
    </div>
  );
}

/**
 * The origin badge.
 *
 * THREE states, not two. `dataSource` is only written by `update-data`, so a
 * database populated some other way — restored from a copy, or by an older version
 * — leaves it unset. The old version treated anything that was not "retrosheet" as
 * "sin datos", which printed the badge SIN DATOS immediately to the left of
 * "37.262 partidos · 32 equipos". Two claims on one line, one of them false.
 *
 * The game count is the fact that settles whether there is data; the meta key only
 * says where it came from. So an unlabelled but populated database says so, rather
 * than being called empty. (The tennis tab already got this right — this is the
 * check it had and baseball did not.)
 */
function originBadge(meta: BsbMeta, t: Traducir): { text: string; className: string; title: string } {
  if (meta.counts.games === 0) {
    return {
      text: t('td.sinDatos'),
      className: 'bg-rose-900/40 text-rose-300',
      title: t('bsb.origen.vaciaTitulo'),
    };
  }
  if (meta.dataSource === 'retrosheet') {
    return {
      text: t('bsb.origen.retrosheet'),
      className: 'bg-emerald-900/40 text-emerald-300',
      title: t('bsb.origen.retrosheetTitulo'),
    };
  }
  if (meta.dataSource === 'seed') {
    return {
      text: t('td.datosDemo'),
      className: 'bg-amber-900/40 text-amber-300',
      title: t('bsb.origen.demoTitulo'),
    };
  }
  return {
    text: t('bsb.origen.sinRegistrar'),
    className: 'bg-(--raised) text-(--ink-soft)',
    title: t('bsb.origen.sinRegistrarTitulo'),
  };
}

function DataLine({ meta }: { meta: BsbMeta }) {
  const { t, idioma } = useI18n();
  const origin = originBadge(meta, t);
  return (
    <div className="mt-2 space-y-1 text-[14px] text-(--ink-muted)">
      <p>
        <span className={`rounded px-1.5 py-0.5 ${origin.className}`} title={origin.title}>
          {origin.text}
        </span>{' '}
        {t('bsb.lineaDatos', { partidos: meta.counts.games.toLocaleString(localeDe(idioma)), equipos: meta.counts.teams })}
        {meta.updatedAt && <>{t('bsb.actualizado', { fecha: formatDate(meta.updatedAt.slice(0, 10).replace(/-/g, '')) })}</>}
      </p>
      <p>
        {meta.oddsRefreshedAt && <>{t('bsb.cuotasFecha', { fecha: formatDateTime(meta.oddsRefreshedAt, idioma) })}</>}
        {meta.probables > 0 ? (
          <>{t('bsb.abridoresAnunciados', { n: meta.probables })}</>
        ) : (
          <>{t('bsb.sinFeed')}</>
        )}
        {!meta.hasOddsKey && <>{t('eq.configuraCuotas')}</>}
      </p>
    </div>
  );
}

function TrackRecordPanel({ league }: { league: string }) {
  const { t } = useI18n();
  const [rec, setRec] = useState<BsbTrackRecord | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    bsbApi.trackRecord(league).then(setRec).catch(() => setRec(null));
  }, [league]);
  if (!rec || (rec.resolved === 0 && rec.pending === 0)) return null;

  return (
    <div className="mt-3 rounded-xl border border-(--line) bg-(--tint) p-3 text-[14px]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
        <span className="text-(--ink-body)">
          <span className="uppercase tracking-wide text-(--ink-muted)">{t('bsbt.titulo')}</span>{' '}
          {rec.resolved > 0 ? (
            <>
              {t('bsbt.resueltas', { n: rec.resolved })}
              {rec.accuracy != null && <>{t('bsbt.acierto', { p: numF(rec.accuracy * 100, 1) })}</>}
              {rec.brier != null && <> · Brier {numF(rec.brier, 4)}</>}
            </>
          ) : (
            <>{t('bsbt.pendientes', { n: rec.pending })}</>
          )}
        </span>
        <span className="text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>
      {open && rec.resolved > 0 && (
        <div className="mt-2 space-y-2 border-t border-(--line) pt-2 text-(--ink-body)">
          {rec.totalMae != null && (
            <p>
              {t('bsbt.errorTotal', { n: numF(rec.totalMae, 2) })}
              {rec.totalBias != null && (
                <>{t('bsbt.sesgo', { n: `${rec.totalBias >= 0 ? '+' : ''}${numF(rec.totalBias, 2)}` })}</>
              )}
            </p>
          )}
          {rec.byStarterKnown.length > 0 && (
            <div>
              <div className="text-(--ink-muted)">{t('bsbt.segunAbridores')}</div>
              {rec.byStarterKnown.map((b) => (
                <div key={String(b.known)} className="flex justify-between">
                  <span>{b.known ? t('bsbt.anunciados') : t('bsbt.estimados')} ({b.n})</span>
                  <span className="tabular-nums">
                    {b.accuracy != null ? `${pctF(b.accuracy, 1)}` : '—'}
                    {b.brier != null && ` · Brier ${numF(b.brier, 4)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {rec.vsMarket && (
            <p>
              {t('bsbt.vsMercado', {
                n: rec.vsMarket.n,
                m: (rec.vsMarket.modelBrier == null ? undefined : numF(rec.vsMarket.modelBrier, 4)) ?? '—',
                k: (rec.vsMarket.marketBrier == null ? undefined : numF(rec.vsMarket.marketBrier, 4)) ?? '—',
              })}
            </p>
          )}
          <p className="text-(--ink-muted)">
            {t('bsbt.soloAntes')}
          </p>
        </div>
      )}
    </div>
  );
}

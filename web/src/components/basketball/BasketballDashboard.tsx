import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { rutaEquipo } from '../../rutas';
import { useLigaEnRuta, ligaRecordada, useFiltroQuery } from '../../lib/rutas';
import {
  pillClass, SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel, DashboardHeader,
  EmptySlate, LeagueFlag, SlateTable, VacioPorqueNoHayCuotas} from '../ui';
import { staleLabel, staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, basketballPicks } from '../../lib/picks';
import { basketballSlate } from '../../lib/slate';
import { useStake } from '../../lib/useStake';
import { dayChipLabel, groupByDay } from '../../lib/format';
import { bbApi, type BbGameWithPrediction, type BbLeague, type BbMeta, type BbPowerTeam } from '../../lib/basketball';
import GameCard from './GameCard';
import EloRanking from '../EloRanking';
import { DataLine, BbTrackRecordPanel } from './BasketballDashboardPartes';
import { conNodos, localeDe, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';
import { conservarDia, contadorDePeticiones } from '../../lib/carga';

/**
 * The whole basketball tab. Holds its own state and talks only to
 * /api/basketball/*, so switching sports never mixes the two — the tennis view is
 * untouched while this one is mounted, and vice versa.
 */
export default function BasketballDashboard() {
  const { t: tr, idioma } = useI18n();
  const [meta, setMeta] = useState<BbMeta | null>(null);
  const [leagues, setLeagues] = useState<BbLeague[]>([]);
  const [league, setLeague] = useLigaEnRuta('/baloncesto', 'predictor.basketball.league');
  const [games, setGames] = useState<BbGameWithPrediction[]>([]);
  const [power, setPower] = useState<BbPowerTeam[]>([]);
  const [loading, setLoading] = useState(false);
  const [peticiones] = useState(contadorDePeticiones);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Un equipo abre su página (Fase 5.12): una URL, no un modal.
  const setTeam = (t: { league: string; id: string }) => navigate(rutaEquipo('basketball', t.league, t.id));
  const [refreshing, setRefreshing] = useState(false);
  // null = every day, which is the default: someone who has not asked to filter
  // should see the whole schedule.
  const [day, setDay] = useFiltroQuery('dia');

  useEffect(() => {
    Promise.all([bbApi.meta(), bbApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) =>
        setError(
          tr('bk.errorCargar', { error: String(e) }),
        ),
      );
  }, []);

  // Prefer a league that actually has games to show; fall back to one with data.
  const selectable = useMemo(
    () => leagues.filter((l) => l.hasUpcoming || l.games > 0),
    [leagues],
  );
  useEffect(() => {
    if (leagues.length === 0) return;
    if (league && selectable.some((l) => l.id === league)) return;
    const recordada = ligaRecordada('predictor.basketball.league');
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
    Promise.all([bbApi.upcoming(league), bbApi.power(league, 40)])
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
      await bbApi.refresh();
      const [m, l, g] = await Promise.all([
        bbApi.meta(),
        bbApi.leagues(),
        league ? bbApi.upcoming(league) : Promise.resolve([]),
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
  const picks = useMemo(() => rankPicks(basketballPicks(games)), [games]);
  const [stake, setStake] = useStake();
  // Every price on screen invented by this app rather than fetched — see picks.ts.
  const slate = useMemo(() => basketballSlate(games), [games]);
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

  // Computed once: the collapsed header needs the short version and the
  // expanded one the full paragraph, and they must be the same judgement.
  const stale = staleness('basketball', leagueMeta?.historyThrough, meta?.dataSource === 'seed');

  return (
    <div>
      <DashboardHeader
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshTitle={tr('eq.refrescarTitulo')}
        chips={meta && (<>{tr('eq.chipsEquipos', { partidos: meta.counts.games.toLocaleString(localeDe(idioma)), equipos: meta.counts.teams })}</>)}
        alert={staleLabel(stale, idioma)}
      >
          <p className="max-w-prose text-[15px] leading-relaxed text-(--ink-soft)">
            {tr('bk.lema')}
          </p>
        {meta && <DataLine meta={meta} />}
        <StaleHistoryWarning
          info={stale}
          what={tr('bk.elos')}
          fix="npm run update-data:bb"
        />
        {league && <BbTrackRecordPanel league={league} />}
      </DashboardHeader>

      {/* The ranked-markets panel. Built from the SAME rows the cards below
          render, so the two can never disagree about a number. */}
      <PicksPanel {...picks} caveat={tr(CAVEATS.basketball)} demoOdds={demoOdds} stake={stake} onStakeChange={setStake} />

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

      {/* League selector */}
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
          <p className="font-medium">{tr('bk.sinDatos')}</p>
          <p className="mt-1 text-rose-300/90">
            {conNodos(tr('eq.sinDatosCuerpo'), { cmd: <code className="rounded bg-rose-900/40 px-1">npm run update-data:bb</code> })}
          </p>
        </div>
      )}

      {activeLeague && !activeLeague.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[15px] leading-relaxed text-amber-200/90">
          <strong>{tr('eq.sinModeloTitulo', { liga: activeLeague.name })}</strong>{' '}
          {conNodos(tr('bk.sinModeloCuerpo'), { implicitas: <em>{tr('eq.implicitasMercado')}</em> })}
        </div>
      )}

      {/* Games */}
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

      {/* All teams, by Elo — "la información de todos los equipos" */}
      <EloRanking
        title={tr('eq.todosLosEquipos', { liga: activeLeague?.name ?? '' })}
        rows={power.map((t) => ({
          id: t.id,
          name: t.name,
          elo: t.elo,
          matches: t.games,
          badge: <TeamCrest league={league!} name={t.name} code={t.id} size={16} />,
          onOpen: () => setTeam({ league: league!, id: t.id }),
          extra: [
            { label: tr('eq.anota'), value: (t.ppg == null ? undefined : numF(t.ppg, 1)) ?? '—', title: tr('eq.anotaTitulo') },
            { label: tr('eq.recibe'), value: (t.papg == null ? undefined : numF(t.papg, 1)) ?? '—', title: tr('eq.recibeTitulo') },
            {
              label: tr('eq.dif'),
              value:
                t.ppg != null && t.papg != null
                  ? `${t.ppg - t.papg > 0 ? '+' : ''}${numF((t.ppg - t.papg), 1)}`
                  : '—',
              title: tr('eq.difPuntosTitulo'),
            },
          ],
        }))}
        extraHeaders={[tr('eq.anota'), tr('eq.recibe'), tr('eq.dif')]}
        footer={
          <>{tr('bk.eloPie')}</>
        }
      />
    </div>
  );
}

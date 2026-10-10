import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { rutaEquipo } from '../../rutas';
import { useLigaEnRuta, ligaRecordada, useFiltroQuery } from '../../lib/rutas';
import {
  pillClass, SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel, DashboardHeader,
  EmptySlate, LeagueFlag, NflNoLineNote, SlateTable, VacioPorqueNoHayCuotas} from '../ui';
import { staleLabel, staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, nflPicks } from '../../lib/picks';
import { nflSlate } from '../../lib/slate';
import { useStake } from '../../lib/useStake';
import { dayChipLabel, groupByDay } from '../../lib/format';
import { nflApi, type NflGameWithPrediction, type NflLeague, type NflMeta } from '../../lib/nfl';
import GameCard from './GameCard';
import EloRanking from '../EloRanking';
import { DataLine, NflTrackRecordPanel } from './NflDashboardPartes';
import { conNodos, localeDe, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';
import { conservarDia, contadorDePeticiones } from '../../lib/carga';

/**
 * The whole American football tab. Holds its own state and talks only to
 * /api/nfl/*, so switching sports never mixes anything.
 *
 * The header carries something no other tab has: the two league-wide numbers the
 * model TRACKS rather than assumes — what home field is worth right now, and how
 * many points a game is producing. Both moved a lot over the archive (home field
 * from +3.5 points to under +2, and briefly to zero in the empty stadiums of
 * 2020), so showing today's value is showing something the model actually
 * learned rather than a constant somebody typed in.
 */
export default function NflDashboard() {
  const { t: tr, idioma } = useI18n();
  const [meta, setMeta] = useState<NflMeta | null>(null);
  const [leagues, setLeagues] = useState<NflLeague[]>([]);
  const [league, setLeague] = useLigaEnRuta('/nfl', 'predictor.nfl.league');
  const [games, setGames] = useState<NflGameWithPrediction[]>([]);
  const [power, setPower] = useState<
    { id: string; name: string; elo: number; games: number; pf: number | null; pa: number | null }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [peticiones] = useState(contadorDePeticiones);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Un equipo abre su página (Fase 5.12): una URL, no un modal.
  const setTeam = (t: { league: string; id: string }) => navigate(rutaEquipo('nfl', t.league, t.id));
  const [refreshing, setRefreshing] = useState(false);
  // null = every day, which is the default: someone who has not asked to filter
  // should see the whole schedule.
  const [day, setDay] = useFiltroQuery('dia');

  useEffect(() => {
    Promise.all([nflApi.meta(), nflApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) =>
        setError(tr('nfl.errorCargar', { error: String(e) })),
      );
  }, []);

  const selectable = useMemo(() => leagues.filter((l) => l.hasUpcoming || l.games > 0), [leagues]);
  useEffect(() => {
    if (leagues.length === 0) return;
    if (league && selectable.some((l) => l.id === league)) return;
    const recordada = ligaRecordada('predictor.nfl.league');
    if (recordada && selectable.some((l) => l.id === recordada)) {
      setLeague(recordada);
      return;
    }
    setLeague((selectable.find((l) => l.hasUpcoming) ?? selectable[0])?.id ?? null);
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
    Promise.all([nflApi.upcoming(league), nflApi.power(league)])
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
      await nflApi.refresh();
      const [m, l, g] = await Promise.all([
        nflApi.meta(),
        nflApi.leagues(),
        league ? nflApi.upcoming(league) : Promise.resolve([]),
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
  // 'confidence' on purpose — see the note on rankPicks. The market column is
  // populated, but on this sport it must not decide the order.
  const picks = useMemo(
    () => rankPicks(nflPicks(games), Date.now(), { basis: 'confidence' }),
    [games],
  );
  const [stake, setStake] = useStake();
  // Every price on screen invented by this app rather than fetched — see picks.ts.
  const slate = useMemo(() => nflSlate(games), [games]);
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
  const stale = staleness('nfl', leagueMeta?.historyThrough);

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
            {tr('nfl.lema')}
          </p>
        {meta && <DataLine meta={meta} />}
        <StaleHistoryWarning
          info={stale}
          what={tr('nfl.elos')}
          fix="npm run update-data:naf"
        />
        {league && <NflTrackRecordPanel league={league} />}
      </DashboardHeader>

      {/* The ranked-markets panel. Built from the SAME rows the cards below
          render, so the two can never disagree about a number. */}
      <PicksPanel
        {...picks}
        caveat={tr(CAVEATS.nfl)}
        demoOdds={demoOdds}
        confidenceReason={tr('nfl.ordenConfianza')}
        stake={stake}
        onStakeChange={setStake}
      />

      <NflNoLineNote
        reason={meta?.oddsFallbackReason}
        detail={meta?.oddsFallbackDetail}
        hasKey={meta ? meta.hasOddsKey : null}
      />

      {/* La NFL es la razón por la que esta tabla existe: es el único deporte que no se
          inventa cuotas, así que `PicksPanel` se retira entera cuando no hay línea y la
          pestaña se quedaba sin ninguna vista de conjunto. `demoOdds` aquí es siempre
          falso —nunca hay precios inventados— pero se pasa igual por coherencia. */}
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
              {!l.hasModel && (
                <span className="ml-1.5 text-amber-400" title={tr('eq.sinModeloElo')}>
                  ◦
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200">
          <p className="font-medium">{tr('nfl.sinDatos')}</p>
          <p className="mt-1 text-rose-300/90">
            {conNodos(tr('nfl.sinDatosCuerpo'), { cmd: <code className="rounded bg-rose-900/40 px-1">npm run update-data:naf</code> })}
          </p>
        </div>
      )}

      {activeLeague && !activeLeague.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[15px] leading-relaxed text-amber-200/90">
          <strong>{tr('eq.sinModeloTitulo', { liga: activeLeague.name })}</strong>{' '}
          {conNodos(tr('nfl.sinModeloCuerpo'), { implicitas: <em>{tr('eq.implicitasMercado')}</em> })}
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
          name: t.name,
          elo: t.elo,
          badge: <TeamCrest league={league!} name={t.name} code={t.id} size={16} />,
          onOpen: () => setTeam({ league: league!, id: t.id }),
          extra: [
            { label: tr('eq.anota'), value: (t.pf == null ? undefined : numF(t.pf, 1)) ?? '—', title: tr('eq.anotaTitulo') },
            { label: tr('eq.recibe'), value: (t.pa == null ? undefined : numF(t.pa, 1)) ?? '—', title: tr('eq.recibeTitulo') },
            {
              label: tr('eq.dif'),
              value:
                t.pf != null && t.pa != null
                  ? `${t.pf - t.pa > 0 ? '+' : ''}${numF((t.pf - t.pa), 1)}`
                  : '—',
              title: tr('eq.difPuntosTitulo'),
            },
          ],
        }))}
        extraHeaders={[tr('eq.anota'), tr('eq.recibe'), tr('eq.dif')]}
        footer={
          <>{tr('nfl.eloPie')}</>
        }
      />
    </div>
  );
}

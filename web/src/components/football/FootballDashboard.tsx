import { useEffect, useMemo, useRef, useState } from 'react';
import { reportClientLatency } from '../../lib/liveOdds';
import {
  pillClass, SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel, DashboardHeader,
  EmptySlate, LeagueFlag, SlateTable, VacioPorqueNoHayCuotas} from '../ui';
import { staleLabel, staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, footballPicks } from '../../lib/picks';
import { footballSlate } from '../../lib/slate';
import { useStake } from '../../lib/useStake';
import {
  fbApi,
  type FbFixtureWithPrediction,
  type FbLeague,
  type FbMeta,
  type FbPowerTeam,
} from '../../lib/football';
import MatchCard from './MatchCard';
import EloRanking from '../EloRanking';
import { dayChipLabel, groupByDay } from '../../lib/format';
import { useNavigate } from 'react-router';
import { rutaEquipo } from '../../rutas';
import { useLigaEnRuta, ligaRecordada, useFiltroQuery } from '../../lib/rutas';
import { TrackRecordPanel } from './FootballDashboardPartes';
import { conNodos, localeDe, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';
import { conservarDia, contadorDePeticiones, filasDeLaLiga } from '../../lib/carga';

/**
 * The ⚽ tab.
 *
 * Leagues are SUB-TABS inside this tab rather than one long list, because a
 * combined feed of the Premier League, LaLiga, MLS and the Brasileirão is not
 * something anyone reads top to bottom — you come here for one competition. The
 * chosen league is remembered, so reopening lands where you left off.
 */
const STORAGE_KEY = 'predictor.football.league';

export default function FootballDashboard() {
  const { t: tr, idioma } = useI18n();
  const [meta, setMeta] = useState<FbMeta | null>(null);
  const [leagues, setLeagues] = useState<FbLeague[]>([]);
  const [league, setLeague] = useLigaEnRuta('/futbol', STORAGE_KEY);
  const [fixturesTodas, setFixtures] = useState<FbFixtureWithPrediction[]>([]);
  // Solo las filas de la liga elegida (G3): al cambiar de liga, las de la anterior siguen en el
  // estado hasta que llega la respuesta, y se veían bajo la liga nueva.
  const fixtures = useMemo(() => filasDeLaLiga(fixturesTodas, (f) => f.fixture.league, league), [fixturesTodas, league]);
  const [power, setPower] = useState<FbPowerTeam[]>([]);
  const [loading, setLoading] = useState(false);
  const [peticiones] = useState(contadorDePeticiones);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Un equipo abre su página (Fase 5.12): una URL, no un modal.
  const setTeam = (t: { league: string; id: string }) => navigate(rutaEquipo('football', t.league, t.id));
  const [refreshing, setRefreshing] = useState(false);
  // null = every day, which is the default: someone who has not asked to filter
  // should see the whole schedule.
  const [day, setDay] = useFiltroQuery('dia');
  /**
   * Cuándo llegó la respuesta, para poder medir lo que tarda en verse.
   *
   * Un ref y no un estado a propósito: guardarlo en estado provocaría el render que
   * intenta medir, y la medición se perseguiría a sí misma.
   */
  const arrivedAt = useRef<number | null>(null);

  useEffect(() => {
    Promise.all([fbApi.meta(), fbApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) => setError(tr('fb.errorCargar', { error: String(e) })));
  }, [tr]);

  // Only offer leagues that have something to show.
  const selectable = useMemo(
    () => leagues.filter((l) => l.hasUpcoming || l.matches > 0),
    [leagues],
  );

  useEffect(() => {
    // Hasta que no llegan las ligas no se toca la URL: un enlace profundo no puede perderse
    // en el primer render.
    if (leagues.length === 0) return;
    if (league && selectable.some((l) => l.id === league)) return;
    const saved = ligaRecordada(STORAGE_KEY);
    // `saved &&` would yield the empty string when nothing is stored, so the
    // lookup is written as an explicit null to keep the type a league or null.
    const remembered = saved ? selectable.find((l) => l.id === saved) : undefined;
    const pick = remembered ?? selectable.find((l) => l.hasUpcoming) ?? selectable[0];
    setLeague(pick?.id ?? null);
  }, [selectable, league, leagues.length, setLeague]);

  useEffect(() => {
    if (!league) return;
    // D8: cambiar dos veces de liga no deja los partidos de la que contestó tarde.
    const n = peticiones.nueva();
    setLoading(true);
    Promise.all([fbApi.upcoming(league), fbApi.power(league, 40)])
      .then(([f, p]) => {
        if (!peticiones.esUltima(n)) return;
        // La etapa «cliente» empieza AQUÍ: la respuesta ya está parseada y lo que queda
        // por medir es lo único que el servidor no puede ver — React montando las
        // tarjetas y el navegador pintándolas.
        arrivedAt.current = performance.now();
        setFixtures(f);
        setPower(p.teams);
      })
      .catch((e) => peticiones.esUltima(n) && setError(String(e)))
      .finally(() => peticiones.esUltima(n) && setLoading(false));
  }, [league]);

  /**
   * Cerrar la medición cuando esto está de verdad en pantalla.
   *
   * Dos `requestAnimationFrame` anidados y no uno: el primero se ejecuta ANTES del
   * pintado del fotograma, así que medir ahí daría un número sistemáticamente corto. El
   * segundo corre ya en el fotograma siguiente, o sea después de que el usuario lo haya
   * visto — que es lo que dice medir esta etapa.
   */
  useEffect(() => {
    const started = arrivedAt.current;
    if (started == null) return;
    arrivedAt.current = null;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => reportClientLatency(started, { sport: 'football' }));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [fixtures]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await fbApi.refresh();
      const [m, l, f] = await Promise.all([
        fbApi.meta(),
        fbApi.leagues(),
        league ? fbApi.upcoming(league) : Promise.resolve([]),
      ]);
      setMeta(m);
      setLeagues(l);
      setFixtures(f);
    } catch (e) {
      setError(tr('comun.errorActualizar', { error: String(e) }));
    } finally {
      setRefreshing(false);
    }
  }

  // Grouped by the reader's own local day, and filtered to one of them if asked.
  const dayGroups = useMemo(
    () => groupByDay(fixtures, (f) => f.fixture.commence_time, idioma),
    [fixtures, idioma],
  );
  const dayChips = useMemo(
    () => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key, new Date(), idioma), count: d.items.length })),
    [dayGroups, idioma],
  );
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;

  // Ranked markets, from the rows already fetched. Recomputed only when those
  // change: it is pure arithmetic over what is on screen, no extra request.
  const picks = useMemo(() => rankPicks(footballPicks(fixtures)), [fixtures]);
  const [stake, setStake] = useStake();
  // Every price on screen invented by this app rather than fetched — see picks.ts.
  const slate = useMemo(() => footballSlate(fixtures), [fixtures]);
  const demoOdds = fixtures.length > 0 && fixtures.every((r) => r.fixture.source === 'fixture');
  // A day that no longer exists after switching league would filter everything
  // away and look like "no fixtures", so the choice is dropped rather than kept.
  // D8: mientras carga no hay días (o son los de la liga anterior): el ?dia= del enlace se conserva.
  useEffect(() => {
    const sigue = conservarDia(day, dayGroups.map((d) => d.key), loading);
    if (sigue !== day) setDay(sigue);
  }, [dayGroups, day, loading]);

  const active = leagues.find((l) => l.id === league) ?? null;
  const activeMeta = meta?.leagues.find((l) => l.id === league) ?? null;

  // Computed once: the collapsed header needs the short version and the
  // expanded one the full paragraph, and they must be the same judgement.
  const stale = staleness('football', activeMeta?.historyThrough, meta?.dataSource === 'seed');

  return (
    <div>
      <DashboardHeader
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshTitle={tr('eq.refrescarTitulo')}
        chips={meta && (<>{tr('eq.chipsEquipos', { partidos: meta.counts.matches.toLocaleString(localeDe(idioma)), equipos: meta.counts.teams })}</>)}
        alert={staleLabel(stale, idioma)}
      >
          <p className="max-w-prose text-[15px] leading-relaxed text-(--ink-soft)">
            {tr('fb.lema')}
          </p>
        <StaleHistoryWarning
          info={stale}
          what={tr('fb.elosGoles')}
          fix="npm run update-data:fb"
        />
        {league && <TrackRecordPanel league={league} />}
      </DashboardHeader>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[15px] text-rose-200">
          {error}
        </div>
      )}

      {/* ---- LEAGUE SUB-TABS ---- */}
      {selectable.length > 0 ? (
        <nav
          // UNA FILA QUE SE DESLIZA EN EL MÓVIL, no nueve que se apilan.
          //
          // Con 17 ligas, `flex-wrap` en una pantalla de 390 px produce nueve filas de
          // pastillas: 700 píxeles de selector —más de una pantalla entera— antes de
          // llegar al primer partido. El selector acababa siendo el contenido.
          //
          // En ancho de teléfono se convierte en una sola fila con desplazamiento
          // horizontal; desde `sm` vuelve a envolver, porque ahí caben en dos filas y
          // verlas todas de golpe sí ayuda a elegir. `snap` para que al soltar el dedo
          // quede una pastilla entera a la vista y no cortada por la mitad.
          className="mb-4 flex snap-x gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
          role="tablist" aria-label={tr('eq.ligas')}>
          {selectable.map((l) => {
            const on = league === l.id;
            return (
              <button
                key={l.id}
                role="tab"
                aria-selected={on}
                onClick={() => setLeague(l.id)}
                title={l.label}
                className={pillClass(on)}
              >
                <LeagueFlag country={l.country} className="mr-1.5" />
              {l.name}
                {l.upcomingCount > 0 && <span className="ml-1.5 text-(--ink-soft)">{l.upcomingCount}</span>}
                {!l.hasModel && (
                  <span className="ml-1.5 text-amber-400" title={tr('fb.sinModeloMercado')}>
                    ◦
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      ) : (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200">
          <p className="font-medium">{tr('fb.sinDatos')}</p>
          <p className="mt-1 text-rose-300/90">
            {conNodos(tr('eq.sinDatosCuerpo'), { cmd: <code className="rounded bg-rose-900/40 px-1">npm run update-data:fb</code> })}
          </p>
        </div>
      )}

      {active && !active.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[15px] leading-relaxed text-amber-200/90">
          <strong>{tr('eq.sinModeloTitulo', { liga: active.name })}</strong>{' '}
          {conNodos(tr('fb.sinModeloCuerpo'), { delMercado: <em>{tr('fb.delMercado')}</em> })}
        </div>
      )}

      <StaleHistoryWarning
        info={staleness('football', activeMeta?.historyThrough, meta?.dataSource === 'seed')}
        what={tr('fb.elosGoles')}
        fix="npm run update-data:fb"
      />
      {league && <TrackRecordPanel league={league} />}

      {/* The ranked-markets panel. Built from the SAME rows the cards below render,
          so the two can never disagree about a number. */}
      <PicksPanel {...picks} caveat={tr(CAVEATS.football)} demoOdds={demoOdds} stake={stake} onStakeChange={setStake} />

      <SlateTable rows={slate} demoOdds={demoOdds} refrescadas={meta?.oddsRefreshedAt} bands={meta?.bands} />

      {fixtures.length === 0 && !loading && (
        <VacioPorqueNoHayCuotas
          reason={meta?.oddsFallbackReason}
          detail={meta?.oddsFallbackDetail}
          hasKey={meta ? meta.hasOddsKey : null}
          demoFixtures={meta?.demoFixtures ?? true}
        />
      )}

      {loading ? (
        <SkeletonList />
      ) : fixtures.length === 0 ? (
        <EmptySlate what={active?.name ?? tr('eq.estaLiga')} reason="sin-partidos" />
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
                {group.items.map((f) => (
                  <MatchCard
                    key={f.fixture.id}
                    item={f}
                    onOpenTeam={(lg, id) => setTeam({ league: lg, id })}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {/* All teams in the league, ranked by Elo */}
      <EloRanking
        title={tr('eq.todosLosEquipos', { liga: active?.name ?? '' })}
        rows={power.map((t) => ({
          id: t.id,
          name: t.name,
          elo: t.elo,
          matches: t.matches,
          badge: <TeamCrest league={league!} name={t.name} code={t.id} size={16} />,
          onOpen: () => setTeam({ league: league!, id: t.id }),
          extra: [
            { label: tr('fb.gf'), value: (t.gf == null ? undefined : numF(t.gf, 2)) ?? '—', title: tr('fb.gfTitulo') },
            { label: tr('fb.gc'), value: (t.ga == null ? undefined : numF(t.ga, 2)) ?? '—', title: tr('fb.gcTitulo') },
            {
              label: tr('eq.dif'),
              value:
                t.gf != null && t.ga != null
                  ? `${t.gf - t.ga > 0 ? '+' : ''}${numF((t.gf - t.ga), 2)}`
                  : '—',
              title: tr('fb.difTitulo'),
            },
          ],
        }))}
        extraHeaders={[tr('fb.gf'), tr('fb.gc'), tr('eq.dif')]}
        footer={
          <>{tr('fb.eloPie')}</>
        }
      />
    </div>
  );
}

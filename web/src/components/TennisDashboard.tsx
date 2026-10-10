import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { rutaJugador } from '../rutas';
import { useLigaEnRuta, ligaRecordada, useFiltroQuery } from '../lib/rutas';
import {
  api,
  type Meta,
  type Tour,
  type TournamentInfo,
  type UpcomingWithPrediction,
} from '../lib/api';
import MatchCard from './MatchCard';
import TrackRecordPanel from './TrackRecordPanel';
import TennisEloPanel from './TennisEloPanel';
import {
  DayFilter, DayHeading, pillClass, StaleHistoryWarning, PicksPanel, DashboardHeader,
  EmptySlate, SlateTable, VacioPorqueNoHayCuotas,
} from './ui';
import AskPanel from './AskPanel';
import { staleLabel, staleness } from '../lib/staleness';
import { CAVEATS, rankPicks, tennisPicks } from '../lib/picks';
import { tennisSlate } from '../lib/slate';
import { useStake } from '../lib/useStake';
import { dayChipLabel, groupByDay } from '../lib/format';
import { RefreshInfo, DataBadge, ShortSlateNote } from './TennisDashboardPartes';
import { conNodos, localeDe, useI18n } from '../i18n';
import { conservarDia, contadorDePeticiones, torneoValido } from '../lib/carga';

const bloque = (texto: string, clase = 'rounded bg-(--raised) px-1') => <code className={clase}>{texto}</code>;

export default function TennisDashboard() {
  const { t, idioma } = useI18n();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tours, setTours] = useState<Tour[]>([]);
  const [tournaments, setTournaments] = useState<TournamentInfo[]>([]);
  // ¿Llegó ya la lista de torneos de este circuito? Hasta entonces, el ?torneo= del enlace se conserva (G2).
  const [torneosDe, setTorneosDe] = useState<string | null>(null);
  // El tour va en la ruta (/tenis/atp) y el torneo en la query (?torneo=): un enlace copiado
  // abre lo mismo.
  const [tourRuta, setTour] = useLigaEnRuta('/tenis', 'predictor.tennis.tour');
  const tour = tourRuta ?? ligaRecordada('predictor.tennis.tour') ?? 'atp';
  const [tournamentId, setTournamentId] = useFiltroQuery('torneo');
  const [matches, setMatches] = useState<UpcomingWithPrediction[]>([]);
  const [loading, setLoading] = useState(false);
  const [peticiones] = useState(contadorDePeticiones);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Un jugador abre su página (Fase 5.12).
  const setProfile = (x: { tour: string; id: number }) => navigate(rutaJugador(x.tour, x.id));
  const [refreshing, setRefreshing] = useState(false);
  // null = every day. See the note in the other dashboards.
  const [day, setDay] = useFiltroQuery('dia');

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await api.refresh();
      const [m, tt, up] = await Promise.all([
        api.meta(),
        api.tournaments(tour),
        api.upcoming(tour, tournamentId ?? undefined),
      ]);
      setMeta(m);
      setTournaments(tt.tournaments);
      setMatches(up);
    } catch (e) {
      setError(t('comun.errorActualizar', { error: String(e) }));
    } finally {
      setRefreshing(false);
    }
  }

  // Initial load: meta + tours.
  useEffect(() => {
    Promise.all([api.meta(), api.tours()])
      .then(([m, t]) => {
        setMeta(m);
        setTours(t);
      })
      .catch((e) => setError(t('td.errorApi', { error: String(e) })));
  }, []);

  // Tournaments depend on the selected tour (only those with upcoming matches).
  useEffect(() => {
    let vivo = true;
    api
      .tournaments(tour)
      .then((tt) => {
        if (!vivo) return;
        setTournaments(tt.tournaments);
        setTorneosDe(tour);
      })
      .catch((e) => vivo && setError(String(e)));
    return () => {
      vivo = false;
    };
  }, [tour]);

  // Tournaments that actually have upcoming matches for the selected tour.
  const dayGroups = useMemo(
    () => groupByDay(matches, (m) => m.match.commence_time, idioma),
    [matches, idioma],
  );
  const dayChips = useMemo(
    () => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key, new Date(), idioma), count: d.items.length })),
    [dayGroups, idioma],
  );
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;

  // Ranked markets, from the rows already fetched. Recomputed only when those
  // change: it is pure arithmetic over what is on screen, no extra request.
  const picks = useMemo(() => rankPicks(tennisPicks(matches)), [matches]);
  const slate = useMemo(() => tennisSlate(matches), [matches]);
  const [stake, setStake] = useStake();
  // Every price on screen invented by this app rather than fetched — see picks.ts.
  const demoOdds = matches.length > 0 && matches.every((r) => r.match.source === 'fixture');
  // D8: mientras carga no hay días (o son los de la liga anterior): el ?dia= del enlace se conserva.
  useEffect(() => {
    const sigue = conservarDia(day, dayGroups.map((d) => d.key), loading);
    if (sigue !== day) setDay(sigue);
  }, [dayGroups, day, loading]);

  const tourTournaments = useMemo(
    () => tournaments.filter((t) => t.tours.includes(tour) && t.hasUpcoming),
    [tournaments, tour],
  );

  // Keep a valid tournament selected when the tour changes — but only once this tour's list has
  // arrived: before that the list is empty and a deep link's ?torneo= was wiped (G2).
  useEffect(() => {
    const valido = torneoValido(tournamentId, tourTournaments, torneosDe === tour);
    if (valido !== tournamentId) setTournamentId(valido);
  }, [tourTournaments, tournamentId, torneosDe, tour]);

  // Load matches for tour + tournament.
  useEffect(() => {
    if (!tournamentId) {
      setMatches([]);
      return;
    }
    // D8: cambiar dos veces de liga no deja los partidos de la que contestó tarde.
    const n = peticiones.nueva();
    setLoading(true);
    api
      .upcoming(tour, tournamentId)
      .then((m) => peticiones.esUltima(n) && setMatches(m))
      .catch((e) => peticiones.esUltima(n) && setError(String(e)))
      .finally(() => peticiones.esUltima(n) && setLoading(false));
  }, [tour, tournamentId]);

  // Computed once: the collapsed header needs the short version and the expanded
  // one the full paragraph, and they must be the same judgement.
  const stale = staleness('tennis', meta?.historyThrough, meta?.dataSource === 'seed');

  return (
    <div>
      <DashboardHeader
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshTitle={t('td.refrescarTitulo')}
        chips={meta && <>{t('td.chips', { partidos: meta.counts.matches.toLocaleString(localeDe(idioma)), jugadores: meta.counts.players })}</>}
        alert={staleLabel(stale, idioma)}
      >
          <p className="max-w-prose text-[15px] leading-relaxed text-(--ink-soft)">
            {t('td.lema')}
          </p>
        {meta && <div className="mt-2"><DataBadge meta={meta} /></div>}
        {meta && <RefreshInfo meta={meta} />}
        <StaleHistoryWarning
          info={stale}
          what={t('td.elosSuperficie')}
          fix="npm run update-data"
        />
        <TrackRecordPanel tour={tour} />
      </DashboardHeader>

      {/* The ranked-markets panel. Built from the SAME rows the cards below
          render, so the two can never disagree about a number. */}
      <PicksPanel {...picks} caveat={t(CAVEATS.tennis)} demoOdds={demoOdds} stake={stake} onStakeChange={setStake} />

      <SlateTable rows={slate} demoOdds={demoOdds} refrescadas={meta?.oddsRefreshedAt} bands={meta?.bands} />

      <AskPanel />

      {matches.length === 0 && !loading && (
        <VacioPorqueNoHayCuotas
          reason={meta?.oddsFallbackReason}
          detail={meta?.oddsFallbackDetail}
          hasKey={meta ? meta.hasOddsKey : null}
          demoFixtures={meta?.demoFixtures ?? true}
        />
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-[16px] text-rose-300">
          {error}
        </div>
      )}

      {/* Tour selector */}
      <div className="mb-4 flex gap-2">
        {tours.map((t) => (
          <button
            key={t.id}
            onClick={() => setTour(t.id)}
            className={pillClass(tour === t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>

      {/* Tournament selector */}
      {tourTournaments.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {tourTournaments.map((t) => (
            <button
              key={t.id}
              onClick={() => setTournamentId(t.id)}
              className={pillClass(tournamentId === t.id)}
            >
              {t.name}
              <span className="ml-1.5 text-(--ink-soft)">{t.upcomingCount}</span>
            </button>
          ))}
        </div>
      ) : meta && meta.counts.matches === 0 ? (
        <div className="mb-6 rounded-lg border border-rose-800/60 bg-rose-950/40 p-4 text-[16px] text-rose-200">
          <p className="font-medium">{t('td.vaciaTitulo')}</p>
          <p className="mt-1 text-rose-300/90">
            {conNodos(t('td.vaciaCuerpo'), {
              update: bloque('npm run update-data', 'rounded bg-rose-900/40 px-1'),
              seed: bloque('npm run seed', 'rounded bg-rose-900/40 px-1'),
            })}
          </p>
        </div>
      ) : (
        <EmptySlate
          what={tour.toUpperCase()}
          reason={(meta?.byTour?.[tour]?.matches ?? 1) === 0 ? 'sin-fuente' : 'sin-partidos'}
          detail={
            (meta?.byTour?.[tour]?.matches ?? 1) === 0 ? (
              <>
                <p>{conNodos(t('td.sinFuente1'), { wta: bloque('JeffSackmann/tennis_wta'), tml: bloque('Tennismylife') })}</p>
                <p className="mt-1.5">
                  {conNodos(t('td.sinFuente2'), {
                    fuente: <strong className="text-(--ink-soft)">tennis-data.co.uk</strong>,
                    update: bloque('npm run update-data'),
                  })}
                </p>
              </>
            ) : undefined
          }
        />
      )}

      {/* Matches */}
      {loading ? (
        <p className="text-(--ink-muted)">{t('form.cargandoPartidos')}</p>
      ) : (
        <>
          <DayFilter days={dayChips} selected={day} onSelect={setDay} />
          <ShortSlateNote matches={matches} meta={meta} />
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
                {group.items.map((m) => (
                  <MatchCard
                    key={m.match.id}
                    item={m}
                    onOpenPlayer={(t, id) => setProfile({ tour: t, id })}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      <TennisEloPanel tour={tour} onOpenPlayer={(t, id) => setProfile({ tour: t, id })} />
    </div>
  );
}

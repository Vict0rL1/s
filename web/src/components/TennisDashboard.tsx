import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type Meta,
  type Tour,
  type TournamentInfo,
  type UpcomingWithPrediction,
} from '../lib/api';
import MatchCard from './MatchCard';
import PlayerProfile from './PlayerProfile';
import TrackRecordPanel from './TrackRecordPanel';
import { DayFilter, DayHeading, pillClass, StaleHistoryWarning, PicksPanel } from './ui';
import { staleness } from '../lib/staleness';
import { CAVEATS, rankPicks, tennisPicks } from '../lib/picks';
import { useStake } from '../lib/useStake';
import { dayChipLabel, groupByDay } from '../lib/format';

export default function TennisDashboard() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tours, setTours] = useState<Tour[]>([]);
  const [tournaments, setTournaments] = useState<TournamentInfo[]>([]);
  const [tour, setTour] = useState<string>('atp');
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [matches, setMatches] = useState<UpcomingWithPrediction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ tour: string; id: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // null = every day. See the note in the other dashboards.
  const [day, setDay] = useState<string | null>(null);

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
      setError(`No se pudo actualizar: ${e}`);
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
      .catch((e) => setError(`No se pudo conectar con la API. ¿Corriste "npm run seed"? (${e})`));
  }, []);

  // Tournaments depend on the selected tour (only those with upcoming matches).
  useEffect(() => {
    api
      .tournaments(tour)
      .then((tt) => setTournaments(tt.tournaments))
      .catch((e) => setError(String(e)));
  }, [tour]);

  // Tournaments that actually have upcoming matches for the selected tour.
  const dayGroups = useMemo(
    () => groupByDay(matches, (m) => m.match.commence_time),
    [matches],
  );
  const dayChips = useMemo(
    () => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key), count: d.items.length })),
    [dayGroups],
  );
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;

  // Ranked markets, from the rows already fetched. Recomputed only when those
  // change: it is pure arithmetic over what is on screen, no extra request.
  const picks = useMemo(() => rankPicks(tennisPicks(matches)), [matches]);
  const [stake, setStake] = useStake();
  // Every price on screen invented by this app rather than fetched — see picks.ts.
  const demoOdds = matches.length > 0 && matches.every((r) => r.match.source === 'fixture');
  useEffect(() => {
    if (day && !dayGroups.some((d) => d.key === day)) setDay(null);
  }, [dayGroups, day]);

  const tourTournaments = useMemo(
    () => tournaments.filter((t) => t.tours.includes(tour) && t.hasUpcoming),
    [tournaments, tour],
  );

  // Keep a valid tournament selected when the tour changes.
  useEffect(() => {
    if (tourTournaments.length === 0) {
      setTournamentId(null);
    } else if (!tourTournaments.some((t) => t.id === tournamentId)) {
      setTournamentId(tourTournaments[0].id);
    }
  }, [tourTournaments, tournamentId]);

  // Load matches for tour + tournament.
  useEffect(() => {
    if (!tournamentId) {
      setMatches([]);
      return;
    }
    setLoading(true);
    api
      .upcoming(tour, tournamentId)
      .then((m) => setMatches(m))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [tour, tournamentId]);

  return (
    <div>
      <header className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-[15px] leading-relaxed text-[#9aa1ac]">
            Predicción de partidos con Elo por superficie, forma reciente, head-to-head y odds del
            mercado.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {meta && <DataBadge meta={meta} />}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Vuelve a consultar las odds de los partidos próximos"
              className="shrink-0 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[14px] font-medium text-[#d5d9df] ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-50"
            >
              {refreshing ? 'Actualizando…' : '↻ Actualizar'}
            </button>
          </div>
        </div>
        {meta && <RefreshInfo meta={meta} />}
        <StaleHistoryWarning
          info={staleness('tennis', meta?.historyThrough, meta?.dataSource === 'seed')}
          what="Los Elo por superficie"
          fix="npm run update-data"
        />
        <TrackRecordPanel tour={tour} />
      </header>

      {/* The ranked-markets panel. Built from the SAME rows the cards below
          render, so the two can never disagree about a number. */}
      <PicksPanel {...picks} caveat={CAVEATS.tennis} demoOdds={demoOdds} stake={stake} onStakeChange={setStake} />

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
              <span className="ml-1.5 opacity-60">{t.upcomingCount}</span>
            </button>
          ))}
        </div>
      ) : meta && meta.counts.matches === 0 ? (
        <div className="mb-6 rounded-lg border border-rose-800/60 bg-rose-950/40 p-4 text-[16px] text-rose-200">
          <p className="font-medium">La base de datos está vacía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data</code> para
            descargar el historial real, o{' '}
            <code className="rounded bg-rose-900/40 px-1">npm run seed</code> para ver la app con
            datos de ejemplo.
          </p>
        </div>
      ) : (
        <p className="mb-6 text-[16px] text-[#7b828d]">
          No hay próximos partidos para {tour.toUpperCase()}.
        </p>
      )}

      {/* Matches */}
      {loading ? (
        <p className="text-[#7b828d]">Cargando partidos…</p>
      ) : (
        <>
          <DayFilter days={dayChips} selected={day} onSelect={setDay} />
          {shownGroups.map((group) => (
            <section key={group.key} className="mb-6">
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

      {profile && (
        <PlayerProfile
          tour={profile.tour}
          id={profile.id}
          onClose={() => setProfile(null)}
        />
      )}
    </div>
  );
}

function RefreshInfo({ meta }: { meta: Meta }) {
  const when = meta.oddsRefreshedAt ?? meta.updatedAt ?? meta.seededAt;
  const whenTxt = when
    ? new Date(when).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
  return (
    <p className="mt-1 text-[14px] text-[#7b828d]">
      Odds actualizadas: {whenTxt}
      {meta.hasOddsKey
        ? meta.autoRefreshMinutes > 0
          ? ` · auto cada ${Math.round(meta.autoRefreshMinutes / 60)}h`
          : ''
        : ' · configura ODDS_API_KEY y corre npm run update-data para partidos reales'}
    </p>
  );
}

function DataBadge({ meta }: { meta: Meta }) {
  // An empty database must never read as "datos reales" — that's how a failed
  // ingest ends up looking like a working install with nothing in it.
  if (meta.counts.matches === 0) {
    return (
      <span
        className="rounded-full bg-rose-900/40 px-3 py-1 text-[14px] font-medium text-rose-300 ring-1 ring-rose-500/40"
        title="La base de datos está vacía. Ejecuta npm run update-data (o npm run seed)."
      >
        sin datos
      </span>
    );
  }
  const isSeed = meta.dataSource === 'seed';
  return (
    <span
      className={`rounded-full px-3 py-1 text-[14px] font-medium ring-1 ${
        isSeed
          ? 'bg-amber-900/40 text-amber-300 ring-amber-500/40'
          : 'bg-emerald-900/40 text-emerald-300 ring-emerald-500/40'
      }`}
      title={
        isSeed
          ? 'Datos de demostración (sintéticos). Ejecuta "npm run update-data" para datos reales.'
          : 'Datos históricos reales (Jeff Sackmann).'
      }
    >
      {isSeed ? 'datos demo' : 'datos reales'} · {meta.counts.matches} partidos
    </span>
  );
}

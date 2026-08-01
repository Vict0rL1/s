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
          <p className="max-w-prose text-[13px] leading-relaxed text-slate-400">
            Predicción de partidos con Elo por superficie, forma reciente, head-to-head y odds del
            mercado.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {meta && <DataBadge meta={meta} />}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Vuelve a consultar las odds de los partidos próximos"
              className="shrink-0 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-slate-200 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-50"
            >
              {refreshing ? 'Actualizando…' : '↻ Actualizar'}
            </button>
          </div>
        </div>
        {meta && <RefreshInfo meta={meta} />}
        {meta && <StaleHistoryWarning meta={meta} />}
        <TrackRecordPanel tour={tour} />
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* Tour selector */}
      <div className="mb-4 flex gap-2">
        {tours.map((t) => (
          <button
            key={t.id}
            onClick={() => setTour(t.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              tour === t.id
                ? 'bg-lime-500 text-slate-900'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
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
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                tournamentId === t.id
                  ? 'bg-sky-500 text-slate-900'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {t.name}
              <span className="ml-1.5 opacity-60">{t.upcomingCount}</span>
            </button>
          ))}
        </div>
      ) : meta && meta.counts.matches === 0 ? (
        <div className="mb-6 rounded-lg border border-rose-800/60 bg-rose-950/40 p-4 text-sm text-rose-200">
          <p className="font-medium">La base de datos está vacía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data</code> para
            descargar el historial real, o{' '}
            <code className="rounded bg-rose-900/40 px-1">npm run seed</code> para ver la app con
            datos de ejemplo.
          </p>
        </div>
      ) : (
        <p className="mb-6 text-sm text-slate-500">
          No hay próximos partidos para {tour.toUpperCase()}.
        </p>
      )}

      {/* Matches */}
      {loading ? (
        <p className="text-slate-500">Cargando partidos…</p>
      ) : (
        <div className="space-y-4">
          {matches.map((m) => (
            <MatchCard
              key={m.match.id}
              item={m}
              onOpenPlayer={(t, id) => setProfile({ tour: t, id })}
            />
          ))}
        </div>
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

/**
 * Elo is only as current as the match history behind it. If the newest match is
 * months old (e.g. the download fell back to an outdated mirror), say so plainly
 * instead of presenting stale ratings as if they were current.
 */
function StaleHistoryWarning({ meta }: { meta: Meta }) {
  if (meta.dataSource === 'seed' || !meta.historyThrough) return null;
  const y = Number(meta.historyThrough.slice(0, 4));
  const m = Number(meta.historyThrough.slice(4, 6));
  if (!y || !m) return null;
  const monthsOld = (new Date().getFullYear() - y) * 12 + (new Date().getMonth() + 1 - m);
  if (monthsOld <= 6) return null;
  const years = Math.round((monthsOld / 12) * 10) / 10;
  return (
    <div className="mt-3 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">
      ⚠️ El historial de partidos termina en {m}/{y} (~{years} años). Los Elo no reflejan a los
      jugadores actuales, así que estas predicciones son poco fiables. Vuelve a ejecutar{' '}
      <code className="rounded bg-amber-900/40 px-1">npm run update-data</code> desde una red que no
      bloquee GitHub para obtener datos al día.
    </div>
  );
}

function RefreshInfo({ meta }: { meta: Meta }) {
  const when = meta.oddsRefreshedAt ?? meta.updatedAt ?? meta.seededAt;
  const whenTxt = when
    ? new Date(when).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
  return (
    <p className="mt-1 text-xs text-slate-500">
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
        className="rounded-full bg-rose-900/40 px-3 py-1 text-xs font-medium text-rose-300 ring-1 ring-rose-500/40"
        title="La base de datos está vacía. Ejecuta npm run update-data (o npm run seed)."
      >
        sin datos
      </span>
    );
  }
  const isSeed = meta.dataSource === 'seed';
  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${
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

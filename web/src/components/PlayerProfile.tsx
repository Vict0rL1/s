import { useEffect, useState } from 'react';
import { api, type Profile } from '../lib/api';
import { flag, formatDate, surfaceLabelEs, surfaceColor } from '../lib/format';

/** Slide-over panel showing a player's Elo (overall + per surface) and recent results. */
export default function PlayerProfile({
  tour,
  id,
  onClose,
}: {
  tour: string;
  id: number;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProfile(null);
    setError(null);
    api
      .profile(tour, id)
      .then(setProfile)
      .catch((e) => setError(String(e)));
  }, [tour, id]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-slate-700 bg-slate-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-xl font-bold">
            {profile ? `${flag(profile.country)} ${profile.name}` : 'Cargando…'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            ✕
          </button>
        </div>

        {error && <p className="text-rose-400">{error}</p>}

        {profile && (
          <>
            <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Ratings Elo</div>
            <div className="mb-6 grid grid-cols-2 gap-3">
              <EloTile label="General" value={profile.rating.overall} color="#e2e8f0" big />
              <EloTile
                label={`Partidos`}
                value={profile.rating.matches_played}
                color="#94a3b8"
                big
                integer
              />
              <EloTile label="Dura" value={profile.rating.hard} color={surfaceColor('hard')} />
              <EloTile label="Arcilla" value={profile.rating.clay} color={surfaceColor('clay')} />
              <EloTile label="Hierba" value={profile.rating.grass} color={surfaceColor('grass')} />
            </div>

            <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
              Últimos resultados
            </div>
            <ul className="space-y-1">
              {profile.recent.map((m, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded bg-slate-800/50 px-3 py-2 text-sm"
                >
                  <span
                    className={`w-6 font-bold ${m.won ? 'text-lime-400' : 'text-rose-400'}`}
                  >
                    {m.won ? 'V' : 'D'}
                  </span>
                  <span className="flex-1 truncate px-2 text-slate-300">
                    vs {m.opponent_name ?? `#${m.opponent_id}`}
                  </span>
                  <span className="text-xs text-slate-500">
                    {surfaceLabelEs(m.surface)} · {formatDate(m.date)}
                  </span>
                </li>
              ))}
              {profile.recent.length === 0 && (
                <li className="text-slate-500">Sin resultados registrados.</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function EloTile({
  label,
  value,
  color,
  big = false,
  integer = false,
}: {
  label: string;
  value: number;
  color: string;
  big?: boolean;
  integer?: boolean;
}) {
  return (
    <div className={`rounded-lg bg-slate-800/60 p-3 ${big ? 'col-span-1' : ''}`}>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-bold tabular-nums" style={{ color }}>
        {integer ? value : Math.round(value)}
      </div>
    </div>
  );
}

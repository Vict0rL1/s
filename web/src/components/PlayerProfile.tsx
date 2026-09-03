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
        className="h-full w-full max-w-md overflow-y-auto border-l border-white/[0.07] bg-[#14161b] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-[20px] font-bold">
              {profile ? `${flag(profile.country)} ${profile.name}` : 'Cargando…'}
            </h2>
            {profile && (
              <div className="text-[14px] text-[#9aa1ac]">
                {profile.ranking && (
                  <>
                    <span className="text-[#d5d9df]">#{profile.ranking.rank} oficial</span>
                    {profile.ranking.points != null && ` (${profile.ranking.points.toLocaleString('es')} pts)`}
                    {' · '}
                  </>
                )}
                #{profile.eloRank} por Elo · {profile.rating.matches_played} partidos
                {profile.age != null && ` · ${profile.age} años`}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-[#9aa1ac] hover:text-[#d5d9df]">
            ✕
          </button>
        </div>

        {error && <p className="text-rose-400">{error}</p>}

        {profile && (
          <>
            <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">Ratings Elo</div>
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

            {profile.serve.matches > 0 && (
              <>
                <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">
                  Saque y quiebre (promedio)
                </div>
                <div className="mb-6 grid grid-cols-2 gap-2 text-[16px]">
                  <ServeStat label="Aces/partido" value={profile.serve.acesPerMatch} />
                  <ServeStat label="Ace %" value={profile.serve.acePct} suffix="%" />
                  <ServeStat label="1er saque dentro" value={profile.serve.firstInPct} suffix="%" />
                  <ServeStat label="1er saque ganado" value={profile.serve.firstWonPct} suffix="%" />
                  <ServeStat label="2do saque ganado" value={profile.serve.secondWonPct} suffix="%" />
                  <ServeStat label="BP salvados" value={profile.serve.bpSavedPct} suffix="%" />
                </div>
              </>
            )}

            <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">
              Últimos resultados
            </div>
            <ul className="space-y-1">
              {profile.recent.map((m, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded bg-white/[0.04] px-3 py-2 text-[16px]"
                >
                  <span
                    className={`w-6 font-bold ${m.won ? 'text-emerald-400' : 'text-rose-400'}`}
                  >
                    {m.won ? 'V' : 'D'}
                  </span>
                  <span className="flex-1 truncate px-2 text-[#c3c9d1]">
                    vs {m.opponent_name ?? `#${m.opponent_id}`}
                  </span>
                  <span className="text-[14px] text-[#7b828d]">
                    {surfaceLabelEs(m.surface)} · {formatDate(m.date)}
                  </span>
                </li>
              ))}
              {profile.recent.length === 0 && (
                <li className="text-[#7b828d]">Sin resultados registrados.</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function ServeStat({
  label,
  value,
  suffix = '',
}: {
  label: string;
  value: number | null;
  suffix?: string;
}) {
  return (
    <div className="flex items-baseline justify-between rounded bg-white/[0.04] px-3 py-1.5">
      <span className="text-[14px] text-[#9aa1ac]">{label}</span>
      <span className="font-semibold tabular-nums text-[#d5d9df]">
        {value == null ? '—' : `${value}${suffix}`}
      </span>
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
    <div className={`rounded-lg bg-white/[0.04] p-3 ${big ? 'col-span-1' : ''}`}>
      <div className="text-[14px] text-[#9aa1ac]">{label}</div>
      <div className="text-[20px] font-bold tabular-nums" style={{ color }}>
        {integer ? value : Math.round(value)}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { bbApi, type BbTeamInfo } from '../../lib/basketball';
import { formatDate } from '../../lib/format';
import { TeamCrest } from '../ui';

/** Full dossier for one team, opened from any game card or the power ranking. */
export default function TeamProfile({
  league,
  id,
  onClose,
}: {
  league: string;
  id: string;
  onClose: () => void;
}) {
  const [team, setTeam] = useState<BbTeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTeam(null);
    setError(null);
    bbApi
      .team(league, id)
      .then((t) => alive && setTeam(t))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [league, id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="mt-8 w-full max-w-lg rounded-xl border border-white/[0.07] bg-[#14161b] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {/* The crest is always there; a real badge layers on top when the
                ingest managed to fetch one, and disappears silently if it 404s. */}
            <TeamCrest league={league} name={team?.name ?? id} code={id} logo={team?.logo} size={42} />
            <div>
              <h2 className="text-lg font-bold text-[#e8eaed]">{team?.name ?? id}</h2>
              {team && (
                <p className="text-xs text-[#9aa1ac]">
                  Elo {Math.round(team.elo)} · #{team.eloRank} de la liga · {team.gamesInDb}{' '}
                  partidos en el historial
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-[#9aa1ac] hover:text-[#d5d9df]">
            ✕
          </button>
        </div>

        {error && <p className="text-sm text-rose-300">{error}</p>}
        {!team && !error && <p className="text-sm text-[#7b828d]">Cargando…</p>}

        {team && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Balance" value={`${team.record.wins}–${team.record.losses}`} />
              <Stat label="En casa" value={`${team.homeRecord.wins}–${team.homeRecord.losses}`} />
              <Stat label="Fuera" value={`${team.awayRecord.wins}–${team.awayRecord.losses}`} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Anota" value={team.ppg != null ? String(team.ppg) : '—'} hint="por partido" />
              <Stat label="Recibe" value={team.papg != null ? String(team.papg) : '—'} hint="por partido" />
              <Stat
                label="Diferencial"
                value={
                  team.ppg != null && team.papg != null
                    ? `${team.ppg - team.papg > 0 ? '+' : ''}${(team.ppg - team.papg).toFixed(1)}`
                    : '—'
                }
                hint="anota − recibe"
              />
            </div>

            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-[#7b828d]">
                Últimos partidos
              </div>
              {team.form.length === 0 ? (
                <p className="text-[#7b828d]">Sin partidos registrados.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {team.form.map((g, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className={g.won ? 'text-emerald-400' : 'text-rose-400'}>
                        {g.won ? 'V' : 'D'}
                      </span>
                      <span className="flex-1 truncate text-[#c3c9d1]">
                        {g.home ? 'vs' : '@'} {g.opponentName ?? g.opponentId}
                      </span>
                      <span className="tabular-nums text-[#9aa1ac]">
                        {g.pts}–{g.oppPts}
                      </span>
                      <span className="w-20 text-right text-[#5c636c]">{formatDate(g.date)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="text-[11px] leading-relaxed text-[#7b828d]">
              El Elo resume el nivel del equipo a partir de resultados, margen de puntos y
              calendario. No conoce lesiones, traspasos de última hora ni rotaciones.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[#7b828d]">{label}</div>
      <div className="tabular-nums text-[#e8eaed]">{value}</div>
      {hint && <div className="text-[10px] text-[#5c636c]">{hint}</div>}
    </div>
  );
}

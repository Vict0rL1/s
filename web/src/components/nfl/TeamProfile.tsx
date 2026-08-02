import { useEffect, useState } from 'react';
import { nflApi, type NflTeamInfo } from '../../lib/nfl';
import { AWAY_COLOR, HOME_COLOR, NEUTRAL_COLOR, pct } from '../../lib/theme';
import { FormDots } from '../ui';

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
  const [team, setTeam] = useState<NflTeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTeam(null);
    setError(null);
    nflApi
      .team(league, id)
      .then((t) => alive && setTeam(t))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [league, id]);

  const rec = (r: { wins: number; losses: number; ties: number } | undefined) =>
    r ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}` : '—';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="mt-8 w-full max-w-lg rounded-xl border border-white/[0.07] bg-[#14161b] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-[#e8eaed]">{team?.name ?? id}</h2>
            {team && (
              <p className="text-xs text-[#9aa1ac]">
                Elo {Math.round(team.elo)} · #{team.eloRank} de la liga · {team.gamesInDb} partidos
                en el historial
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-[#9aa1ac] hover:text-[#d5d9df]">
            ✕
          </button>
        </div>

        {error && <p className="text-sm text-rose-300">{error}</p>}
        {!team && !error && <p className="text-sm text-[#7b828d]">Cargando ficha…</p>}

        {team && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-3 gap-x-4 gap-y-3 border-y border-white/[0.07] py-3 text-xs">
              <Stat label="Balance" value={rec(team.record)} />
              <Stat label="En casa" value={rec(team.homeRecord)} />
              <Stat label="Fuera" value={rec(team.awayRecord)} />
              <Stat label="Puntos a favor" value={team.pf != null ? `${team.pf}/partido` : '—'} />
              <Stat label="Puntos en contra" value={team.pa != null ? `${team.pa}/partido` : '—'} />
              <Stat
                label="Pitagórico"
                value={team.pythagorean != null ? pct(team.pythagorean) : '—'}
              />
            </div>

            {/*
              The gap between the real record and the pythagorean is the standard
              read on how much of a season was luck. Spelled out rather than left
              as two numbers side by side, because the comparison is the point.
            */}
            {team.pythagorean != null && team.record.wins + team.record.losses > 0 && (
              <p className="text-[11px] leading-relaxed text-[#7b828d]">
                Los puntos anotados y encajados sugieren un {pct(team.pythagorean)} de victorias; el
                balance real es {pct(team.record.wins / (team.record.wins + team.record.losses))}.
                La diferencia entre ambos es lo que se suele leer como suerte.
              </p>
            )}

            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7b828d]">
                  Últimos partidos
                </h3>
                <FormDots
                  results={team.form.slice(0, 5).map((f) => f.result)}
                  colors={{ W: HOME_COLOR, D: NEUTRAL_COLOR, L: AWAY_COLOR }}
                />
              </div>
              <ul className="space-y-1 text-xs">
                {team.form.map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span className="w-12 shrink-0 text-[#7b828d]">
                      {f.season} s{f.week}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[#c3c9d1]">
                      {f.home ? 'vs' : '@'} {f.opponentName ?? f.opponentId}
                    </span>
                    <span className="shrink-0 tabular-nums text-[#d5d9df]">
                      {f.pointsFor}–{f.pointsAgainst}
                    </span>
                    <span
                      className="w-4 shrink-0 text-right font-bold"
                      style={{
                        color:
                          f.result === 'W' ? HOME_COLOR : f.result === 'L' ? AWAY_COLOR : NEUTRAL_COLOR,
                      }}
                    >
                      {f.result}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[#7b828d]">{label}</div>
      <div className="tabular-nums text-[#e8eaed]">{value}</div>
    </div>
  );
}

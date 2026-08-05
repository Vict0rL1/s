import { useEffect, useState } from 'react';
import { fbApi, type FbAvailability, type FbSquad, type FbSquadPlayer } from '../../lib/football';

/**
 * Who is playing — the one input the user has and the model does not.
 *
 * Every team-level signal that was tried as a substitute for this (a learned
 * attack/defence profile, recent form, fixture congestion) turned out to be
 * already contained in the Elo. Lineups are not: teamsheets move goals by a
 * measurable amount, and they are published about an hour before kickoff, which
 * is exactly when someone would be looking at this page.
 *
 * So the panel is an input, not a readout. Injuries and suspensions the feed
 * already knows about arrive ticked; anything else, the user ticks, and the whole
 * score distribution above is rebuilt on the server from the new lineup.
 */
export default function SquadPanel({
  league,
  side,
  teamId,
  teamName,
  color,
  availability,
  out,
  onChange,
}: {
  league: string;
  side: 'home' | 'away';
  teamId: string;
  teamName: string;
  color: string;
  availability: FbAvailability | null;
  out: string[];
  onChange: (ids: string[]) => void;
}) {
  const [squad, setSquad] = useState<FbSquad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    fbApi
      .squad(league, teamId)
      .then((s) => live && setSquad(s))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [league, teamId]);

  if (error) {
    return (
      <p className="text-[13px] text-[#7b828d]">
        Sin datos de plantilla para {teamName}.
      </p>
    );
  }
  if (!squad) return <p className="text-[13px] text-[#7b828d]">Cargando plantilla…</p>;

  const xi = squad.players.filter((p) => p.regular);
  const bench = squad.players.filter((p) => !p.regular && p.minutes > 0);
  const rest = showAll ? bench.slice(0, 12) : [];

  const toggle = (id: string) => {
    onChange(out.includes(id) ? out.filter((x) => x !== id) : [...out, id]);
  };

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="truncate text-[14px] font-semibold" style={{ color }} title={teamName}>
          {teamName}
        </span>
        {availability && <Effect availability={availability} />}
      </div>

      <ul className="space-y-0.5">
        {xi.map((p) => (
          <PlayerRow
            key={p.id}
            player={p}
            marked={out.includes(p.id)}
            onToggle={() => toggle(p.id)}
          />
        ))}
      </ul>

      {rest.length > 0 && (
        <>
          <div className="mt-1.5 text-[11px] uppercase tracking-wide text-[#5c636c]">
            Resto de la plantilla
          </div>
          <ul className="space-y-0.5 opacity-70">
            {rest.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                marked={out.includes(p.id)}
                onToggle={() => toggle(p.id)}
              />
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-[#5c636c]">
            Marcar a un suplente no cambia el pronóstico: el modelo solo cuenta las bajas del once
            habitual.
          </p>
        </>
      )}

      {bench.length > 0 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="mt-1 text-[13px] text-[#9aa1ac] hover:text-[#e8eaed]"
        >
          {showAll ? '▲ Solo el once' : `▼ Ver plantilla completa (${bench.length})`}
        </button>
      )}
      <p className="sr-only">Bajas marcadas para el equipo {side === 'home' ? 'local' : 'visitante'}</p>
    </div>
  );
}

function PlayerRow({
  player, marked, onToggle,
}: {
  player: FbSquadPlayer;
  marked: boolean;
  onToggle: () => void;
}) {
  const isOut = marked || player.flaggedOut;
  return (
    <li>
      <label
        className={`flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[13px] transition hover:bg-white/[0.06] ${
          isOut ? 'text-rose-300' : 'text-[#c3c9d1]'
        }`}
        title={player.flagReason ?? undefined}
      >
        <input
          type="checkbox"
          checked={isOut}
          onChange={onToggle}
          className="h-3 w-3 shrink-0 accent-rose-500"
          aria-label={`${player.name} no juega`}
        />
        <span className="w-7 shrink-0 text-[11px] uppercase text-[#7b828d]">{player.position}</span>
        <span className={`min-w-0 flex-1 truncate ${isOut ? 'line-through' : ''}`}>
          {player.name}
        </span>
        {player.flaggedOut && <span title={player.flagReason ?? 'baja'}>⛔</span>}
        {player.regular && player.attackShare > 0.005 && (
          <span
            className="shrink-0 tabular-nums text-[#7b828d]"
            title="Parte del ataque del once que aporta este jugador"
          >
            {(player.attackShare * 100).toFixed(0)}%
          </span>
        )}
      </label>
    </li>
  );
}

function Effect({ availability }: { availability: FbAvailability }) {
  if (availability.out.length === 0) {
    return <span className="shrink-0 text-[11px] text-[#7b828d]">sin bajas</span>;
  }
  const attack = Math.round((1 - availability.attack) * 100);
  const defence = Math.round((availability.defence - 1) * 100);
  return (
    <span
      className="shrink-0 whitespace-nowrap text-[11px] text-rose-300"
      title={`Goles esperados a favor ×${availability.attack.toFixed(3)}, en contra ×${availability.defence.toFixed(3)}`}
    >
      −{attack}% ataque · +{defence}% encajados
    </span>
  );
}

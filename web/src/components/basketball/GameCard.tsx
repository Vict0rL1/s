import { useState } from 'react';
import type { BbGameWithPrediction, BbReliability, BbTeamSide } from '../../lib/basketball';
import { formatDateTime } from '../../lib/format';
import GameDetail from './GameDetail';

/** Away colour and home colour, reused across the basketball views. */
export const HOME_COLOR = '#a3e635'; // lime — the home side
export const AWAY_COLOR = '#38bdf8'; // sky — the away side

export default function GameCard({
  item,
  onOpenTeam,
}: {
  item: BbGameWithPrediction;
  onOpenTeam: (league: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { game, prediction, marketOnly, teams } = item;

  const probHome = prediction?.model.probHome ?? marketOnly?.implied1 ?? null;
  const probAway = prediction?.model.probAway ?? marketOnly?.implied2 ?? null;
  const fromModel = !!prediction;
  const value = prediction?.market.verdict;
  const valueTeam =
    value === 'value_p1'
      ? prediction?.teams.home.name
      : value === 'value_p2'
        ? prediction?.teams.away.name
        : null;

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
        <span>{formatDateTime(game.commence_time)}</span>
        <span className="flex items-center gap-2">
          {prediction?.neutral && (
            <span className="rounded bg-slate-700/60 px-2 py-0.5">cancha neutral</span>
          )}
          {game.source === 'fixture' && (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-amber-300">
              partido demo
            </span>
          )}
        </span>
      </div>

      {/* Away @ Home — the order North American basketball is always written in */}
      <div className="mb-4 flex items-start justify-between gap-2">
        <TeamName
          name={prediction?.teams.away.name ?? game.away_name}
          color={AWAY_COLOR}
          odds={game.away_odds}
          prob={probAway}
          fromModel={fromModel}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          record={prediction?.teams.away.record ?? teams.away?.record ?? null}
          onClick={game.away_id ? () => onOpenTeam(game.league, game.away_id!) : undefined}
        />
        <span className="px-2 pt-6 text-xs text-slate-500">@</span>
        <TeamName
          name={prediction?.teams.home.name ?? game.home_name}
          color={HOME_COLOR}
          odds={game.home_odds}
          prob={probHome}
          fromModel={fromModel}
          elo={prediction?.teams.home.elo ?? teams.home?.elo ?? null}
          eloRank={prediction?.teams.home.eloRank ?? teams.home?.eloRank ?? null}
          record={prediction?.teams.home.record ?? teams.home?.record ?? null}
          alignRight
          homeBadge
          onClick={game.home_id ? () => onOpenTeam(game.league, game.home_id!) : undefined}
        />
      </div>

      {prediction ? (
        <>
          <Bars prediction={prediction} />

          {/* The three numbers a basketball bettor looks at */}
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Figure
              label="Ganador"
              value={`${(Math.max(prediction.model.probHome, prediction.model.probAway) * 100).toFixed(1)}%`}
              hint={prediction.verdict.favoredName ?? '—'}
            />
            <Figure
              label="Diferencia"
              value={prediction.projection.spreadLabel}
              hint="margen esperado"
            />
            <Figure
              label="Total"
              value={prediction.projection.total != null ? String(Math.round(prediction.projection.total)) : '—'}
              hint="puntos en total"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              {prediction.verdict.favored ? (
                <span>
                  El modelo favorece a{' '}
                  <strong
                    style={{
                      color: prediction.verdict.favored === 'home' ? HOME_COLOR : AWAY_COLOR,
                    }}
                  >
                    {prediction.verdict.favoredName}
                  </strong>{' '}
                  <span className="text-slate-400">({prediction.verdict.marginPct} pp)</span>
                </span>
              ) : (
                <span className="text-slate-400">Partido muy parejo</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <ReliabilityBadge reliability={prediction.reliability} />
              {valueTeam && (
                <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/40">
                  Posible value: {valueTeam}
                </span>
              )}
            </div>
          </div>

          <div className="mt-3 rounded-lg bg-slate-900/60 p-3 ring-1 ring-slate-700/50">
            <div className="mb-1.5 text-xs uppercase tracking-wide text-slate-500">
              Qué es lo más probable
            </div>
            <p className="text-sm font-medium text-slate-100">{prediction.summary.headline}</p>
            <ul className="mt-2 space-y-1">
              {prediction.summary.bullets.map((b, i) => (
                <li key={i} className="flex gap-2 text-xs text-slate-300">
                  <span className="text-slate-600">•</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>

          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-3 text-xs text-sky-400 hover:text-sky-300"
          >
            {open ? '▲ Ocultar desglose' : '▼ Ver desglose (Elo · campo · descanso · mercado)'}
          </button>
          {open && <GameDetail prediction={prediction} />}
        </>
      ) : (
        <MissingModel item={item} />
      )}
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg bg-slate-900/50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="truncate text-sm font-semibold tabular-nums text-slate-100" title={value}>
        {value}
      </div>
      <div className="truncate text-[10px] text-slate-500">{hint}</div>
    </div>
  );
}

function Bars({ prediction }: { prediction: NonNullable<BbGameWithPrediction['prediction']> }) {
  const m = prediction.market.market;
  return (
    <div className="space-y-2">
      <Bar
        label="Modelo"
        left={prediction.model.probAway}
        right={prediction.model.probHome}
      />
      {m && <Bar label="Mercado (odds sin vig)" left={m.implied2} right={m.implied1} />}
    </div>
  );
}

function Bar({ label, left, right }: { label: string; left: number; right: number }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="flex h-5 overflow-hidden rounded">
        <div
          className="flex items-center justify-start px-2 text-[10px] font-semibold text-slate-900"
          style={{ width: `${left * 100}%`, backgroundColor: AWAY_COLOR }}
        >
          {(left * 100).toFixed(1)}%
        </div>
        <div
          className="flex items-center justify-end px-2 text-[10px] font-semibold text-slate-900"
          style={{ width: `${right * 100}%`, backgroundColor: HOME_COLOR }}
        >
          {(right * 100).toFixed(1)}%
        </div>
      </div>
    </div>
  );
}

function TeamName({
  name,
  color,
  odds,
  prob,
  fromModel,
  elo,
  eloRank,
  record,
  alignRight = false,
  homeBadge = false,
  onClick,
}: {
  name: string;
  color: string;
  odds: number | null;
  prob: number | null;
  fromModel: boolean;
  elo: number | null;
  eloRank: number | null;
  record: { wins: number; losses: number } | null;
  alignRight?: boolean;
  homeBadge?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <button
        onClick={onClick}
        disabled={!onClick}
        className={`max-w-full truncate text-sm font-semibold ${
          onClick ? 'hover:underline' : 'cursor-default'
        }`}
        style={{ color }}
        title={onClick ? 'Ver ficha del equipo' : undefined}
      >
        {name}
        {homeBadge && <span className="ml-1.5 text-[10px] text-slate-500">(local)</span>}
      </button>
      <div className="text-3xl font-bold tabular-nums" style={{ color }}>
        {prob != null ? (prob * 100).toFixed(1) : '—'}
        <span className="text-base">%</span>
      </div>
      <div className="text-[11px] text-slate-500">
        {!fromModel && prob != null && <span className="text-amber-400">solo mercado · </span>}
        {elo != null && <>Elo {Math.round(elo)}{eloRank != null && ` (#${eloRank})`}</>}
        {record && <> · {record.wins}–{record.losses}</>}
      </div>
      {odds != null && <div className="text-[11px] text-slate-500">cuota {odds}</div>}
    </div>
  );
}

/**
 * How much data is behind this probability, shown where it changes the reading:
 * "62% (fiabilidad baja, ±11 pp)" is a very different claim from "62% (alta, ±3)".
 */
function ReliabilityBadge({ reliability }: { reliability: BbReliability }) {
  const styles: Record<BbReliability['level'], string> = {
    high: 'bg-emerald-900/40 text-emerald-300 ring-emerald-500/40',
    medium: 'bg-amber-900/40 text-amber-300 ring-amber-500/40',
    low: 'bg-rose-900/40 text-rose-300 ring-rose-500/40',
  };
  const title = [
    `Margen de incertidumbre: ±${reliability.marginPp} puntos porcentuales.`,
    `Partidos tras cada Elo: ${reliability.gamesBehind.home} (local) y ${reliability.gamesBehind.away} (visitante).`,
    ...reliability.reasons,
  ].join('\n');
  return (
    <span
      title={title}
      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${styles[reliability.level]}`}
    >
      {reliability.label} · ±{reliability.marginPp} pp
    </span>
  );
}

/**
 * A prediction needs both teams in the history. Naming what is missing points at
 * the cause — usually a league with no results feed, or a team the odds provider
 * spells differently — instead of a vague "no prediction".
 */
function MissingModel({ item }: { item: BbGameWithPrediction }) {
  const { game, marketOnly } = item;
  const missing = [
    !game.home_id ? game.home_name : null,
    !game.away_id ? game.away_name : null,
  ].filter(Boolean) as string[];
  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
      <p className="font-medium">Sin modelo para este partido.</p>
      {missing.length > 0 ? (
        <p className="mt-1">
          No encuentro en el historial a: <strong>{missing.join(', ')}</strong>. Suele pasar en ligas
          sin fuente de resultados (EuroLeague, NBL) o cuando la casa escribe el nombre de otra
          forma.
        </p>
      ) : (
        <p className="mt-1">Faltan datos históricos de esta liga.</p>
      )}
      {marketOnly && (
        <p className="mt-2 text-amber-100">
          Probabilidad implícita del mercado (sin vig):{' '}
          <strong>{(marketOnly.implied2 * 100).toFixed(1)}%</strong> {game.away_name} ·{' '}
          <strong>{(marketOnly.implied1 * 100).toFixed(1)}%</strong> {game.home_name}
        </p>
      )}
    </div>
  );
}

export type { BbTeamSide };

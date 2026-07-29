import { useState } from 'react';
import type { UpcomingWithPrediction } from '../lib/api';
import { confidenceLabelEs, flag, formatDateTime, surfaceLabelEs } from '../lib/format';
import ProbabilityBars, { P1_COLOR, P2_COLOR } from './ProbabilityBars';
import MatchDetail from './MatchDetail';

export default function MatchCard({
  item,
  onOpenPlayer,
}: {
  item: UpcomingWithPrediction;
  onOpenPlayer: (tour: string, id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const { match, prediction } = item;

  const verdict = prediction?.verdict;
  const value = prediction?.market.verdict;
  const valuePlayer =
    value === 'value_p1' ? match.p1_name : value === 'value_p2' ? match.p2_name : null;

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
        <span>{formatDateTime(match.commence_time)}</span>
        <span className="flex items-center gap-2">
          <span className="rounded bg-slate-700/60 px-2 py-0.5">
            {surfaceLabelEs(match.surface)}
          </span>
          {match.source === 'fixture' && (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-amber-300">odds demo</span>
          )}
        </span>
      </div>

      {/* Players */}
      <div className="mb-3 flex items-center justify-between">
        <PlayerName
          name={match.p1_name}
          country={prediction?.players.p1.country ?? null}
          color={P1_COLOR}
          odds={match.p1_odds}
          onClick={match.p1_id ? () => onOpenPlayer(match.tour, match.p1_id!) : undefined}
        />
        <span className="px-3 text-xs text-slate-500">vs</span>
        <PlayerName
          name={match.p2_name}
          country={prediction?.players.p2.country ?? null}
          color={P2_COLOR}
          odds={match.p2_odds}
          alignRight
          onClick={match.p2_id ? () => onOpenPlayer(match.tour, match.p2_id!) : undefined}
        />
      </div>

      {prediction ? (
        <>
          <ProbabilityBars prediction={prediction} />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              {verdict && verdict.favoredSide ? (
                <span>
                  El modelo favorece a{' '}
                  <strong style={{ color: verdict.favoredSide === 1 ? P1_COLOR : P2_COLOR }}>
                    {verdict.favoredName}
                  </strong>{' '}
                  <span className="text-slate-400">
                    · {confidenceLabelEs(verdict.confidence)} ({verdict.marginPct} pp)
                  </span>
                </span>
              ) : (
                <span className="text-slate-400">Partido muy parejo</span>
              )}
            </div>
            {valuePlayer && (
              <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/40">
                Posible value: {valuePlayer}
              </span>
            )}
          </div>

          {/* What the model expects to happen, in plain language */}
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
            {open ? '▲ Ocultar desglose' : '▼ Ver desglose (Elo · forma · H2H · mercado)'}
          </button>
          {open && <MatchDetail prediction={prediction} />}
        </>
      ) : (
        <div className="text-sm text-slate-500">
          No hay datos históricos suficientes para predecir este partido (jugador no reconocido).
        </div>
      )}
    </div>
  );
}

function PlayerName({
  name,
  country,
  color,
  odds,
  alignRight = false,
  onClick,
}: {
  name: string;
  country: string | null;
  color: string;
  odds: number | null;
  alignRight?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className={`flex-1 ${alignRight ? 'text-right' : 'text-left'}`}>
      <button
        onClick={onClick}
        disabled={!onClick}
        className={`font-semibold ${onClick ? 'hover:underline' : 'cursor-default'}`}
        style={{ color }}
      >
        {flag(country)} {name}
      </button>
      <div className="text-xs text-slate-500">{odds != null ? `cuota ${odds}` : 'sin cuota'}</div>
    </div>
  );
}

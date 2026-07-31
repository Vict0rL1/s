import { useState } from 'react';
import type { PlayerInfo, Reliability, UpcomingMatch, UpcomingWithPrediction } from '../lib/api';
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
  const { match, prediction, marketOnly, players } = item;

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

      {/* Players + headline win probabilities */}
      <div className="mb-4 flex items-start justify-between">
        <PlayerName
          name={match.p1_name}
          country={prediction?.players.p1.country ?? players?.p1?.country ?? null}
          color={P1_COLOR}
          odds={match.p1_odds}
          prob={prediction?.model.prob1 ?? marketOnly?.implied1 ?? null}
          probSource={prediction ? 'model' : 'market'}
          info={players?.p1 ?? null}
          tourLabel={match.tour.toUpperCase()}
          onClick={match.p1_id ? () => onOpenPlayer(match.tour, match.p1_id!) : undefined}
        />
        <span className="px-3 pt-6 text-xs text-slate-500">vs</span>
        <PlayerName
          name={match.p2_name}
          country={prediction?.players.p2.country ?? players?.p2?.country ?? null}
          color={P2_COLOR}
          odds={match.p2_odds}
          prob={prediction?.model.prob2 ?? marketOnly?.implied2 ?? null}
          probSource={prediction ? 'model' : 'market'}
          info={players?.p2 ?? null}
          tourLabel={match.tour.toUpperCase()}
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
            <div className="flex items-center gap-2">
              <ReliabilityBadge reliability={prediction.reliability} />
              {valuePlayer && (
                <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/40">
                  Posible value: {valuePlayer}
                </span>
              )}
            </div>
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
        <MissingPlayers match={match} players={players} />
      )}
    </div>
  );
}

/**
 * How much data is behind this probability. Shown next to the verdict because
 * that is where it changes the reading: "62% (fiabilidad baja, ±9 pp)" is a very
 * different statement from "62% (fiabilidad alta, ±2 pp)", and without it both
 * look like the same confident call.
 */
function ReliabilityBadge({ reliability }: { reliability: Reliability }) {
  const styles: Record<Reliability['level'], string> = {
    high: 'bg-emerald-900/40 text-emerald-300 ring-emerald-500/40',
    medium: 'bg-amber-900/40 text-amber-300 ring-amber-500/40',
    low: 'bg-rose-900/40 text-rose-300 ring-rose-500/40',
  };
  const title = [
    `Margen de incertidumbre: ±${reliability.marginPp} puntos porcentuales.`,
    `Partidos efectivos tras cada Elo: ${reliability.effectiveMatches.p1} y ${reliability.effectiveMatches.p2}.`,
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
 * A prediction needs history for BOTH players. Name whoever is missing — that
 * points straight at the cause (usually an out-of-date match history that
 * predates the player's career) instead of a vague "not recognised".
 */
function MissingPlayers({
  match,
  players,
}: {
  match: UpcomingMatch;
  players?: { p1: PlayerInfo | null; p2: PlayerInfo | null };
}) {
  // Distinguish "we know nothing about this player" from "we know who they are
  // (rank, country…) but have too few of their matches to rate them" — the fix
  // differs, and the second case is not a data-loading failure.
  const sides = [
    { name: match.p1_name, id: match.p1_id, info: players?.p1 ?? null },
    { name: match.p2_name, id: match.p2_id, info: players?.p2 ?? null },
  ];
  const unknown = sides.filter((s) => !s.info).map((s) => s.name);
  const knownButUnrated = sides
    .filter((s) => s.info && s.info.matchesInDb === 0)
    .map((s) => `${s.name}${s.info!.ranking ? ` (#${s.info!.ranking.rank})` : ''}`);

  return (
    <div className="rounded-lg bg-slate-900/60 p-3 text-sm text-slate-400 ring-1 ring-slate-700/50">
      {unknown.length > 0 && (
        <>
          Sin predicción del modelo: no hay datos de{' '}
          <strong className="text-slate-200">{unknown.join(' ni de ')}</strong>.
          <div className="mt-1 text-xs text-slate-500">
            Suele pasar si el historial descargado es antiguo y no cubre la carrera de este jugador.
            Ejecuta{' '}
            <code className="rounded bg-slate-800 px-1">npm run update-data -- --fresh</code> para
            volver a descargarlo.
          </div>
        </>
      )}
      {unknown.length === 0 && knownButUnrated.length > 0 && (
        <>
          Sin predicción del modelo: aún no hay partidos de{' '}
          <strong className="text-slate-200">{knownButUnrated.join(' ni de ')}</strong> en el
          historial, así que no se puede calcular su Elo.
          <div className="mt-1 text-xs text-slate-500">
            Arriba tienes su ranking oficial y la probabilidad del mercado.
          </div>
        </>
      )}
      {unknown.length === 0 && knownButUnrated.length === 0 && (
        <>Sin predicción del modelo para este partido.</>
      )}
    </div>
  );
}

function PlayerName({
  name,
  country,
  color,
  odds,
  prob,
  probSource = 'model',
  info,
  tourLabel,
  alignRight = false,
  onClick,
}: {
  name: string;
  country: string | null;
  color: string;
  odds: number | null;
  prob: number | null;
  probSource?: 'model' | 'market';
  info?: PlayerInfo | null;
  tourLabel: string;
  alignRight?: boolean;
  onClick?: () => void;
}) {
  // Official ranking / age / hand — real facts about the player, independent of
  // whether the match history is complete enough to rate them.
  const facts = [
    info?.ranking ? `#${info.ranking.rank} ${tourLabel}` : null,
    info?.ranking?.points != null ? `${info.ranking.points.toLocaleString('es')} pts` : null,
    info?.age != null ? `${info.age} años` : null,
    info?.hand === 'L' ? 'zurdo/a' : info?.hand === 'R' ? 'diestro/a' : null,
  ].filter(Boolean) as string[];
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
      {/* Headline win probability — one decimal, matching the API value exactly.
          Dimmed when it comes from the market because the model couldn't predict. */}
      {prob != null && (
        <div
          className={`text-4xl font-bold leading-tight tabular-nums sm:text-5xl ${
            probSource === 'market' ? 'opacity-60' : ''
          }`}
          style={{ color }}
          title={
            probSource === 'model'
              ? 'Probabilidad de victoria según el modelo'
              : 'Probabilidad implícita en las cuotas del mercado (el modelo no puede predecir este partido)'
          }
        >
          {(prob * 100).toFixed(1)}
          <span className="text-2xl">%</span>
          {probSource === 'market' && (
            <span className="ml-1 align-middle text-xs font-normal text-slate-400">mercado</span>
          )}
        </div>
      )}
      {facts.length > 0 && <div className="text-xs text-slate-400">{facts.join(' · ')}</div>}
      <div className="text-xs text-slate-500">{odds != null ? `cuota ${odds}` : 'sin cuota'}</div>
    </div>
  );
}

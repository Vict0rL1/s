import { useState } from 'react';
import type { PlayerInfo, Reliability, UpcomingMatch, UpcomingWithPrediction } from '../lib/api';
import { confidenceLabelEs, flag, surfaceLabelEs } from '../lib/format';
import ProbabilityBars, { P1_COLOR, P2_COLOR } from './ProbabilityBars';
import MatchDetail from './MatchDetail';
import { Badge, Card, MatchTime, ResultBanner, SeriesDot } from './ui';

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
    // The shared surface, like the other four sports. This card was the one holdout:
    // its own background (bg-white/[0.04] instead of the system's #14161b) and a
    // drop shadow that ui/index.tsx explicitly rules out — "the card is the only
    // filled box on the page… not a lift, not a shadow". Side by side with a
    // basketball or football card the tennis one read as a different app.
    <Card as="article" className="p-4">
      <div className="mb-3 flex items-center justify-between text-[14px] text-[#9aa1ac]">
        <MatchTime iso={match.commence_time} />
        <span className="flex items-center gap-2">
          <span className="rounded bg-white/[0.06] px-2 py-0.5">
            {surfaceLabelEs(match.surface)}
          </span>
          {match.source === 'fixture' && (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-amber-300">odds demo</span>
          )}
        </span>
      </div>

      {/* WHO WON, when it has been played. Tennis has no score pair — the archive
          records a winner and a set score — so the headline is a name and the sets
          go underneath. Above the forecast for the same reason as the other four:
          once it is over, the result is the news. */}
      <ResultBanner
        started={item.outcome.started}
        score={item.outcome.result?.winnerName ?? null}
        detail={
          item.outcome.result
            ? [item.outcome.result.score, 'ganó el partido'].filter(Boolean).join(' · ')
            : null
        }
        modelCalledIt={
          prediction && item.outcome.result
            ? item.outcome.result.winnerId ===
              (prediction.model.prob1 >= prediction.model.prob2 ? match.p1_id : match.p2_id)
            : null
        }
      />

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
        <span className="px-3 pt-6 text-[14px] text-[#7b828d]">vs</span>
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
            <div className="text-[16px]">
              {verdict && verdict.favoredSide ? (
                <span>
                  El modelo favorece a{' '}
                  <SeriesDot color={verdict.favoredSide === 1 ? P1_COLOR : P2_COLOR} />{' '}
                  <strong className="text-[#e8eaed]">{verdict.favoredName}</strong>{' '}
                  <span className="text-[#9aa1ac]">
                    · {confidenceLabelEs(verdict.confidence)} ({verdict.marginPct} pp)
                  </span>
                </span>
              ) : (
                <span className="text-[#9aa1ac]">Partido muy parejo</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <ReliabilityBadge reliability={prediction.reliability} />
              {valuePlayer && (
                <Badge tone="good">Posible value: {valuePlayer}</Badge>
              )}
            </div>
          </div>

          {/* What the model expects to happen, in plain language */}
          <div className="mt-3 border-t border-white/[0.07] pt-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#7b828d]">
              Qué es lo más probable
            </div>
            <p className="text-[16px] font-medium text-[#e8eaed]">{prediction.summary.headline}</p>
            <ul className="mt-2 space-y-1">
              {prediction.summary.bullets.map((b, i) => (
                <li key={i} className="flex gap-2 text-[14px] text-[#c3c9d1]">
                  <span className="text-[#5c636c]">•</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>

          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-3 text-[14px] text-[#9aa1ac] hover:text-[#e8eaed]"
          >
            {open ? '▲ Ocultar desglose' : '▼ Ver desglose (Elo · forma · H2H · mercado)'}
          </button>
          {open && <MatchDetail prediction={prediction} />}
        </>
      ) : (
        <MissingPlayers match={match} players={players} />
      )}
    </Card>
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
      className={`rounded-full px-3 py-1 text-[14px] font-medium ring-1 ${styles[reliability.level]}`}
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
    <div className="rounded-lg bg-white/[0.03] p-3 text-[16px] text-[#9aa1ac] ring-1 ring-white/[0.07]">
      {unknown.length > 0 && (
        <>
          Sin predicción del modelo: no hay datos de{' '}
          <strong className="text-[#d5d9df]">{unknown.join(' ni de ')}</strong>.
          <div className="mt-1 text-[14px] text-[#7b828d]">
            Suele pasar si el historial descargado es antiguo y no cubre la carrera de este jugador.
            Ejecuta{' '}
            <code className="rounded bg-white/[0.04] px-1">npm run update-data -- --fresh</code> para
            volver a descargarlo.
          </div>
        </>
      )}
      {unknown.length === 0 && knownButUnrated.length > 0 && (
        <>
          Sin predicción del modelo: aún no hay partidos de{' '}
          <strong className="text-[#d5d9df]">{knownButUnrated.join(' ni de ')}</strong> en el
          historial, así que no se puede calcular su Elo.
          <div className="mt-1 text-[14px] text-[#7b828d]">
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
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : 'text-left'}`}>
      <span className={`flex min-w-0 items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {!alignRight && <SeriesDot color={color} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          className={`font-semibold text-[#e8eaed] break-words ${onClick ? 'hover:underline' : 'cursor-default'}`}
        >
          {flag(country)} {name}
        </button>
        {alignRight && <SeriesDot color={color} />}
      </span>
      {/* Headline win probability — one decimal, matching the API value exactly.
          Dimmed when it comes from the market because the model couldn't predict. */}
      {prob != null && (
        <div
          className={`text-4xl font-bold leading-tight tabular-nums text-[#e8eaed] sm:text-5xl ${
            probSource === 'market' ? 'opacity-60' : ''
          }`}
          title={
            probSource === 'model'
              ? 'Probabilidad de victoria según el modelo'
              : 'Probabilidad implícita en las cuotas del mercado (el modelo no puede predecir este partido)'
          }
        >
          {(prob * 100).toFixed(1)}
          <span className="text-[26px]">%</span>
          {probSource === 'market' && (
            <span className="ml-1 align-middle text-[14px] font-normal text-[#9aa1ac]">mercado</span>
          )}
        </div>
      )}
      {facts.length > 0 && <div className="text-[14px] text-[#9aa1ac]">{facts.join(' · ')}</div>}
      <div className="text-[14px] text-[#7b828d]">{odds != null ? `cuota ${odds}` : 'sin cuota'}</div>
    </div>
  );
}

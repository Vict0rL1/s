import { useState } from 'react';
import type { PlayerInfo, Reliability, UpcomingMatch, UpcomingWithPrediction } from '../lib/api';
import { confidenceLabelEs, surfaceLabelEs } from '../lib/format';
import ProbabilityBars, { P1_COLOR, P2_COLOR } from './ProbabilityBars';
import MatchDetail from './MatchDetail';
import LivePanel from './LivePanel';
import PointsMarkets from './PointsMarkets';
import { Badge, Card, Flag, MatchTime, ResultBanner, SeriesDot } from './ui';
import { EnlacePartido } from './ui';
import EventTrustPanel from './trust/EventTrustPanel';
import { conNodos, localeDe, useI18n } from '../i18n';
import { num as numF, pct as pctF } from '../lib/formato';

export default function MatchCard({
  item,
  onOpenPlayer,
}: {
  item: UpcomingWithPrediction;
  onOpenPlayer: (tour: string, id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const { match, prediction, marketOnly, players } = item;
  const { t, idioma } = useI18n();

  const verdict = prediction?.verdict;
  const value = prediction?.market.verdict;
  const valuePlayer =
    value === 'value_p1' ? match.p1_name : value === 'value_p2' ? match.p2_name : null;

  return (
    // The shared surface, like the other four sports. This card was the one holdout:
    // its own background (bg-(--raised) instead of the system's #14161b) and a
    // drop shadow that ui/index.tsx explicitly rules out — "the card is the only
    // filled box on the page… not a lift, not a shadow". Side by side with a
    // basketball or football card the tennis one read as a different app.
    <Card as="article" className="p-4">
      <div className="mb-3 flex items-center justify-between text-[14px] text-(--ink-soft)">
        <MatchTime iso={match.commence_time} />
        <span className="flex items-center gap-2">
          <span className="rounded bg-(--raised) px-2 py-0.5">
            {surfaceLabelEs(match.surface, idioma)}
          </span>
          {match.source === 'fixture' && (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-amber-300">{t('tt.oddsDemo')}</span>
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
            ? [item.outcome.result.score, t('tt.ganoPartido')].filter(Boolean).join(' · ')
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
        <span className="px-3 pt-6 text-[14px] text-(--ink-muted)">vs</span>
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
                  {conNodos(t('tt.favorece'), {
                    dot: <SeriesDot color={verdict.favoredSide === 1 ? P1_COLOR : P2_COLOR} />,
                    nombre: <strong className="text-(--ink-strong)">{verdict.favoredName}</strong>,
                    detalle: (
                      <span className="text-(--ink-soft)">
                        · {confidenceLabelEs(verdict.confidence, idioma)} ({numF(verdict.marginPct, 1)} pp)
                      </span>
                    ),
                  })}
                </span>
              ) : (
                <span className="text-(--ink-soft)">{t('tt.parejo')}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <ReliabilityBadge reliability={prediction.reliability} />
              {valuePlayer && (
                <Badge tone="good">{t('tt.posibleValue', { nombre: valuePlayer })}</Badge>
              )}
            </div>
          </div>

          {/* What the model expects to happen, in plain language */}
          <div className="mt-3 border-t border-(--line) pt-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-(--ink-muted)">
              {t('tt.masProbable')}
            </div>
            <p className="text-[16px] font-medium text-(--ink-strong)">{prediction.summary.headline}</p>
            <Bullets items={prediction.summary.bullets} />
          </div>

          <div className="mt-2 flex justify-end">
            <EnlacePartido sport="tennis" id={match.id} clave={item.prePartido?.matchKey} />
          </div>
          <EventTrustPanel confianza={item.confianza} prePartido={item.prePartido} />
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-3 text-[14px] text-(--ink-soft) hover:text-(--ink-strong)"
          >
            {open ? t('tt.ocultar') : t('tt.porQue')}
          </button>
          {open && (
            <>
              <MatchDetail prediction={prediction} />
              {/* Los cuatro mercados del modelo de puntos, antes del motor en vivo: el
                  de puntos contesta «cómo está el partido antes de empezar» y el en vivo
                  «cómo está ahora». */}
              <PointsMarkets
                tour={match.tour}
                p1={prediction.players.p1.id}
                p2={prediction.players.p2.id}
                names={[prediction.players.p1.name, prediction.players.p2.name]}
                surface={match.surface ?? 'Hard'}
                bestOf={prediction.scorelines.bestOf}
                tourney={match.tournament_name}
              />
              {/* El motor en vivo va DENTRO de la tarjeta desplegada, no en la lista: es
                  para un partido concreto que se está mirando, no para hojear. */}
              <LivePanel
                tour={match.tour}
                p1={prediction.players.p1.id}
                p2={prediction.players.p2.id}
                names={[prediction.players.p1.name, prediction.players.p2.name]}
                bestOf={prediction.scorelines.bestOf === 5 ? 5 : 3}
              />
            </>
          )}
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
  const { t } = useI18n();
  const styles: Record<Reliability['level'], string> = {
    high: 'bg-emerald-900/40 text-emerald-300 ring-emerald-500/40',
    medium: 'bg-amber-900/40 text-amber-300 ring-amber-500/40',
    low: 'bg-rose-900/40 text-rose-300 ring-rose-500/40',
  };
  const title = [
    t('tt.margen', { pp: reliability.marginPp }),
    t('tt.efectivos', { a: reliability.effectiveMatches.p1, b: reliability.effectiveMatches.p2 }),
    ...reliability.reasons,
  ].join('\n');
  return (
    <span
      title={title}
      className={`rounded-full px-3 py-1 text-[14px] font-medium ring-1 ${styles[reliability.level]}`}
    >
      {reliability.label} · ±{numF(reliability.marginPp, 1)} pp
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
  const { t } = useI18n();
  const knownButUnrated = sides
    .filter((s) => s.info && s.info.matchesInDb === 0)
    .map((s) => `${s.name}${s.info!.ranking ? ` (#${s.info!.ranking.rank})` : ''}`);

  return (
    <div className="rounded-lg bg-(--tint) p-3 text-[16px] text-(--ink-soft) ring-1 ring-(--line)">
      {unknown.length > 0 && (
        <>
          {conNodos(t('tt.sinDatos'), { nombres: <strong className="text-(--ink-body)">{unknown.join(t('tt.ni'))}</strong> })}
          <div className="mt-1 text-[14px] text-(--ink-muted)">
            {conNodos(t('tt.historialAntiguo'), { comando: <code className="rounded bg-(--raised) px-1">npm run update-data -- --fresh</code> })}
          </div>
        </>
      )}
      {unknown.length === 0 && knownButUnrated.length > 0 && (
        <>
          {conNodos(t('tt.sinPartidos'), { nombres: <strong className="text-(--ink-body)">{knownButUnrated.join(t('tt.ni'))}</strong> })}
          <div className="mt-1 text-[14px] text-(--ink-muted)">{t('tt.arriba')}</div>
        </>
      )}
      {unknown.length === 0 && knownButUnrated.length === 0 && (
        <>{t('tt.sinPrediccion')}</>
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
  const { t, idioma } = useI18n();
  const facts = [
    info?.ranking ? `#${info.ranking.rank} ${tourLabel}` : null,
    info?.ranking?.points != null ? t('tt.pts', { n: info.ranking.points.toLocaleString(localeDe(idioma)) }) : null,
    info?.age != null ? t('tt.anios', { n: info.age }) : null,
    info?.hand === 'L' ? t('tt.zurdo') : info?.hand === 'R' ? t('tt.diestro') : null,
  ].filter(Boolean) as string[];
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : 'text-left'}`}>
      <span className={`flex min-w-0 items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {!alignRight && <SeriesDot color={color} />}
        {!alignRight && <Flag country={country} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          className={`font-semibold text-(--ink-strong) break-words ${onClick ? 'hover:underline' : 'cursor-default'}`}
        >
          {name}
        </button>
        {/* La bandera se refleja como el punto: en el borde de fuera en los dos lados. */}
        {alignRight && <Flag country={country} />}
        {alignRight && <SeriesDot color={color} />}
      </span>
      {/* Headline win probability — one decimal, matching the API value exactly.
          Dimmed when it comes from the market because the model couldn't predict. */}
      {prob != null && (
        <div
          className={`text-4xl font-bold leading-tight tabular-nums text-(--ink-strong) sm:text-5xl ${
            probSource === 'market' ? 'opacity-60' : ''
          }`}
          title={
            probSource === 'model'
              ? t('tt.probModelo')
              : t('tt.probMercado')
          }
        >
          {/* El número con el espacio duro del idioma («67,5 %», «67.5%») y el «%» más pequeño. */}
          {pctF(prob, 1).replace(/%$/, '')}
          <span className="text-[26px]">%</span>
          {probSource === 'market' && (
            <span className="ml-1 align-middle text-[14px] font-normal text-(--ink-soft)">{t('tt.mercado')}</span>
          )}
        </div>
      )}
      {facts.length > 0 && <div className="text-[14px] text-(--ink-soft)">{facts.join(' · ')}</div>}
      <div className="text-[14px] text-(--ink-muted)">{odds != null ? t('tt.cuota', { c: odds }) : t('tt.sinCuota')}</div>
    </div>
  );
}

/**
 * Los motivos, con los cuatro primeros a la vista y el resto a un clic.
 *
 * ===========================================================================
 * NUEVE VIÑETAS DEL MISMO PESO NO SON UNA LISTA, SON UN PÁRRAFO
 * ===========================================================================
 * El modelo produce hasta nueve motivos por partido —Elo, historial, forma, cara a cara,
 * set decisivo, torneo, señales físicas, comparación con el mercado— y se pintaban todos
 * iguales, uno detrás de otro. Con dos tarjetas por fila eso son dieciocho líneas de
 * prosa a la misma altura, y encontrar la que mueve la predicción cuesta leerlas todas.
 *
 * El generador YA las devuelve en orden de importancia, y esa información se estaba
 * tirando al pintarlas idénticas. Ahora las cuatro primeras se ven y las demás se
 * despliegan: no se pierde ni un motivo, pero la tarjeta vuelve a leerse de un vistazo.
 *
 * CUATRO, y no tres ni cinco: las tres primeras son casi siempre Elo, historial y forma
 * —el esqueleto de cualquier predicción— y la cuarta es la primera que distingue ESTE
 * partido de otro. Cortar en tres deja la lista genérica.
 *
 * Y el contador dice cuántas faltan. «Ver más» sin número obliga a pulsar para saber si
 * merece la pena.
 */
function Bullets({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false);
  const VISIBLES = 4;
  const ocultos = items.length - VISIBLES;
  const mostrados = open ? items : items.slice(0, VISIBLES);
  const { t } = useI18n();

  return (
    <>
      <ul className="mt-2 space-y-1">
        {mostrados.map((b, i) => (
          <li key={i} className="flex gap-2 text-[14px] text-(--ink-body)">
            <span className="text-(--ink-faint)">•</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      {ocultos > 0 && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-1.5 text-[13px] text-(--ink-muted) underline-offset-2 hover:text-(--ink-body) hover:underline"
        >
          {open ? t('tt.verMenos') : t(ocultos === 1 ? 'tt.verMas1' : 'tt.verMasN', { n: ocultos })}
        </button>
      )}
    </>
  );
}

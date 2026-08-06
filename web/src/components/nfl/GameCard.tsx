import type { NflGameWithPrediction, NflPrediction, NflSpreadQuote } from '../../lib/nfl';
import { AWAY_COLOR, HOME_COLOR, NEUTRAL_COLOR, pct } from '../../lib/theme';
import {
  Badge,
  BarRow,
  Card,
  CompareRow,
  Disclosure,
  EmptyState,
  FactorValue,
  FormDots,
  HeroStat,
  MatchTime,
  Panel,
  ProbabilityBar,
  ReliabilityChip,
  ResultBanner,
  SectionTitle,
  StatRow,
  StatTile,
  TeamCrest,
} from '../ui';

/**
 * One NFL game.
 *
 * The card is ordered the way a sportsbook orders its markets for this sport,
 * which is NOT the order the other four tabs use: the HANDICAP comes first,
 * because in American football the spread is the market and the moneyline is the
 * afterthought. A −7 favourite is described by the seven, not by the 72%.
 *
 * The panel that exists only here is "los números clave". Everything else in the
 * app prices a handicap off a smooth curve; this sport cannot, because 15% of
 * games end with a 3-point margin and 1.6% with a 9-point one. Showing those
 * probabilities is showing the one thing the model knows that a normal curve
 * does not.
 */
export default function GameCard({
  item,
  onOpenTeam,
}: {
  item: NflGameWithPrediction;
  onOpenTeam: (league: string, id: string) => void;
}) {
  const { game, prediction, marketOnly, teams } = item;
  const probs = prediction?.model ?? marketOnly ?? null;

  return (
    <Card as="article" className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#7b828d]">
        {/* Only the clock: the day is in the heading above this group, and thirty
            cards each restating their own date is thirty copies of a fact that
            changes four times. */}
        <MatchTime
          iso={game.commence_time}
          extra={game.week != null ? <span className="ml-1.5">· semana {game.week}</span> : undefined}
        />
        <div className="flex items-center gap-1.5">
          {game.neutral === 1 && <Badge>campo neutral</Badge>}
          {game.source === 'schedule' && <Badge>calendario oficial</Badge>}
          {game.source === 'fixture' && <Badge tone="warning">partido demo</Badge>}
        </div>
      </div>

      {/* The result, when there is one. Above the forecast because once a game
          has been played the score is the headline and the prediction is
          history — see ResultBanner for the three states it distinguishes. */}
      <ResultBanner
        started={item.outcome.started}
        score={
          item.outcome.result
            ? `${item.outcome.result.awayScore}-${item.outcome.result.homeScore}`
            : null
        }
        detail={
          item.outcome.result
            ? `${game.away_name} ${item.outcome.result.awayScore} · ${game.home_name} ${item.outcome.result.homeScore}`
            : null
        }
        modelCalledIt={
          item.prediction && item.outcome.result
            ? item.outcome.result.homeScore === item.outcome.result.awayScore
              ? null
              : (item.outcome.result.homeScore > item.outcome.result.awayScore) ===
                (item.prediction.model.home >= 0.5)
            : null
        }
      />

      {/* Away @ Home — the order American football is always written in. */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <TeamName
          league={game.league}
          id={game.away_id}
          name={prediction?.teams.away.name ?? game.away_name}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          record={prediction?.teams.away.record ?? teams.away?.record ?? null}
          onClick={game.away_id ? () => onOpenTeam(game.league, game.away_id!) : undefined}
        />
        <span className="shrink-0 pt-1 text-[13px] font-medium text-[#5c636c]">@</span>
        <TeamName
          league={game.league}
          id={game.home_id}
          name={prediction?.teams.home.name ?? game.home_name}
          elo={prediction?.teams.home.elo ?? teams.home?.elo ?? null}
          eloRank={prediction?.teams.home.eloRank ?? teams.home?.eloRank ?? null}
          record={prediction?.teams.home.record ?? teams.home?.record ?? null}
          alignRight
          homeBadge={game.neutral !== 1}
          onClick={game.home_id ? () => onOpenTeam(game.league, game.home_id!) : undefined}
        />
      </div>

      {probs ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <HeroStat
              value={pct(probs.away)}
              label="Visitante"
              sub={game.odds_away ? `cuota ${game.odds_away}` : undefined}
              color={AWAY_COLOR}
            />
            <HeroStat
              value={pct(probs.home)}
              label="Local"
              sub={game.odds_home ? `cuota ${game.odds_home}` : undefined}
              color={HOME_COLOR}
              align="right"
            />
          </div>
          <div className="mt-2.5">
            <ProbabilityBar
              segments={[
                { value: probs.away, color: AWAY_COLOR, label: game.away_name },
                { value: probs.home, color: HOME_COLOR, label: game.home_name },
              ]}
            />
          </div>

          {!prediction && (
            <p className="mt-2 text-center text-[13px] text-amber-300/90">
              Probabilidades implícitas del mercado, no del modelo.
            </p>
          )}

          {prediction && (
            <>
              <StatRow className="mt-3">
                <StatTile
                  label={`Hándicap ${fmtLine(prediction.spread.line)}`}
                  value={pct(prediction.spread.home.cover)}
                  hint={
                    prediction.spread.home.push > 0.005
                      ? `nulo ${pct(prediction.spread.home.push)}`
                      : 'lo cubre el local'
                  }
                  title={
                    prediction.spread.fromMarket
                      ? 'Línea tomada del mercado. Probabilidad de que el local la cubra.'
                      : 'Sin línea del mercado: se usa la del propio modelo, redondeada.'
                  }
                />
                <StatTile
                  label={`Total ${prediction.total.line}`}
                  value={pct(prediction.total.over)}
                  hint={`under ${pct(prediction.total.under)}`}
                />
                <StatTile
                  label="Margen esperado"
                  value={prediction.spread.label}
                  hint={`${prediction.points.home}-${prediction.points.away}`}
                />
                <StatTile
                  label="Marcador"
                  value={prediction.scorelines[0]?.label ?? '—'}
                  hint={`más probable · ${pct(prediction.scorelines[0]?.probability ?? 0)}`}
                />
              </StatRow>

              <KeyNumbers prediction={prediction} />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-[15px] leading-snug text-[#c3c9d1]">
                  {prediction.verdict.close ? (
                    <>
                      Muy igualado —{' '}
                      <strong className="font-semibold text-[#e8eaed]">
                        {prediction.verdict.label}
                      </strong>{' '}
                      solo por poco
                    </>
                  ) : (
                    <>
                      Lo más probable:{' '}
                      <strong className="font-semibold text-[#e8eaed]">
                        {prediction.verdict.label}
                      </strong>
                    </>
                  )}
                </p>
                {/* WRAPS, and must: this group holds a "Value: <team name>" badge, and
                      with `shrink-0` it could neither shrink nor wrap, so a long name
                      pushed the whole page 10px wide. */}
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  {prediction.market.verdict.startsWith('value_') && (
                    <Badge tone="good" title="El modelo da más probabilidad que el mercado">
                      Value:{' '}
                      {prediction.market.verdict === 'value_home'
                        ? prediction.teams.home.name
                        : prediction.teams.away.name}
                    </Badge>
                  )}
                  <ReliabilityChip
                    level={prediction.reliability.level}
                    label={prediction.reliability.label}
                    marginPp={prediction.reliability.marginPp}
                    title={[
                      `Margen de incertidumbre: ±${prediction.reliability.marginPp} pp.`,
                      'Calibrado contra la línea de cierre real: el modelo se separa 7.3 pp de media de ella.',
                      ...prediction.reliability.reasons,
                    ].join('\n')}
                  />
                </div>
              </div>

              <div className="mt-1">
                <Disclosure summary="Ver desglose · números clave, márgenes, marcadores y mercado">
                  <Detail prediction={prediction} />
                </Disclosure>
              </div>
            </>
          )}
        </>
      ) : (
        <EmptyState title="Sin modelo ni cuotas para este partido" tone="warning">
          No encuentro a estos equipos en el historial, así que no puedo calcular nada para este
          partido.
        </EmptyState>
      )}
    </Card>
  );
}

const fmtLine = (l: number) => (l === 0 ? 'PK' : `${l > 0 ? '+' : ''}${l}`);

/**
 * The key numbers.
 *
 * The single most useful thing this model knows and a normal curve does not.
 * Rendered as plain figures rather than a chart because four numbers are four
 * numbers, and the point is the comparison between them.
 */
function KeyNumbers({ prediction }: { prediction: NflPrediction }) {
  const three = prediction.keyNumbers.find((k) => k.margin === 3)?.probability ?? 0;
  const seven = prediction.keyNumbers.find((k) => k.margin === 7)?.probability ?? 0;
  return (
    <div className="mt-3 border-b border-white/[0.07] pb-3">
      <SectionTitle right={`3 o 7: ${pct(three + seven)}`}>
        El margen cae justo en…
      </SectionTitle>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {prediction.keyNumbers.map((k) => (
          <div key={k.margin} className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
              {k.margin} puntos
            </div>
            <div className="text-[16px] font-semibold tabular-nums text-[#e8eaed]">
              {pct(k.probability)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[#7b828d]">
        En la NFL el marcador se mueve de 3 en 3 y de 7 en 7, así que el margen final se amontona en
        esos números. Por eso una línea de −3 y una de −3.5 no son la misma apuesta.
      </p>
    </div>
  );
}

function TeamName({
  league, id, name, elo, eloRank, record, alignRight = false, homeBadge = false, onClick,
}: {
  league: string;
  id: string | null;
  name: string;
  elo: number | null;
  eloRank: number | null;
  record: { wins: number; losses: number; ties: number } | null;
  alignRight?: boolean;
  homeBadge?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <span className={`flex min-w-0 items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {/* The crest, not the series dot: the dot's job is done one line below
            by the hero label, and two identity marks on one line is one too many. */}
        {!alignRight && <TeamCrest league={league} name={name} code={id} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          // Wraps rather than truncates. At the larger type size "New England
          // Patriots" no longer fits half a 390px card, and `truncate` turned the
          // two team names — the one thing a matchup card exists to tell you —
          // into "New Engl…" and "Seattle S…". Two short lines cost a few pixels
          // of height and lose nothing.
          className={`max-w-full text-left text-[17px] font-semibold leading-tight break-words text-[#e8eaed] ${
            alignRight ? 'text-right' : ''
          } ${onClick ? 'hover:underline' : 'cursor-default'}`}
          title={onClick ? 'Ver ficha del equipo' : name}
        >
          {name}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} />}
      </span>
      <div className="text-[13px] text-[#7b828d]">
        {homeBadge && 'local · '}
        {elo != null && (
          <>
            Elo {Math.round(elo)}
            {eloRank != null && ` (#${eloRank})`}
          </>
        )}
        {record && ` · ${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ''}`}
      </div>
    </div>
  );
}

function Detail({ prediction }: { prediction: NflPrediction }) {
  const { teams, spread, total, bands, scorelines, h2h, market, reasoning, summary, context } =
    prediction;
  const home = teams.home;
  const away = teams.away;
  const formColors = { W: HOME_COLOR, D: NEUTRAL_COLOR, L: AWAY_COLOR };
  const maxBand = Math.max(...bands.map((b) => b.probability));
  const maxScore = Math.max(...scorelines.map((s) => s.probability));

  return (
    <div className="space-y-3">
      <Panel>
        <SectionTitle>Por qué</SectionTitle>
        <p className="mb-2 text-[15px] leading-relaxed text-[#c3c9d1]">{reasoning.text}</p>
        <dl className="space-y-1 text-[13px]">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="flex justify-between gap-3">
              <dt className="text-[#9aa1ac]">{f.label}</dt>
              <dd>
                <FactorValue
                  color={f.pointsForHome >= 0 ? HOME_COLOR : AWAY_COLOR}
                  neutral={f.pointsForHome === 0}
                >
                  {f.pointsForHome === 0
                    ? '0 (neutral)'
                    : `${Math.abs(f.pointsForHome)} pts para ${f.pointsForHome > 0 ? home.name : away.name}`}
                </FactorValue>
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      {/* WHO IS PLAYING QUARTERBACK.
          Its own panel because it is the only model input a reader can check and
          correct from the news, and because the assumption behind it needs saying
          out loud: the schedule never names a starter, so the model uses whoever
          started last. Stating that is the difference between a reader who knows
          the forecast is stale and one who only suspects it. */}
      {(prediction.quarterbacks.home || prediction.quarterbacks.away) && (
        <Panel>
          <SectionTitle right="quien jugó el último partido">Quarterback titular</SectionTitle>
          <dl className="space-y-1 text-[13px]">
            {([
              ['home', home.name, prediction.quarterbacks.home, HOME_COLOR],
              ['away', away.name, prediction.quarterbacks.away, AWAY_COLOR],
            ] as const).map(([key, teamName, qb, color]) => (
              <div key={key} className="flex justify-between gap-3">
                <dt className="text-[#9aa1ac]">
                  {qb?.name ?? 'sin dato'}{' '}
                  <span className="text-[#5c636c]">· {teamName}</span>
                </dt>
                <dd>
                  <FactorValue color={color} neutral={!qb || qb.points === 0}>
                    {!qb
                      ? '—'
                      : qb.points === 0
                        ? 'nivel medio de la liga'
                        : `${qb.points > 0 ? '+' : ''}${qb.points} pts · ${qb.starts} titularidades`}
                  </FactorValue>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[13px] leading-relaxed text-[#7b828d]">
            Medido sobre 27 temporadas: el 52% de los equipos usa más de un titular por temporada, así
            que quién juega de quarterback mueve el pronóstico. Si sabes que hay un cambio esta semana,
            el modelo aún no lo sabe.
          </p>
        </Panel>
      )}

      {/* The handicap at the two lines the whole market is built around, priced
          at any line the reader might be looking at. */}
      <Panel>
        <SectionTitle right={spread.fromMarket ? 'línea del mercado' : 'línea del modelo'}>
          El hándicap, línea por línea
        </SectionTitle>
        <div className="space-y-1 text-[13px]">
          {spread.keyLines.map((q) => (
            <SpreadLine key={q.line} quote={q} homeName={home.name} />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#7b828d]">
          «Nulo» es la probabilidad de que el margen caiga justo en la línea y te devuelvan la
          apuesta. En una línea entera de 3 puntos eso pasa una de cada trece veces.
        </p>
      </Panel>

      <Panel>
        <SectionTitle right={`${total.expected} esperados`}>Total de puntos</SectionTitle>
        <div className="flex items-center gap-3 text-[13px]">
          <span className="w-16 shrink-0 text-[#9aa1ac]">Over {total.line}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full"
              style={{ width: `${total.over * 100}%`, backgroundColor: HOME_COLOR }}
            />
          </div>
          <span className="w-24 shrink-0 text-right tabular-nums text-[#9aa1ac]">
            {pct(total.over)} / {pct(total.under)}
          </span>
        </div>
      </Panel>

      <Panel>
        <SectionTitle>Por cuánto gana</SectionTitle>
        <div className="space-y-1">
          {bands.map((b) => (
            <BarRow
              key={b.label}
              label={b.label.replace('local por ', '+').replace('visitante por ', '−')}
              value={b.probability}
              max={maxBand}
              color={
                b.from === 0 && b.to === 0
                  ? NEUTRAL_COLOR
                  : (b.from ?? -1) > 0
                    ? HOME_COLOR
                    : AWAY_COLOR
              }
              valueLabel={pct(b.probability)}
            />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#7b828d]">
          Los tramos son de una, dos y tres anotaciones: «dentro de una anotación» es la frase con la
          que se sigue el último cuarto.
        </p>
      </Panel>

      <Panel>
        <SectionTitle>Marcadores más probables</SectionTitle>
        <div className="space-y-1">
          {scorelines.map((s) => (
            <BarRow
              key={s.label}
              label={s.label}
              value={s.probability}
              max={maxScore}
              color={s.home > s.away ? HOME_COLOR : s.home === s.away ? NEUTRAL_COLOR : AWAY_COLOR}
              valueLabel={pct(s.probability)}
            />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#7b828d]">
          Salen de combinar el margen y el total, así que cuadran exactamente con los dos paneles de
          arriba. A cambio, no saben que 22 puntos es un marcador raro y 24 uno corriente.
        </p>
      </Panel>

      <Panel>
        <SectionTitle>Los dos equipos</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
          <div />
          <div className="flex w-20 items-center justify-end gap-1.5 font-medium text-[#e8eaed]">
            <span className="truncate">{away.name}</span>
            <TeamCrest league={prediction.league} name={away.name} code={away.id} size={14} />
          </div>
          <div className="flex w-20 items-center justify-end gap-1.5 font-medium text-[#e8eaed]">
            <span className="truncate">{home.name}</span>
            <TeamCrest league={prediction.league} name={home.name} code={home.id} size={14} />
          </div>
          <CompareRow label="Elo" left={Math.round(away.elo)} right={Math.round(home.elo)} />
          <CompareRow label="Puntos a favor / partido" left={away.pf ?? '—'} right={home.pf ?? '—'} />
          <CompareRow label="Puntos en contra / partido" left={away.pa ?? '—'} right={home.pa ?? '—'} />
          <CompareRow
            label="Balance"
            left={`${away.record.wins}-${away.record.losses}${away.record.ties ? `-${away.record.ties}` : ''}`}
            right={`${home.record.wins}-${home.record.losses}${home.record.ties ? `-${home.record.ties}` : ''}`}
          />
          <CompareRow
            label="Pitagórico"
            title="Victorias que sugieren los puntos anotados y encajados (exponente 2.37, el de la NFL)"
            left={away.pythagorean != null ? pct(away.pythagorean) : '—'}
            right={home.pythagorean != null ? pct(home.pythagorean) : '—'}
          />
          <CompareRow
            label="Últimos 5"
            title="Azul = ganado · gris = empatado · naranja = perdido"
            left={<FormDots results={away.last5} colors={formColors} />}
            right={<FormDots results={home.last5} colors={formColors} />}
          />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle right={`${h2h.awayWins} · ${h2h.homeWins} (${h2h.total})`}>
          Historial directo
        </SectionTitle>
        {h2h.recent.length === 0 ? (
          <p className="text-[13px] text-[#7b828d]">Sin enfrentamientos previos en el archivo.</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between gap-3 text-[#c3c9d1]">
                <span className="shrink-0 text-[#7b828d]">
                  {m.season} · sem {m.week}
                </span>
                <span className="truncate text-right">
                  {m.awayId === away.id ? away.name : home.name} {m.awayPoints}–{m.homePoints}{' '}
                  {m.homeId === home.id ? home.name : away.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {market.market && (
        <Panel>
          <SectionTitle right={`margen ${((market.market.overround - 1) * 100).toFixed(1)}%`}>
            Mercado
          </SectionTitle>
          <p className="text-[13px] leading-relaxed text-[#c3c9d1]">
            Cuotas {market.market.odds.away} / {market.market.odds.home} · implícitas sin vig{' '}
            {pct(market.market.away)} / {pct(market.market.home)}
          </p>
        </Panel>
      )}

      <Panel>
        <SectionTitle right={`${context.homeAdvantagePoints} pts de ventaja de campo`}>
          Lectura completa
        </SectionTitle>
        <ul className="space-y-1.5">
          {summary.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-[#9aa1ac]">
              <span aria-hidden className="text-[#5c636c]">
                •
              </span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function SpreadLine({ quote, homeName }: { quote: NflSpreadQuote; homeName: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 tabular-nums text-[#c3c9d1]" title={quote.label}>
        {homeName.split(' ').slice(-1)[0]} {fmtLine(quote.line)}
      </span>
      <div className="flex h-2 flex-1 gap-[2px] overflow-hidden rounded-full">
        <div
          className="rounded-l-full"
          style={{ width: `${quote.cover * 100}%`, backgroundColor: HOME_COLOR }}
        />
        {quote.push > 0.002 && (
          <div style={{ width: `${quote.push * 100}%`, backgroundColor: NEUTRAL_COLOR }} />
        )}
        <div
          className="rounded-r-full"
          style={{ width: `${quote.fail * 100}%`, backgroundColor: AWAY_COLOR }}
        />
      </div>
      <span className="w-24 shrink-0 text-right tabular-nums text-[#9aa1ac]">
        {pct(quote.cover)}
        {quote.push > 0.002 && <span className="text-[#7b828d]"> · {pct(quote.push)} nulo</span>}
      </span>
    </div>
  );
}

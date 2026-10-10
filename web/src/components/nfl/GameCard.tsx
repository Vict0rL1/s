import type { NflGameWithPrediction } from '../../lib/nfl';
import { AWAY_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import { EnlacePartido } from '../ui';
import EventTrustPanel from '../trust/EventTrustPanel';

import { Badge, Card, Disclosure, EmptyState, HeroStat, MatchTime, ProbabilityBar, ReliabilityChip, ResultBanner, StatRow, StatTile, MarketGap } from '../ui';
import { fmtLine, KeyNumbers, TeamName, Detail } from './GameCardPartes';
import { conNodos, useI18n } from '../../i18n';

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
  const { t } = useI18n();
  const { game, prediction, marketOnly, teams } = item;
  // La cabecera es la final publicada (la que registra el historial y lee Destacados), no la cruda.
  const probs = prediction?.final ?? marketOnly ?? null;

  return (
    <Card as="article" className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-(--ink-muted)">
        {/* Only the clock: the day is in the heading above this group, and thirty
            cards each restating their own date is thirty copies of a fact that
            changes four times. */}
        <MatchTime
          iso={game.commence_time}
          extra={game.week != null ? <span className="ml-1.5">{t('nflc.semana', { n: game.week })}</span> : undefined}
        />
        <div className="flex items-center gap-1.5">
          {game.neutral === 1 && <Badge>{t('nflc.neutral')}</Badge>}
          {game.source === 'schedule' && <Badge>{t('nflc.calendario')}</Badge>}
          {game.source === 'fixture' && <Badge tone="warning">{t('eq.partidoDemo')}</Badge>}
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
                (item.prediction.final.home >= 0.5)
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
        <span className="shrink-0 pt-1 text-[13px] font-medium text-(--ink-faint)">@</span>
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
              label={t('eq.visitante')}
              sub={game.odds_away ? t('tt.cuota', { c: game.odds_away }) : undefined}
              color={AWAY_COLOR}
            />
            <HeroStat
              value={pct(probs.home)}
              label={t('eq.local')}
              sub={game.odds_home ? t('tt.cuota', { c: game.odds_home }) : undefined}
              color={HOME_COLOR}
              align="right"
            />
          </div>
          <div className="mt-2.5">
            {/* El mercado, MARCADO SOBRE la barra del modelo. Antes la comparación
                —que es para lo que existe esta tarjeta— no estaba en ninguna parte:
                había que abrir el desglose y leer dos porcentajes. */}
            <div className="mb-1 flex items-center justify-end">
              <MarketGap model={probs.away} market={prediction?.market.market?.away} />
            </div>
            <ProbabilityBar
              segments={[
                { value: probs.away, color: AWAY_COLOR, label: game.away_name },
                { value: probs.home, color: HOME_COLOR, label: game.home_name },
              ]}
              marker={prediction?.market.market?.away}
            />
          </div>

          {!prediction && (
            <p className="mt-2 text-center text-[13px] text-amber-300/90">
              {t('eq.implicitasNoModelo')}
            </p>
          )}

          {prediction && (
            <>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-[15px] leading-snug text-(--ink-body)">
                  {prediction.verdict.close ? (
                    <>
                      {conNodos(t('bsc.igualado'), {
                        cual: (
                          <strong className="font-semibold text-(--ink-strong)">
                            {prediction.verdict.label}
                          </strong>
                        ),
                      })}
                    </>
                  ) : (
                    <>
                      {conNodos(t('fbc.loMasProbable'), {
                        cual: (
                          <strong className="font-semibold text-(--ink-strong)">
                            {prediction.verdict.label}
                          </strong>
                        ),
                      })}
                    </>
                  )}
                </p>
                {/* WRAPS, and must: this group holds a "Value: <team name>" badge, and
                      with `shrink-0` it could neither shrink nor wrap, so a long name
                      pushed the whole page 10px wide. */}
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  {prediction.market.verdict.startsWith('differs_') && (
                    // Neutral tone on purpose. This used to be a green "Value:" badge,
                    // which read as "here is an edge" on the one tab where the app has
                    // measured that there is none.
                    <Badge
                      tone="neutral"
                      title={t('nflc.discrepaTitulo')}
                    >
                      {t('nflc.discrepa', {
                        nombre:
                          prediction.market.verdict === 'differs_home'
                            ? prediction.teams.home.name
                            : prediction.teams.away.name,
                      })}
                    </Badge>
                  )}
                  <ReliabilityChip
                    level={prediction.reliability.level}
                    label={prediction.reliability.label}
                    marginPp={prediction.reliability.marginPp}
                    title={[
                      t('eq.margenPp', { pp: prediction.reliability.marginPp }),
                      t('nflc.calibrado'),
                      ...prediction.reliability.reasons,
                    ].join('\n')}
                  />
                </div>
              </div>

              <div className="mt-2 flex justify-end">
                <EnlacePartido sport="nfl" id={game.id} clave={item.prePartido?.matchKey} />
              </div>
              <EventTrustPanel confianza={item.confianza} prePartido={item.prePartido} />
              <div className="mt-1">
                <Disclosure summary={t('nflc.porQue')}>
                  <StatRow>
                <StatTile
                  label={t('nflc.handicap', { linea: fmtLine(prediction.spread.line) })}
                  value={pct(prediction.spread.home.cover)}
                  hint={
                    prediction.spread.home.push > 0.005
                      ? t('nflc.nulo', { p: pct(prediction.spread.home.push) })
                      : t('nflc.loCubre')
                  }
                  title={
                    prediction.spread.fromMarket
                      ? t('nflc.lineaMercado')
                      : t('nflc.lineaModelo')
                  }
                />
                <StatTile
                  label={t('nflc.total', { linea: prediction.total.line })}
                  value={pct(prediction.total.over)}
                  hint={t('nflc.under', { p: pct(prediction.total.under) })}
                />
                <StatTile
                  label={t('nflc.margenEsperado')}
                  value={prediction.spread.label}
                  hint={`${prediction.points.home}-${prediction.points.away}`}
                />
                <StatTile
                  label={t('fbc.marcador')}
                  value={prediction.scorelines[0]?.label ?? '—'}
                  hint={t('fbc.masProbable', { p: pct(prediction.scorelines[0]?.probability ?? 0) })}
                />
              </StatRow>
                  <KeyNumbers prediction={prediction} />
                  <Detail prediction={prediction} clima={item.clima} />
                </Disclosure>
              </div>
            </>
          )}
        </>
      ) : (
        <EmptyState title={t('fbc.sinModeloNiCuotas')} tone="warning">
          {t('nflc.noEncuentro')}
        </EmptyState>
      )}
    </Card>
  );
}

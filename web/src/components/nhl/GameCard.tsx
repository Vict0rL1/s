import type { NhlGameWithPrediction } from '../../lib/nhl';
import { AWAY_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import { Badge, Card, Disclosure, EmptyState, EnlacePartido, HeroStat, MarketGap, MatchTime, ProbabilityBar, ReliabilityChip, ResultBanner, StatRow, StatTile } from '../ui';
import EventTrustPanel from '../trust/EventTrustPanel';
import { TeamName } from '../nfl/GameCardPartes';
import { Detail } from './GameCardPartes';
import { conNodos, useI18n } from '../../i18n';

/**
 * Un partido de la NHL.
 *
 * El número grande es el ganador CON prórroga y tanda, que es como se paga el moneyline en la NHL.
 * Lo que solo existe aquí: el partido a 60 minutos (con su empate, que va a la prórroga) y el total
 * de goles del acta, en el que la prórroga o la tanda suman uno. Todo sale de la misma distribución.
 */
export default function GameCard({ item, onOpenTeam }: { item: NhlGameWithPrediction; onOpenTeam: (id: string) => void }) {
  const { t } = useI18n();
  const { game, prediction, teams } = item;
  const probs = prediction?.final ?? null;
  const resultado = item.outcome.result;

  return (
    <Card as="article" className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-(--ink-muted)">
        <MatchTime iso={game.commence_time} />
        <div className="flex items-center gap-1.5">{game.source === 'schedule' && <Badge>{t('nflc.calendario')}</Badge>}</div>
      </div>

      <ResultBanner
        started={item.outcome.started}
        score={resultado ? `${resultado.awayScore}-${resultado.homeScore}` : null}
        detail={resultado ? `${game.away_name} ${resultado.awayScore} · ${game.home_name} ${resultado.homeScore}` : null}
        modelCalledIt={prediction && resultado && resultado.homeScore !== resultado.awayScore ? resultado.homeScore > resultado.awayScore === prediction.final.home >= 0.5 : null}
      />

      {/* Visitante @ local, como se escribe en Norteamérica. */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <TeamName
          league="nhl"
          id={game.away_id}
          name={prediction?.teams.away.name ?? game.away_name}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          record={(prediction?.teams.away ?? teams.away) ? { ...(prediction?.teams.away ?? teams.away)!.record, ties: 0 } : null}
          onClick={game.away_id ? () => onOpenTeam(game.away_id!) : undefined}
        />
        <span className="shrink-0 pt-1 text-[13px] font-medium text-(--ink-faint)">@</span>
        <TeamName
          league="nhl"
          id={game.home_id}
          name={prediction?.teams.home.name ?? game.home_name}
          elo={prediction?.teams.home.elo ?? teams.home?.elo ?? null}
          eloRank={prediction?.teams.home.eloRank ?? teams.home?.eloRank ?? null}
          record={(prediction?.teams.home ?? teams.home) ? { ...(prediction?.teams.home ?? teams.home)!.record, ties: 0 } : null}
          alignRight
          homeBadge
          onClick={game.home_id ? () => onOpenTeam(game.home_id!) : undefined}
        />
      </div>

      {probs && prediction ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <HeroStat value={pct(probs.away)} label={t('eq.visitante')} sub={game.odds_away ? t('tt.cuota', { c: game.odds_away }) : undefined} color={AWAY_COLOR} />
            <HeroStat value={pct(probs.home)} label={t('eq.local')} sub={game.odds_home ? t('tt.cuota', { c: game.odds_home }) : undefined} color={HOME_COLOR} align="right" />
          </div>
          <div className="mt-2.5">
            <div className="mb-1 flex items-center justify-end">
              <MarketGap model={probs.away} market={prediction.market.market?.away} />
            </div>
            <ProbabilityBar
              segments={[
                { value: probs.away, color: AWAY_COLOR, label: game.away_name },
                { value: probs.home, color: HOME_COLOR, label: game.home_name },
              ]}
              marker={prediction.market.market?.away}
            />
            <p className="mt-1 text-[12px] text-(--ink-muted)">{t('nhlc.conProrroga')}</p>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-[15px] leading-snug text-(--ink-body)">
              {conNodos(t(prediction.verdict.close ? 'bsc.igualado' : 'fbc.loMasProbable'), {
                cual: <strong className="font-semibold text-(--ink-strong)">{prediction.verdict.label}</strong>,
              })}
            </p>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              {prediction.market.verdict.startsWith('differs_') && (
                // Neutro a propósito: es desacuerdo con la casa, no una ventaja medida (no hay cuotas históricas).
                <Badge tone="neutral" title={t('nhlc.discrepaTitulo')}>
                  {t('nflc.discrepa', { nombre: prediction.market.verdict === 'differs_home' ? prediction.teams.home.name : prediction.teams.away.name })}
                </Badge>
              )}
              <ReliabilityChip
                level={prediction.reliability.level}
                label={prediction.reliability.label}
                marginPp={prediction.reliability.marginPp}
                title={[t('eq.margenPp', { pp: prediction.reliability.marginPp }), t('nhlc.bandaJuicio'), ...prediction.reliability.reasons].join('\n')}
              />
            </div>
          </div>

          <div className="mt-2 flex justify-end">
            <EnlacePartido sport="nhl" id={game.id} clave={item.prePartido?.matchKey} />
          </div>
          <EventTrustPanel confianza={item.confianza} prePartido={item.prePartido} />
          <div className="mt-1">
            <Disclosure summary={t('nhlc.porQue')}>
              <StatRow>
                <StatTile
                  label={t('nhlc.a60')}
                  value={pct(prediction.regulation.draw)}
                  hint={t('nhlc.a60Pista', { local: pct(prediction.regulation.home), visitante: pct(prediction.regulation.away) })}
                  title={t('nhlc.a60Titulo')}
                />
                <StatTile
                  label={t('nhlc.masDe', { linea: String(prediction.total.line).replace('.', ',') })}
                  value={pct(prediction.total.over)}
                  hint={prediction.total.push > 0.005 ? t('nhlc.menosYNulo', { u: pct(prediction.total.under), n: pct(prediction.total.push) }) : t('nflc.under', { p: pct(prediction.total.under) })}
                  title={prediction.total.fromMarket ? t('nflc.lineaMercado') : t('nhlc.lineaModelo')}
                />
                <StatTile label={t('nhlc.golesEsperados')} value={String(prediction.goals.total).replace('.', ',')} hint={`${String(prediction.goals.away).replace('.', ',')} – ${String(prediction.goals.home).replace('.', ',')}`} />
                {/* Visitante-local, como el resto de la tarjeta (el servidor lo da local-visitante). */}
                <StatTile label={t('nhlc.marcador60')} value={prediction.scorelines[0] ? `${prediction.scorelines[0].away}-${prediction.scorelines[0].home}` : '—'} hint={t('fbc.masProbable', { p: pct(prediction.scorelines[0]?.probability ?? 0) })} />
              </StatRow>
              <Detail prediction={prediction} />
            </Disclosure>
          </div>
        </>
      ) : (
        <EmptyState title={t('fbc.sinModeloNiCuotas')} tone="warning">
          {t('nhlc.noEncuentro')}
        </EmptyState>
      )}
    </Card>
  );
}

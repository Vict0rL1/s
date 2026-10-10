import type { UfcFightWithPrediction } from '../../lib/ufc';
import { AWAY_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import { Badge, Card, Disclosure, EmptyState, EnlacePartido, HeroStat, MarketGap, MatchTime, ProbabilityBar, ReliabilityChip, ResultBanner, StatRow, StatTile } from '../ui';
import EventTrustPanel from '../trust/EventTrustPanel';
import { Detail, FighterName } from './FightCardPartes';
import { conNodos, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

const coma = (x: number, d = 0) => numF(x, d);

/**
 * Una pelea de la UFC.
 *
 * A a la izquierda y B a la derecha, sin «@»: no hay local (A es el de id de ufcstats menor, un orden
 * que no sabe nada de la pelea). El número grande es el ganador; el empate y el «sin resultado», que
 * son raros, devuelven la apuesta. Debajo, lo que aporta cada rasgo.
 */
export default function FightCard({ item, onOpenFighter }: { item: UfcFightWithPrediction; onOpenFighter: (id: string) => void }) {
  const { t } = useI18n();
  const { fight, prediction, fighters } = item;
  const probs = prediction?.final ?? null;
  const resultado = item.outcome.result;
  const ganador = resultado ? (resultado.homeScore > resultado.awayScore ? fight.home_name : resultado.awayScore > resultado.homeScore ? fight.away_name : null) : null;
  const edad = prediction?.factors.find((f) => f.key === 'edad');
  const alcance = prediction?.factors.find((f) => f.key === 'alcance');

  return (
    <Card as="article" className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-(--ink-muted)">
        <MatchTime iso={fight.commence_time} />
        {fight.books > 0 && <Badge>{t('ufcc.casas', { n: fight.books })}</Badge>}
      </div>

      <ResultBanner
        started={item.outcome.started}
        score={resultado ? (ganador ?? t('ufcc.sinGanador')) : null}
        detail={resultado ? (ganador ? t('ufcc.gano', { nombre: ganador }) : t('ufcc.empateONc')) : null}
        modelCalledIt={prediction && ganador ? (ganador === fight.home_name) === prediction.final.home >= 0.5 : null}
      />

      <div className="mb-3 flex items-start justify-between gap-3">
        <FighterName name={fight.home_name} info={prediction?.fighters.home ?? fighters.home} onClick={fight.home_id ? () => onOpenFighter(fight.home_id!) : undefined} />
        <span className="shrink-0 pt-1 text-[13px] font-medium text-(--ink-faint)">vs</span>
        <FighterName name={fight.away_name} info={prediction?.fighters.away ?? fighters.away} alignRight onClick={fight.away_id ? () => onOpenFighter(fight.away_id!) : undefined} />
      </div>

      {probs && prediction ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <HeroStat value={pct(probs.home)} label={t('ufcc.gana')} sub={fight.odds_home ? t('tt.cuota', { c: numF(fight.odds_home, 2) }) : undefined} color={HOME_COLOR} />
            <HeroStat value={pct(probs.away)} label={t('ufcc.gana')} sub={fight.odds_away ? t('tt.cuota', { c: numF(fight.odds_away, 2) }) : undefined} color={AWAY_COLOR} align="right" />
          </div>
          <div className="mt-2.5">
            <div className="mb-1 flex items-center justify-end">
              <MarketGap model={probs.home} market={prediction.market.market?.home} />
            </div>
            <ProbabilityBar
              segments={[
                { value: probs.home, color: HOME_COLOR, label: fight.home_name },
                { value: probs.away, color: AWAY_COLOR, label: fight.away_name },
              ]}
              marker={prediction.market.market?.home}
            />
            <p className="mt-1 text-[12px] text-(--ink-muted)">{t('ufcc.dosVias')}</p>
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
                <Badge tone="neutral" title={t('ufcc.discrepaTitulo')}>
                  {t('nflc.discrepa', { nombre: prediction.market.verdict === 'differs_home' ? fight.home_name : fight.away_name })}
                </Badge>
              )}
              <ReliabilityChip
                level={prediction.reliability.level}
                label={prediction.reliability.label}
                marginPp={prediction.reliability.marginPp}
                title={[t('eq.margenPp', { pp: prediction.reliability.marginPp }), t('ufcc.bandaJuicio'), ...prediction.reliability.reasons].join('\n')}
              />
            </div>
          </div>

          <div className="mt-2 flex justify-end">
            <EnlacePartido sport="ufc" id={fight.id} clave={item.prePartido?.matchKey} />
          </div>
          <EventTrustPanel confianza={item.confianza} prePartido={item.prePartido} />
          <div className="mt-1">
            <Disclosure summary={t('ufcc.porQue')}>
              <StatRow>
                <StatTile
                  label={t('ufcc.difElo')}
                  value={String(Math.abs(Math.round(prediction.fighters.home.elo - prediction.fighters.away.elo)))}
                  hint={t('ufcc.aFavorDe', { nombre: prediction.fighters.home.elo >= prediction.fighters.away.elo ? fight.home_name : fight.away_name })}
                />
                <StatTile label={t('ufcc.difEdad')} value={edad?.diff != null ? `${coma(Math.abs(edad.diff), 1)}` : '—'} hint={edad?.diff != null ? t('ufcc.masJoven', { nombre: edad.diff < 0 ? fight.home_name : fight.away_name }) : t('ufcc.sinDato')} />
                <StatTile label={t('ufcc.difAlcance')} value={alcance?.diff != null ? `${coma(Math.abs(alcance.diff))} cm` : '—'} hint={alcance?.diff != null ? t('ufcc.masAlcance', { nombre: alcance.diff > 0 ? fight.home_name : fight.away_name }) : t('ufcc.sinDato')} />
                <StatTile label={t('ufcc.peleasUfc')} value={`${prediction.fighters.home.fightsInDb} · ${prediction.fighters.away.fightsInDb}`} />
              </StatRow>
              <Detail prediction={prediction} />
            </Disclosure>
          </div>
        </>
      ) : (
        <EmptyState title={t('ufcc.sinNumero')} tone="warning">
          {item.sinPrediccion ?? t('ufcc.noEncuentro')}
        </EmptyState>
      )}
    </Card>
  );
}

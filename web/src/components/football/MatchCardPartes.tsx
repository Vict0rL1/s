// Piezas de MatchCard.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { type FbFixtureWithPrediction, type FbPrediction } from '../../lib/football';
import { formatDate } from '../../lib/format';
import { AWAY_COLOR, DRAW_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import { BarRow, CompareRow, EmptyState, FactorValue, FormDots, Panel, SectionTitle, TeamCrest } from '../ui';
import ScoreMatrix from './ScoreMatrix';
import { PostprocessPanel } from '../PostprocessPanel';
import ThinMarkets from './ThinMarkets';
import NewsPanel from './NewsPanel';
import SquadPanel from './SquadPanel';
import { conNodos, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

export function TeamName({
  league, id, name, elo, eloRank, seededFrom = null, alignRight = false, homeBadge = false, onClick,
}: {
  league: string; id: string | null; logo?: string | null;
  name: string; elo: number | null; eloRank: number | null; seededFrom?: string | null;
  alignRight?: boolean; homeBadge?: boolean; onClick?: () => void;
}) {
  const { t } = useI18n();
  const logo = null;
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <span className={`flex items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {/* The crest, not the series dot: the dot's job is done one line below
            by the hero label, and two identity marks on one line is one too many. */}
        {!alignRight && <TeamCrest league={league} name={name} code={id} logo={logo} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          // Wraps rather than truncates: at the larger type size the team name
          // no longer fits half a phone-width card, and an ellipsis eats the one
          // thing the card exists to tell you. See nfl/GameCard for the detail.
          className={`max-w-full text-[17px] font-semibold leading-tight break-words text-(--ink-strong) ${
            onClick ? 'hover:underline' : 'cursor-default'
          }`}
          title={onClick ? t('eq.verFicha') : name}
        >
          {name}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} logo={logo} />}
      </span>
      <div className="text-[13px] text-(--ink-muted)">
        {homeBadge && t('eq.localPunto')}
        {elo != null && (
          <>
            Elo {Math.round(elo)}
            {eloRank != null && ` (#${eloRank})`}
          </>
        )}
        {/* Said on the line that carries the number, because it changes what the
            number means: this club has not played a match in this division. */}
        {seededFrom && (
          <span className="ml-1 text-[#c08a2e]" title={t('fbc.trasladado', { liga: seededFrom })}>
            {t('fbc.recienAscendido')}
          </span>
        )}
      </div>
    </div>
  );
}

export function MissingModel({ item }: { item: FbFixtureWithPrediction }) {
  const { t } = useI18n();
  const { fixture } = item;
  const missing = [
    !fixture.home_id ? fixture.home_name : null,
    !fixture.away_id ? fixture.away_name : null,
  ].filter(Boolean) as string[];
  return (
    <EmptyState title={t('fbc.sinModeloNiCuotas')} tone="warning">
      {missing.length > 0 && (
        <>{conNodos(t('fbc.noEncuentro'), { quien: <strong>{missing.join(', ')}</strong> })}</>
      )}
    </EmptyState>
  );
}

/** Full breakdown, all figures drawn from the same score distribution. */
export function Detail({
  prediction, league, outHome, outAway, onOutHome, onOutAway, adjusting, adjusted,
}: {
  prediction: FbPrediction;
  league: string;
  outHome: string[];
  outAway: string[];
  onOutHome: (ids: string[]) => void;
  onOutAway: (ids: string[]) => void;
  adjusting: boolean;
  adjusted: boolean;
}) {
  const { t } = useI18n();
  const { teams, goals, h2h, market, reasoning, reliability, squads, summary } = prediction;
  const home = teams.home;
  const away = teams.away;
  const hasSquads = squads.home !== null || squads.away !== null;
  const formColors = { W: HOME_COLOR, D: DRAW_COLOR, L: AWAY_COLOR };

  return (
    <div className="space-y-3">
      {hasSquads && (
        <Panel>
          <SectionTitle
            right={adjusting ? t('eq.recalculando') : adjusted ? t('fbc.ajustadoBajas') : undefined}
          >
            {t('fbc.quienJuega')}
          </SectionTitle>
          <p className="mb-2.5 text-[13px] leading-relaxed text-(--ink-soft)">
            {t('fbc.lesiones')}
          </p>
          <div className="flex flex-col gap-4 sm:flex-row">
            <SquadPanel
              league={league} side="home" teamId={home.id} teamName={home.name}
              color={HOME_COLOR} availability={squads.home} out={outHome} onChange={onOutHome}
            />
            <SquadPanel
              league={league} side="away" teamId={away.id} teamName={away.name}
              color={AWAY_COLOR} availability={squads.away} out={outAway} onChange={onOutAway}
            />
          </div>
        </Panel>
      )}

      <NewsPanel prediction={prediction} />

      <ScoreMatrix prediction={prediction} />

      <Panel>
        <SectionTitle>{t('det.porQue')}</SectionTitle>
        <p className="mb-2 text-[15px] leading-relaxed text-(--ink-body)">{reasoning.text}</p>
        <dl className="space-y-1 text-[13px]">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="flex justify-between gap-3">
              <dt className="text-(--ink-soft)">{f.label}</dt>
              <dd>
                <FactorValue
                  color={f.pointsForHome >= 0 ? HOME_COLOR : AWAY_COLOR}
                  neutral={f.pointsForHome === 0}
                >
                  {f.pointsForHome === 0
                    ? t('eq.neutral')
                    : t('eq.paraEquipo', { n: Math.abs(f.pointsForHome), equipo: f.pointsForHome > 0 ? home.name : away.name })}
                </FactorValue>
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel>
        <SectionTitle>{t('fbc.marcadoresProbables')}</SectionTitle>
        <div className="space-y-1">
          {goals.scorelines.map((s) => (
            <BarRow
              key={s.label}
              label={s.label}
              value={s.probability}
              max={goals.scorelines[0].probability}
              color={s.home > s.away ? HOME_COLOR : s.home === s.away ? DRAW_COLOR : AWAY_COLOR}
              valueLabel={pct(s.probability)}
            />
          ))}
        </div>
      </Panel>

      <Panel>
        <SectionTitle>{t('eq.losDosEquipos')}</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
          <div />
          <div className="w-24 break-words text-right font-medium" style={{ color: HOME_COLOR }}>
            {home.name}
          </div>
          <div className="w-24 break-words text-right font-medium" style={{ color: AWAY_COLOR }}>
            {away.name}
          </div>
          <CompareRow label="Elo" left={Math.round(home.elo)} right={Math.round(away.elo)} />
          <CompareRow label={t('fbc.gfPartido')} left={home.gf ?? '—'} right={away.gf ?? '—'} />
          <CompareRow label={t('fbc.gcPartido')} left={home.ga ?? '—'} right={away.ga ?? '—'} />
          <CompareRow
            label={t('fbc.balance')}
            left={`${home.record.wins}-${home.record.draws}-${home.record.losses}`}
            right={`${away.record.wins}-${away.record.draws}-${away.record.losses}`}
          />
          <CompareRow
            label={t('eq.ultimos5')}
            title={t('fbc.coloresForma')}
            left={<FormDots results={home.last5} colors={formColors} />}
            right={<FormDots results={away.last5} colors={formColors} />}
          />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle
          right={
            <>
              <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
              <span className="text-(--ink-faint)"> · {h2h.draws} · </span>
              <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
              <span className="ml-1.5 text-(--ink-faint)">({h2h.total})</span>
            </>
          }
        >
          {t('eq.historialDirecto')}
        </SectionTitle>
        {h2h.recent.length === 0 ? (
          <p className="text-[13px] text-(--ink-muted)">{t('det.sinEnfrentamientos')}</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between gap-3 text-(--ink-body)">
                <span className="shrink-0 text-(--ink-muted)">{formatDate(m.date)}</span>
                <span className="break-words text-right">
                  {m.homeId === home.id ? home.name : away.name} {m.homeGoals}–{m.awayGoals}{' '}
                  {m.awayId === away.id ? away.name : home.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ThinMarkets prediction={prediction} />

      <Panel>
        <SectionTitle>{t('eq.deDondeNumero')}</SectionTitle>
        <PostprocessPanel
          postprocess={prediction.postprocess}
          rows={[
            { label: t('fbc.local'), raw: prediction.model.home, final: prediction.final.home },
            { label: t('fbc.empate'), raw: prediction.model.draw, final: prediction.final.draw },
            { label: t('fbc.visitante'), raw: prediction.model.away, final: prediction.final.away },
          ]}
        />
      </Panel>

      {market.market && (
        <Panel>
          <SectionTitle right={t('eq.margenPct', { p: numF((market.market.overround - 1) * 100, 1) })}>
            {t('eq.mercado')}
          </SectionTitle>
          <p className="text-[13px] leading-relaxed text-(--ink-body)">
            {t('fbc.cuotasLinea', {
              a: market.market.odds.home,
              x: market.market.odds.draw,
              b: market.market.odds.away,
              pa: pct(market.market.home),
              px: pct(market.market.draw),
              pb: pct(market.market.away),
            })}
          </p>
        </Panel>
      )}

      <Panel>
        <SectionTitle>{t('eq.lecturaCompleta')}</SectionTitle>
        <ul className="space-y-1.5">
          {summary.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-(--ink-soft)">
              <span aria-hidden className="text-(--ink-faint)">
                •
              </span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <div
        className={`rounded-xl border p-3 text-[14px] ${
          reliability.level === 'high'
            ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
            : reliability.level === 'medium'
              ? 'border-amber-500/25 bg-amber-500/[0.06]'
              : 'border-rose-500/25 bg-rose-500/[0.06]'
        }`}
      >
        <p className="text-(--ink-body)">
          <strong className="capitalize">{reliability.label}</strong>{' '}
          {t('eq.margenDetalle', { pp: reliability.marginPp, a: reliability.matchesBehind.home, b: reliability.matchesBehind.away })}
        </p>
        {reliability.reasons.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {reliability.reasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-[13px] text-(--ink-soft)">
                <span aria-hidden className="text-(--ink-faint)">
                  •
                </span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[13px] leading-relaxed text-(--ink-muted)">{prediction.disclaimer}</p>
    </div>
  );
}

/** Which of the three the model rated highest. */
export function topOutcome(m: { home: number; draw: number; away: number }): 'home' | 'draw' | 'away' {
  if (m.draw >= m.home && m.draw >= m.away) return 'draw';
  return m.home >= m.away ? 'home' : 'away';
}

/** Which of the three actually happened. */
export function actualOutcome(r: { homeScore: number; awayScore: number }): 'home' | 'draw' | 'away' {
  if (r.homeScore === r.awayScore) return 'draw';
  return r.homeScore > r.awayScore ? 'home' : 'away';
}

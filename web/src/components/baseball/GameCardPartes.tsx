// Piezas de GameCard.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { useEffect, useState } from 'react';
import { bsbApi, type BsbGameWithPrediction, type BsbPitcher, type BsbPrediction, type BsbSide } from '../../lib/baseball';
import { formatDate } from '../../lib/format';
import { AWAY_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import { BarRow, CompareRow, EmptyState, FactorValue, FormDots, Panel, SectionTitle, SeriesDot, TeamCrest } from '../ui';
import RunMatrix from './RunMatrix';
import { conNodos, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

export function StarterChip({ side, color }: { side: BsbSide; color: string }) {
  const { t } = useI18n();
  const s = side.starter;
  const delta = s.rating != null ? Math.round((1 - s.rating) * 100) : null;
  return (
    <div className="min-w-0" title={s.label}>
      {/* The delta sits NEXT to the label, not pushed to the column's far edge:
          spread across half a card it landed beside the OTHER starter's label and
          read as belonging to them. */}
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">
          {t('bsd.abridor')}
        </span>
        {delta != null && Math.abs(delta) >= 4 && (
          <span
            className="shrink-0 text-[11px] font-semibold tabular-nums"
            style={{ color: delta > 0 ? 'var(--profit-text)' : 'var(--status-critical)' }}
            title={t('bsd.carrerasTitulo')}
          >
            {t('bsd.pctCarreras', { n: `${delta > 0 ? '−' : '+'}${Math.abs(delta)}` })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <SeriesDot color={color} />
        {/* The pitcher's name wraps: he is the single biggest named factor on a
            baseball card, and "Madison Bumga…" in a two-column grid is the one
            thing here that must not be elided. */}
        <span className="min-w-0 break-words text-[15px] font-semibold leading-tight text-(--ink-strong)">
          {s.name ?? t('bsd.sinAnunciar')}
        </span>
      </div>
      <div className="text-[11px] text-(--ink-muted)">
        {s.starts > 0 ? t('bsd.aperturas', { n: s.starts }) : t('td.sinDatos')}
      </div>
    </div>
  );
}

export function TeamName({
  league, id, name, elo, eloRank, odds, alignRight = false, homeBadge = false, onClick,
}: {
  league: string; id: string | null;
  name: string; elo: number | null; eloRank: number | null;
  odds: number | null; alignRight?: boolean; homeBadge?: boolean; onClick?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <span className={`flex items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {/* The crest, not the series dot: the dot's job is done one line below
            by the hero label, and two identity marks on one line is one too many. */}
        {!alignRight && <TeamCrest league={league} name={name} code={id} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          // Wraps rather than truncates: at the larger type size the team name
          // no longer fits half a phone-width card, and an ellipsis eats the one
          // thing the card exists to tell you. See nfl/GameCard for the detail.
          className={`max-w-full text-[17px] font-semibold break-words text-(--ink-strong) ${onClick ? 'hover:underline' : 'cursor-default'}`}
          title={onClick ? t('eq.verFicha') : undefined}
        >
          {name}
          {homeBadge && <span className="ml-1.5 text-[11px] text-(--ink-muted)">{t('bsd.local')}</span>}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} />}
      </span>
      <div className="text-[13px] text-(--ink-muted)">
        {elo != null && <>Elo {Math.round(elo)}{eloRank != null && ` (#${eloRank})`}</>}
        {odds != null && <> · {t('tt.cuota', { c: odds })}</>}
      </div>
    </div>
  );
}


export function MissingModel({ item }: { item: BsbGameWithPrediction }) {
  const { t } = useI18n();
  const { game } = item;
  const missing = [
    !game.away_id ? game.away_name : null,
    !game.home_id ? game.home_name : null,
  ].filter(Boolean) as string[];
  return (
    <EmptyState title={t('fbc.sinModeloNiCuotas')} tone="warning">
      {missing.length > 0 && (
        <>{conNodos(t('bsd.noEncuentro'), { quien: <strong>{missing.join(', ')}</strong> })}</>
      )}
    </EmptyState>
  );
}

/** Pick a starter by hand — the one input that beats the model's guess. */
export function StarterPicker({
  league, teamId, teamName, color, value, announced, onChange,
}: {
  league: string;
  teamId: string;
  teamName: string;
  color: string;
  value: string | null | undefined;
  announced: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const [rotation, setRotation] = useState<BsbPitcher[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    bsbApi
      .rotation(league, teamId)
      .then((r) => live && setRotation(r.pitchers))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [league, teamId]);

  if (error) return <p className="text-[13px] text-(--ink-muted)">{t('bsd.sinLanzadores')}</p>;
  const current = value !== undefined ? value : announced;

  return (
    <div className="min-w-0 flex-1">
      <label className="mb-1 block break-words text-[14px] font-semibold" style={{ color }}>
        {teamName}
      </label>
      <select
        value={current ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded border border-(--line-strong) bg-(--surface-card) px-2 py-1 text-[14px] text-(--ink-body)"
        aria-label={t('bsd.abridorDe', { equipo: teamName })}
      >
        <option value="">{t('bsd.sinAbridor')}</option>
        {(rotation ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {t('bsd.opcion', {
              nombre: p.name,
              n: p.starts,
              r: p.rating != null ? `${p.rating < 1 ? '−' : '+'}${numF(Math.abs(Math.round((p.rating - 1) * 100)), 0)}\u00a0%` : t('bsd.sd'),
            })}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Detail({
  prediction, league, homeSp, awaySp, onHomeSp, onAwaySp, adjusting, adjusted,
}: {
  prediction: BsbPrediction;
  league: string;
  homeSp: string | null | undefined;
  awaySp: string | null | undefined;
  onHomeSp: (id: string | null) => void;
  onAwaySp: (id: string | null) => void;
  adjusting: boolean;
  adjusted: boolean;
}) {
  const { t } = useI18n();
  const { teams, runs, h2h, market, reasoning, reliability } = prediction;
  const home = teams.home;
  const away = teams.away;
  const formColors = { W: HOME_COLOR, D: '#64748b', L: AWAY_COLOR };
  return (
    <div className="space-y-3">
      <Panel>
        <SectionTitle right={adjusting ? t('eq.recalculando') : adjusted ? t('bsd.ajustadoEleccion') : undefined}>
          {t('bsd.quienAbre')}
        </SectionTitle>
        <p className="mb-2.5 text-[13px] leading-relaxed text-(--ink-soft)">
          {t('bsd.abridorExplica')}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <StarterPicker
            league={league} teamId={away.id} teamName={away.name} color={AWAY_COLOR}
            value={awaySp} announced={away.starter.id} onChange={onAwaySp}
          />
          <StarterPicker
            league={league} teamId={home.id} teamName={home.name} color={HOME_COLOR}
            value={homeSp} announced={home.starter.id} onChange={onHomeSp}
          />
        </div>
      </Panel>

      <RunMatrix prediction={prediction} />

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
          {t('eq.margenDetalle', { pp: reliability.marginPp, a: reliability.gamesBehind.away, b: reliability.gamesBehind.home })}
        </p>
        {reliability.reasons.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {reliability.reasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-[13px] text-(--ink-soft)">
                <span aria-hidden className="text-(--ink-faint)">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

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
        <SectionTitle>{t('eq.losDosEquipos')}</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
          <div />
          <div className="w-24 break-words text-right font-medium" style={{ color: AWAY_COLOR }}>
            {away.name}
          </div>
          <div className="w-24 break-words text-right font-medium" style={{ color: HOME_COLOR }}>
            {home.name}
          </div>
          <CompareRow label="Elo" left={Math.round(away.elo)} right={Math.round(home.elo)} />
          <CompareRow label={t('bsd.cfPartido')} left={away.rs ?? '—'} right={home.rs ?? '—'} />
          <CompareRow label={t('bsd.ccPartido')} left={away.ra ?? '—'} right={home.ra ?? '—'} />
          <CompareRow
            label={t('bsd.pitagorico')}
            title={t('bsd.pitagoricoTitulo')}
            left={away.pythagorean != null ? pct(away.pythagorean) : '—'}
            right={home.pythagorean != null ? pct(home.pythagorean) : '—'}
          />
          <CompareRow
            label={t('bsd.balance')}
            left={`${away.record.wins}-${away.record.losses}`}
            right={`${home.record.wins}-${home.record.losses}`}
          />
          <CompareRow
            label={t('bsd.ultimos10')}
            title={t('bsd.coloresForma')}
            left={<FormDots results={away.last10} colors={formColors} />}
            right={<FormDots results={home.last10} colors={formColors} />}
          />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle>{t('fbc.marcadoresProbables')}</SectionTitle>
        <div className="space-y-1">
          {runs.scorelines.map((s) => (
            <BarRow
              key={s.label}
              label={`${s.away}-${s.home}`}
              value={s.probability}
              max={runs.scorelines[0].probability}
              color={s.home > s.away ? HOME_COLOR : AWAY_COLOR}
              valueLabel={pct(s.probability)}
            />
          ))}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">
          {t('bsd.fijate')}
        </p>
      </Panel>

      <Panel>
        <SectionTitle
          right={
            <>
              <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
              <span className="text-(--ink-faint)"> · </span>
              <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
              <span className="ml-1.5 text-(--ink-faint)">({h2h.total})</span>
            </>
          }
        >
          {t('eq.historialDirecto')}
        </SectionTitle>
        {h2h.recent.length === 0 ? (
          <p className="text-[13px] text-(--ink-muted)">{t('bsd.sinEnfrentamientos')}</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between gap-3 text-(--ink-body)">
                <span className="shrink-0 text-(--ink-muted)">{formatDate(m.date)}</span>
                <span className="break-words text-right">
                  {m.awayId === away.id ? away.name : home.name} {m.awayRuns}–{m.homeRuns}{' '}
                  {m.homeId === home.id ? home.name : away.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {market.market && (
        <Panel>
          <SectionTitle right={t('eq.margenPct', { p: numF((market.market.overround - 1) * 100, 1) })}>
            {t('eq.mercado')}
          </SectionTitle>
          <p className="text-[13px] leading-relaxed text-(--ink-body)">
            {t('bsd.cuotasLinea', {
              a: market.market.odds.away,
              h: market.market.odds.home,
              pa: pct(market.market.away),
              ph: pct(market.market.home),
            })}
          </p>
        </Panel>
      )}

      <Panel>
        <SectionTitle>{t('eq.lecturaCompleta')}</SectionTitle>
        <ul className="space-y-1.5">
          {prediction.summary.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-(--ink-soft)">
              <span aria-hidden className="text-(--ink-faint)">•</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <p className="text-[13px] leading-relaxed text-(--ink-muted)">{prediction.disclaimer}</p>
    </div>
  );
}

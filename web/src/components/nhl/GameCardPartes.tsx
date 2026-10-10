// Piezas de la tarjeta de la NHL: el desglose del «¿por qué?».
import type { NhlPrediction } from '../../lib/nhl';
import { AWAY_COLOR, HOME_COLOR, NEUTRAL_COLOR, pct } from '../../lib/theme';
import { BarRow, CompareRow, FactorValue, FormDots, Panel, SectionTitle, TeamCrest } from '../ui';
import { useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

const coma = (x: number) => String(x).replace('.', ',');

export function Detail({ prediction }: { prediction: NhlPrediction }) {
  const { t } = useI18n();
  const { teams, total, scorelines, h2h, market, reasoning, regulation, goals } = prediction;
  const home = teams.home;
  const away = teams.away;
  const formColors = { W: HOME_COLOR, D: NEUTRAL_COLOR, L: AWAY_COLOR };
  const maxScore = Math.max(...scorelines.map((s) => s.probability));
  const record = (r: { wins: number; losses: number }) => `${r.wins}-${r.losses}`;

  return (
    <div className="space-y-3">
      <Panel>
        <SectionTitle>{t('det.porQue')}</SectionTitle>
        <ul className="mb-2 list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-(--ink-body)">
          {prediction.summary.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <dl className="space-y-1 text-[13px]">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="flex justify-between gap-3">
              <dt className="text-(--ink-soft)">{f.key === 'home' ? t('nhld.factorCampo') : t('nhld.factorElo')}</dt>
              <dd>
                <FactorValue color={f.pointsForHome >= 0 ? HOME_COLOR : AWAY_COLOR} neutral={f.pointsForHome === 0}>
                  {f.pointsForHome === 0 ? t('eq.neutral') : t('nhld.eloPara', { n: Math.round(Math.abs(f.pointsForHome)), equipo: f.pointsForHome > 0 ? home.name : away.name })}
                </FactorValue>
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      {/* El partido a 60 minutos: la mitad de las apuestas de hockey se hacen a este mercado (1X2). */}
      <Panel>
        <SectionTitle right={t('nhld.vaALaProrroga', { p: pct(regulation.draw) })}>{t('nhld.a60Titulo')}</SectionTitle>
        <div className="space-y-1">
          <BarRow label={away.name} value={regulation.away} max={Math.max(regulation.home, regulation.away, regulation.draw)} color={AWAY_COLOR} valueLabel={pct(regulation.away)} />
          <BarRow label={t('nhld.empate')} value={regulation.draw} max={Math.max(regulation.home, regulation.away, regulation.draw)} color={NEUTRAL_COLOR} valueLabel={pct(regulation.draw)} />
          <BarRow label={home.name} value={regulation.home} max={Math.max(regulation.home, regulation.away, regulation.draw)} color={HOME_COLOR} valueLabel={pct(regulation.home)} />
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">{t('nhld.prorrogaNota')}</p>
      </Panel>

      <Panel>
        <SectionTitle right={t('nhld.esperadosActa', { n: coma(goals.total) })}>{t('nhld.totalGoles')}</SectionTitle>
        <div className="flex items-center gap-3 text-[13px]">
          <span className="w-20 shrink-0 text-(--ink-soft)">{t('nhld.mas', { linea: coma(total.line) })}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-(--raised)">
            <div className="h-full rounded-full" style={{ width: `${total.over * 100}%`, backgroundColor: HOME_COLOR }} />
          </div>
          <span className="w-28 shrink-0 text-right tabular-nums text-(--ink-soft)">
            {pct(total.over)} / {pct(total.under)}
            {total.push > 0.005 ? ` / ${pct(total.push)}` : ''}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">
          {total.fromMarket ? t('nhld.lineaCasa') : t('nhld.lineaModelo')} {t('nhld.actaNota')}
        </p>
      </Panel>

      <Panel>
        <SectionTitle>{t('nhld.marcadores60')}</SectionTitle>
        <div className="space-y-1">
          {scorelines.map((s) => (
            <BarRow
              key={s.label}
              label={`${away.id} ${s.away}-${s.home} ${home.id}`}
              title={`${away.name} ${s.away}-${s.home} ${home.name}`}
              value={s.probability}
              max={maxScore}
              color={s.home > s.away ? HOME_COLOR : s.home === s.away ? NEUTRAL_COLOR : AWAY_COLOR}
              valueLabel={pct(s.probability)}
            />
          ))}
        </div>
      </Panel>

      <Panel>
        <SectionTitle>{t('eq.losDosEquipos')}</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
          <div />
          <div className="flex w-20 items-center justify-end gap-1.5 font-medium text-(--ink-strong)">
            <span className="break-words">{away.name}</span>
            <TeamCrest league="nhl" name={away.name} code={away.id} size={14} />
          </div>
          <div className="flex w-20 items-center justify-end gap-1.5 font-medium text-(--ink-strong)">
            <span className="break-words">{home.name}</span>
            <TeamCrest league="nhl" name={home.name} code={home.id} size={14} />
          </div>
          <CompareRow label="Elo" left={`${Math.round(away.elo)} (#${away.eloRank})`} right={`${Math.round(home.elo)} (#${home.eloRank})`} />
          <CompareRow label={t('nhld.golesFavor')} left={away.goalsFor != null ? coma(away.goalsFor) : '—'} right={home.goalsFor != null ? coma(home.goalsFor) : '—'} />
          <CompareRow label={t('nhld.golesContra')} left={away.goalsAgainst != null ? coma(away.goalsAgainst) : '—'} right={home.goalsAgainst != null ? coma(home.goalsAgainst) : '—'} />
          <CompareRow label={t('nhld.balanceTemporada')} left={record(away.record)} right={record(home.record)} />
          <CompareRow label={t('nhld.fueraCasa')} left={record(away.awayRecord)} right={record(home.homeRecord)} />
          <CompareRow label={t('eq.ultimos5')} left={<FormDots results={away.last5} colors={formColors} />} right={<FormDots results={home.last5} colors={formColors} />} />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle right={`${h2h.awayWins} · ${h2h.homeWins} (${h2h.total})`}>{t('eq.historialDirecto')}</SectionTitle>
        {h2h.recent.length === 0 ? (
          <p className="text-[13px] text-(--ink-muted)">{t('nfld.sinEnfrentamientos')}</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {h2h.recent.map((m) => (
              <li key={`${m.date}-${m.homeId}`} className="flex justify-between gap-3 text-(--ink-body)">
                <span className="shrink-0 text-(--ink-muted)">{m.date}</span>
                <span className="break-words text-right">
                  {m.awayId === away.id ? away.name : home.name} {m.awayGoals}–{m.homeGoals} {m.homeId === home.id ? home.name : away.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <SectionTitle>{t('eq.deDondeNumero')}</SectionTitle>
        {/* No el panel común de post-proceso: ese habla de calibradores probados, y en la NHL no se probó ninguno. */}
        <p className="text-[13px] leading-relaxed text-(--ink-body)">{t('nhld.sinMezcla')}</p>
      </Panel>

      {market.market && (
        <Panel>
          <SectionTitle right={t('eq.margenPct', { p: numF((market.market.overround - 1) * 100, 1) })}>{t('eq.mercado')}</SectionTitle>
          <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
            <div />
            <div className="w-20 text-right font-medium text-(--ink-strong)">{t('nhld.casa')}</div>
            <div className="w-20 text-right font-medium text-(--ink-strong)">{t('nhld.modelo')}</div>
            <CompareRow label={away.name} left={pct(market.market.away)} right={pct(prediction.final.away)} />
            <CompareRow label={home.name} left={pct(market.market.home)} right={pct(prediction.final.home)} />
          </dl>
          <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">{t('nhld.desacuerdoNota')}</p>
        </Panel>
      )}

      <p className="text-[12px] leading-relaxed text-(--ink-muted)">{prediction.disclaimer}</p>
    </div>
  );
}

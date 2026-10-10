// Piezas de BetsDashboard.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { ClvPropio, Etiquetas, LoHabriaApostado } from './ExtrasApuesta';
import { useState } from 'react';
import { deporteDe, estadoDe, mercadoDe, money, pctSigned, signed, type Bet, type BetStatus, type BetSummary } from '../../lib/bets';
import { useI18n } from '../../i18n';
import { NEUTRAL_TEXT, PROFIT_TEXT, LOSS_TEXT } from '../../lib/theme';
import { Card, SectionTitle } from '../ui';
import { pct as pctF, num as numF } from '../../lib/formato';

export function Headline({ summary }: { summary: BetSummary }) {
  const tot = summary.totals;
  const { t } = useI18n();
  const tone = tot.profit > 0 ? PROFIT_TEXT : tot.profit < 0 ? LOSS_TEXT : NEUTRAL_TEXT;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">
            {t('registro.beneficio')}
          </span>
          <span className="block text-[26px] font-bold leading-none tabular-nums" style={{ color: tone }}>
            {signed(tot.profit)}
          </span>
        </div>
        <div className="text-right">
          <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">
            {t('registro.roi')}
          </span>
          <span className="block text-[26px] font-bold leading-none tabular-nums" style={{ color: tone }}>
            {tot.roi == null ? '—' : pctSigned(tot.roi)}
          </span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-(--line) pt-3 sm:grid-cols-4">
        <Stat label={t('registro.apostado')} value={money(tot.staked)} hint={t(tot.bets === 1 ? 'registro.apuestas1' : 'registro.apuestasN', { n: tot.bets })} />
        <Stat
          label={t('registro.acierto')}
          value={tot.hitRate == null ? '—' : `${pctF(tot.hitRate, 0)}`}
          hint={`${tot.wins}-${tot.losses}`}
        />
        <Stat
          label={t('registro.pendientes')}
          value={String(summary.pending.bets)}
          hint={summary.pending.bets ? t('registro.enJuego', { d: money(summary.pending.staked) }) : t('registro.nadaEnJuego')}
        />
        <Stat
          label={t('registro.rachas')}
          value={`${summary.longestWinStreak}W / ${summary.longestLoseStreak}L`}
          hint={t('registro.rachasNota')}
        />
      </div>
      {/* ROI is over stake AT RISK, and saying so matters: a run of voids would
          otherwise look like it had quietly dragged the number down. */}
      <p className="mt-2 text-[11px] leading-relaxed text-(--ink-muted)">
        {t('registro.roiNota', { d: money(tot.risked) })}
      </p>
    </>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-(--ink-strong)">{value}</div>
      {hint && <div className="text-[11px] tabular-nums text-(--ink-muted)">{hint}</div>}
    </div>
  );
}

/**
 * Did following the model help?
 *
 * The one thing this log can say that a bookmaker's own history cannot. Withheld
 * below ten answerable bets by the server, because a split over four bets is noise
 * with a headline on it.
 */
export function ModelAgreement({ summary }: { summary: BetSummary }) {
  const a = summary.modelAgreement!;
  const { t } = useI18n();
  const row = (g: typeof a.with, label: string) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[14px] text-(--ink-soft)">
        {label} <span className="text-(--ink-faint)">{t('registro.nApuestas', { n: g.bets })}</span>
      </span>
      <span
        className="text-[16px] font-semibold tabular-nums"
        style={{ color: g.profit > 0 ? PROFIT_TEXT : g.profit < 0 ? LOSS_TEXT : NEUTRAL_TEXT }}
      >
        {signed(g.profit)}
        <span className="ml-2 text-[13px] font-normal text-(--ink-muted)">
          {g.roi == null ? '' : pctSigned(g.roi)}
        </span>
      </span>
    </div>
  );
  return (
    <Card className="p-4">
      <SectionTitle right={t('registro.discrepaban')}>{t('registro.seguirModelo')}</SectionTitle>
      {row(a.with, t('registro.conModelo'))}
      {row(a.against, t('registro.contraModelo'))}
      <p className="mt-2 text-[11px] leading-relaxed text-(--ink-muted)">
        {t('registro.acuerdoNota')}
      </p>
    </Card>
  );
}

export function Breakdown({ summary }: { summary: BetSummary }) {
  const { t } = useI18n();
  const group = (
    title: string,
    rows: BetSummary['bySport'],
    label: (k: string) => string,
  ) => (
    <div className="min-w-0 flex-1">
      <SectionTitle>{title}</SectionTitle>
      <div className="space-y-1">
        {rows.map((g) => (
          <div key={g.key} className="flex items-baseline justify-between gap-3">
            <span className="break-words text-[14px] text-(--ink-soft)">
              {label(g.key)} <span className="text-(--ink-faint)">{g.bets}</span>
            </span>
            <span
              className="shrink-0 text-[14px] font-semibold tabular-nums"
              style={{ color: g.profit > 0 ? PROFIT_TEXT : g.profit < 0 ? LOSS_TEXT : NEUTRAL_TEXT }}
            >
              {signed(g.profit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
        {summary.bySport.length > 1 && group(t('registro.porDeporte'), summary.bySport, (k) => deporteDe(t, k))}
        {summary.byMarket.length > 1 && group(t('registro.porMercado'), summary.byMarket, (k) => mercadoDe(t, k))}
      </div>
    </Card>
  );
}

export function DayTotal({ bets }: { bets: Bet[] }) {
  const settled = bets.filter((b) => b.profit != null);
  const { t } = useI18n();
  if (settled.length === 0) return <span className="text-[13px] text-(--ink-muted)">{t('registro.sinResolver')}</span>;
  const net = settled.reduce((s, b) => s + (b.profit as number), 0);
  return (
    <span
      className="text-[13px] font-semibold tabular-nums"
      style={{ color: net > 0 ? PROFIT_TEXT : net < 0 ? LOSS_TEXT : NEUTRAL_TEXT }}
    >
      {signed(net)}
    </span>
  );
}

export const SETTLE_OPTIONS: BetStatus[] = ['won', 'lost', 'void', 'half_won', 'half_lost', 'cashout'];

export function BetRow({
  bet,
  minEdge,
  onSettle,
  onEdit,
  onDelete,
}: {
  bet: Bet;
  minEdge: number | null;
  onSettle: (b: Bet, s: BetStatus) => void;
  onEdit: (b: Bet) => void;
  onDelete: (b: Bet) => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const tone =
    bet.profit == null
      ? NEUTRAL_TEXT
      : bet.profit > 0
        ? PROFIT_TEXT
        : bet.profit < 0
          ? LOSS_TEXT
          : NEUTRAL_TEXT;

  return (
    <Card className="p-3">
      {/* A 3px bar on the left carries win/loss redundantly with the number, so the
          list scans without relying on reading each figure. */}
      <div className="flex gap-3">
        <span
          aria-hidden
          className="w-[3px] shrink-0 self-stretch rounded-full"
          style={{ backgroundColor: bet.profit == null ? 'var(--line-strong)' : tone }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="break-words text-[16px] font-semibold leading-tight text-(--ink-strong)">
                {bet.selection}
              </div>
              <div className="mt-0.5 break-words text-[13px] text-(--ink-soft)">{bet.event}</div>
              <div className="mt-0.5 text-[11px] uppercase tracking-[0.06em] text-(--ink-faint)">
                {deporteDe(t, bet.sport)} · {mercadoDe(t, bet.market)}
                {bet.withModel != null && (
                  <span style={{ color: bet.withModel ? PROFIT_TEXT : LOSS_TEXT }}>
                    {' '}
                    · {bet.withModel ? t('registro.conElModelo') : t('registro.contraElModelo')}
                  </span>
                )}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[16px] font-semibold tabular-nums" style={{ color: tone }}>
                {bet.profit == null ? estadoDe(t, bet.status) : signed(bet.profit)}
              </div>
              <div className="text-[13px] tabular-nums text-(--ink-muted)">
                {money(bet.stake)} @ {bet.odds}
              </div>
            </div>
          </div>

          {bet.status === 'pending' ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SETTLE_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSettle(bet, s)}
                  className="rounded-md px-2.5 py-1 text-[13px] text-(--ink-body) ring-1 ring-inset ring-(--line) transition hover:bg-(--raised-2) hover:text-(--ink-strong)"
                >
                  {estadoDe(t, s)}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-3 text-[13px]">
              <span className="text-(--ink-muted)">{estadoDe(t, bet.status)}</span>
              <button onClick={() => setOpen((o) => !o)} className="text-(--ink-soft) hover:text-(--ink-strong)">
                {open ? t('registro.menos') : t('registro.mas')}
              </button>
            </div>
          )}

          {(open || bet.status === 'pending') && (
            <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-(--line) pt-2 text-[13px]">
              {bet.model_prob != null && (
                <span className="text-(--ink-muted)">
                  {t('registro.modeloPct', { p: numF(bet.model_prob * 100, 0) })}
                  {bet.market_prob != null && t('registro.mercadoPct', { p: numF(bet.market_prob * 100, 0) })}
                </span>
              )}
              {bet.notes && <span className="text-(--ink-soft)">{bet.notes}</span>}
              <Etiquetas tags={bet.tags} />
              <LoHabriaApostado bet={bet} minEdge={minEdge} />
              {open && <ClvPropio id={bet.id} />}
              <button onClick={() => onEdit(bet)} className="text-(--ink-soft) hover:text-(--ink-strong)">
                {t('registro.editar')}
              </button>
              <button onClick={() => onDelete(bet)} className="text-(--ink-soft) hover:text-[#d95926]">
                {t('registro.borrar')}
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

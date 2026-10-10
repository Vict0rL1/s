import { useMemo, useState } from 'react';
import { BREAK_EVEN_COLOR, LOSS_COLOR, PROFIT_COLOR, NEUTRAL_TEXT, PROFIT_TEXT, LOSS_TEXT } from '../../lib/theme';
import { signed } from '../../lib/bets';
import { useI18n } from '../../i18n';

/**
 * A month of daily results, as a diverging heat map.
 *
 * FORM. The question is "how did the month go, and which days did the damage" —
 * polarity plus magnitude across a calendar. A calendar grid answers it in a way a
 * bar chart cannot, because the weekday pattern is part of the answer: Sundays and
 * Mondays look different from Wednesdays if you bet the NFL.
 *
 * COLOUR. A diverging scale: green pole for profit, orange for loss, gray for
 * break-even. Green↔orange rather than the usual green↔red because red-green is
 * the worst pair for the commonest colour blindness — see theme.ts, where the pair
 * is validated against this surface.
 *
 * MAGNITUDE is opacity within the pole, scaled to the month's own biggest day.
 * Scaled per month on purpose: the useful comparison is "which day of THIS month
 * was heavy", and a fixed scale would make a quiet month uniformly invisible.
 *
 * COLOUR IS NEVER ALONE. Every day with settled bets prints its signed amount, so
 * the sign carries the polarity and the number carries the magnitude even if the
 * hues are indistinguishable. Days with no bets are empty, not zero — a 0 would
 * claim you broke even on a day you did not play.
 */
export default function BetCalendar({
  daily,
  onPickDay,
  selectedDay,
}: {
  daily: { day: string; profit: number; bets: number; settled: number; staked: number }[];
  onPickDay?: (day: string | null) => void;
  selectedDay?: string | null;
}) {
  const byDay = useMemo(() => new Map(daily.map((d) => [d.day, d])), [daily]);
  const { t, idioma } = useI18n();

  // Open on the most recent month that has anything in it, not on today: a tracker
  // you come back to after a fortnight should show the fortnight, not a blank grid.
  const initial = useMemo(() => {
    const last = daily.at(-1)?.day;
    const d = last ? new Date(`${last}T12:00:00`) : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [daily]);
  const [view, setView] = useState(initial);

  const { cells, monthProfit, monthBets, maxAbs, label } = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
    // Monday-first, which is the week Spain reads.
    const lead = (first.getDay() + 6) % 7;

    const out: ({ day: string; profit: number; bets: number; settled: number; staked: number; dom: number } | null)[] =
      Array.from({ length: lead }, () => null);
    let profit = 0;
    let bets = 0;
    let max = 0;
    const p = (n: number) => String(n).padStart(2, '0');
    for (let dom = 1; dom <= daysInMonth; dom++) {
      const key = `${view.year}-${p(view.month + 1)}-${p(dom)}`;
      const d = byDay.get(key);
      if (d) {
        profit += d.profit;
        bets += d.bets;
        max = Math.max(max, Math.abs(d.profit));
      }
      out.push({ day: key, dom, profit: d?.profit ?? 0, bets: d?.bets ?? 0, settled: d?.settled ?? 0, staked: d?.staked ?? 0 });
    }
    return {
      cells: out,
      monthProfit: Math.round(profit * 100) / 100,
      monthBets: bets,
      maxAbs: max,
      // Capitalised HERE, not with CSS `capitalize`, which title-cases every word
      // and turned "agosto de 2026" into "Agosto De 2026".
      label: upperFirst(first.toLocaleDateString(idioma === 'en' ? 'en-GB' : 'es', { month: 'long', year: 'numeric' })),
    };
  }, [view, byDay, idioma]);

  const step = (delta: number) => {
    const d = new Date(view.year, view.month + delta, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => step(-1)}
            aria-label={t('calendario.mesAnterior')}
            className="grid h-9 w-9 place-items-center rounded-lg text-[16px] text-(--ink-soft) transition hover:bg-(--raised) hover:text-(--ink-strong)"
          >
            ‹
          </button>
          <button
            onClick={() => step(1)}
            aria-label={t('calendario.mesSiguiente')}
            className="grid h-9 w-9 place-items-center rounded-lg text-[16px] text-(--ink-soft) transition hover:bg-(--raised) hover:text-(--ink-strong)"
          >
            ›
          </button>
          <h3 className="ml-1 text-[16px] font-semibold text-(--ink-strong)">{label}</h3>
        </div>
        {monthBets > 0 && (
          <span
            className="text-[16px] font-semibold tabular-nums"
            style={{ color: monthProfit > 0 ? PROFIT_TEXT : monthProfit < 0 ? LOSS_TEXT : NEUTRAL_TEXT }}
          >
            {signed(monthProfit)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {t('calendario.dias').split(',').map((d, i) => (
          <div key={i} className="pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-faint)">
            {d}
          </div>
        ))}
        {cells.map((c, i) =>
          c == null ? (
            <div key={`pad-${i}`} />
          ) : (
            <DayCell
              key={c.day}
              cell={c}
              maxAbs={maxAbs}
              selected={selectedDay === c.day}
              onPick={onPickDay}
            />
          ),
        )}
      </div>

      <Legend />
    </div>
  );
}

function DayCell({
  cell,
  maxAbs,
  selected,
  onPick,
}: {
  cell: { day: string; dom: number; profit: number; bets: number; settled: number; staked: number };
  maxAbs: number;
  selected: boolean;
  onPick?: (day: string | null) => void;
}) {
  const has = cell.bets > 0;
  const decided = cell.settled > 0;
  const { t } = useI18n();
  // Opacity floors at 0.18 so the smallest real day is still visibly coloured
  // rather than fading into an empty one.
  const weight = decided && maxAbs > 0 ? 0.18 + 0.62 * Math.min(1, Math.abs(cell.profit) / maxAbs) : 0;
  const pole = cell.profit > 0 ? PROFIT_COLOR : cell.profit < 0 ? LOSS_COLOR : BREAK_EVEN_COLOR;

  const title = has
    ? [
        cell.day,
        t(cell.bets === 1 ? 'registro.apuestas1' : 'registro.apuestasN', { n: cell.bets }),
        t('calendario.arriesgado', { d: cell.staked }),
        decided ? t('calendario.resultado', { d: signed(cell.profit) }) : t('calendario.sinResolverTodavia'),
      ].join(' · ')
    : t('calendario.sinApuestas', { dia: cell.day });

  return (
    <button
      type="button"
      title={title}
      disabled={!has}
      onClick={() => onPick?.(selected ? null : cell.day)}
      className={`relative aspect-square rounded-lg p-1 text-left transition ${
        has ? 'cursor-pointer hover:brightness-125' : 'cursor-default'
      } ${selected ? 'ring-2 ring-(--line-strong)' : ''}`}
      style={{
        backgroundColor: decided ? withAlpha(pole, weight) : has ? 'var(--raised)' : 'transparent',
        boxShadow: has && !decided ? 'inset 0 0 0 1px var(--raised-3)' : undefined,
      }}
    >
      <span className={`block text-[11px] leading-none ${has ? 'text-(--ink-body)' : 'text-(--ink-faint)'}`}>
        {cell.dom}
      </span>
      {decided && (
        <span className="mt-0.5 block break-words text-[13px] font-semibold leading-tight tabular-nums text-(--ink-strong)">
          {signed(cell.profit, 0)}
        </span>
      )}
      {has && !decided && (
        <span className="mt-0.5 block text-[11px] leading-tight text-(--ink-soft)">···</span>
      )}
    </button>
  );
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Hex + alpha, so one pole colour serves the whole magnitude ramp. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(3)})`;
}

function Legend() {
  const { t } = useI18n();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-(--ink-muted)">
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-3 rounded" style={{ backgroundColor: withAlpha(PROFIT_COLOR, 0.7) }} />
        {t('calendario.ganancia')}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-3 rounded" style={{ backgroundColor: withAlpha(LOSS_COLOR, 0.7) }} />
        {t('calendario.perdida')}
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-3 w-3 rounded"
          style={{ backgroundColor: 'var(--raised)', boxShadow: 'inset 0 0 0 1px var(--raised-3)' }}
        />
        {t('registro.sinResolver')}
      </span>
      <span>{t('calendario.intensidad')}</span>
    </div>
  );
}

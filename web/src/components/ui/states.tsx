// Piezas compartidas de la interfaz: states. Partido de ui/index.tsx en la Fase 5 (ningún import cambia: index.tsx reexporta).
import { useState, type ReactNode } from 'react';
import { RELIABILITY_STYLE } from '../../lib/theme';
import { num } from '../../lib/formato';
import { StatusMark } from '../icons';
import { Card } from './cards';
import { conNodos, localeDe, useI18n } from '../../i18n';
/**
 * Sub-navigation pill: a league, a tour, a tournament.
 *
 * The four sports had four different treatments for the same control — football
 * an underline tab row (a second one, directly under the app's own underline tab
 * row), tennis a solid lime button and a solid sky button, basketball and
 * baseball a grey pill. One treatment now, and the unselected state has no fill
 * at all, so a row of eight leagues is eight words rather than eight lozenges.
 * Sport identity stays where it belongs: the accent under the main tab.
 */
export function pillClass(active: boolean): string {
  return `shrink-0 rounded-full px-3 py-1.5 text-[14px] font-medium ring-1 ring-inset transition ${
    active
      ? 'bg-(--raised-3) text-(--ink-strong) ring-(--line-strong)'
      : 'text-(--ink-soft) ring-(--line) hover:bg-(--raised) hover:text-(--ink-strong)'
  }`;
}

/** Reliability chip. Always carries the word, never colour alone. */
export function ReliabilityChip({
  level,
  label,
  marginPp,
  title,
}: {
  level: 'high' | 'medium' | 'low';
  label: string;
  marginPp: number;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[13px] font-medium ring-1 ring-inset ${RELIABILITY_STYLE[level]}`}
    >
      <span aria-hidden>{level === 'high' ? '●' : level === 'medium' ? '◐' : '○'}</span>
      {label} · ±{num(marginPp, 1)} pp
    </span>
  );
}

/** Progressive disclosure. The breakdown is opt-in, not a wall you scroll past. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 py-1.5 text-left text-[14px] font-medium text-(--ink-soft) transition hover:text-(--ink-strong)"
      >
        <span>{summary}</span>
        <span aria-hidden className="text-(--ink-faint)">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading and empty states
// ---------------------------------------------------------------------------
/**
 * A card-shaped placeholder.
 *
 * The word "Cargando…" tells you nothing about what is coming; a shape the size
 * of the thing being fetched stops the page jumping when it lands.
 */
export function CardSkeleton() {
  return (
    <Card className="animate-pulse p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="h-3 w-28 rounded bg-(--raised)" />
        <div className="h-3 w-16 rounded bg-(--raised)" />
      </div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="h-5 w-1/3 rounded bg-(--raised-2)" />
        <div className="h-5 w-1/3 rounded bg-(--raised-2)" />
      </div>
      <div className="mb-4 h-2.5 w-full rounded-full bg-(--raised)" />
      <div className="grid grid-cols-4 gap-4 border-y border-(--line) py-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2 w-3/4 rounded bg-(--raised)" />
            <div className="h-3 w-1/2 rounded bg-(--raised-2)" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4" aria-busy="true" aria-label={t('skeleton.cargando')}>
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  tone = 'neutral',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'neutral' | 'warning' | 'critical';
}) {
  const tones = {
    neutral: 'border-(--line) bg-(--tint) text-(--ink-soft)',
    warning: 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/90',
    critical: 'border-rose-500/25 bg-rose-500/[0.06] text-rose-200/90',
  };
  return (
    <div className={`rounded-xl border p-5 text-[16px] ${tones[tone]}`}>
      <p className="font-medium text-(--ink-strong)">{title}</p>
      {children && <div className="mt-1.5 leading-relaxed">{children}</div>}
    </div>
  );
}

/**
 * "The history behind these ratings ends in 2015."
 *
 * WHY THIS IS IN THE DESIGN SYSTEM AND NOT IN ONE DASHBOARD. It used to live
 * inside the tennis tab, which is the one sport whose data is synthetic and
 * therefore never triggers it — while the NBA tab, whose history genuinely ends in
 * June 2015, said nothing at all. A confidently drawn 63 % looks exactly the same
 * whether it rests on last week's games or on games from eleven years ago, so this
 * banner is the only thing standing between the reader and a number they have no
 * way to distrust.
 *
 * `lib/staleness.ts` decides WHEN, per sport, against that sport's own off-season —
 * so the NFL tab does not cry wolf every August. This decides how it looks.
 *
 * It names the date, the size of the gap, and the one command that fixes it,
 * because a warning the reader cannot act on is just an apology.
 */
export function StaleHistoryWarning({
  info,
  what,
  fix,
}: {
  /** From `staleness(sport, through, isDemo)`. Renders nothing when null or fresh. */
  info: { through: Date; yearsOld: number; stale: boolean } | null;
  /** What the stale history undermines: "los Elo", "los Elo y los goles esperados". */
  what: string;
  /** The command that refreshes this sport, e.g. "npm run update-data:bb". */
  fix: string;
}) {
  const { t, idioma } = useI18n();
  if (!info?.stale) return null;
  const when = info.through.toLocaleDateString(localeDe(idioma), { month: 'long', year: 'numeric' });
  // Under a year, months read more honestly than "0.6 años".
  const gap =
    info.yearsOld >= 1
      ? t(info.yearsOld === 1 ? 'historia.anio1' : 'historia.anioN', { n: info.yearsOld })
      : t('historia.meses', { n: Math.max(1, Math.round((info.yearsOld * 365.25) / 30.4)) });
  return (
    <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-[15px] leading-relaxed text-amber-100/90">
      <p className="font-semibold text-amber-100">
        <StatusMark estado="aviso" color="#fcd34d" size={16} />
        {t('historia.termina', { cuando: when, hueco: gap })}
      </p>
      <p className="mt-1">
        {conNodos(t('historia.noReflejan', { que: what }), { fix: <code className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[14px]">{fix}</code> })}
      </p>
    </div>
  );
}

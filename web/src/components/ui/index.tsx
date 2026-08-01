// Shared UI primitives.
//
// Four sports were each rendering their own card, their own stat tile and their
// own section heading, with slightly different padding and type sizes every time.
// The result read as four apps behind one tab bar. These are the pieces they now
// share; anything sport-specific composes them rather than restyling from scratch.

import { useState, type ReactNode } from 'react';
import { RELIABILITY_STYLE } from '../../lib/theme';

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------
export function Card({
  children,
  className = '',
  as: As = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'article' | 'section';
}) {
  return (
    <As
      className={`rounded-2xl border border-white/[0.07] bg-slate-900/70 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_8px_24px_-12px_rgba(0,0,0,0.6)] ${className}`}
    >
      {children}
    </As>
  );
}

/** A recessive panel INSIDE a card, for a breakdown section. */
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.05] ${className}`}>
      {children}
    </section>
  );
}

/** Section heading. Small, uppercase, recessive — it labels, it does not compete. */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        {children}
      </h4>
      {right && <span className="text-[11px] text-slate-500">{right}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------
/**
 * The headline number of a card.
 *
 * Deliberately not a chart: one probability with a label under it is a stat tile,
 * and turning it into a bar or a donut would add ink without adding information.
 */
export function HeroStat({
  value,
  label,
  sub,
  color,
  align = 'left',
}: {
  value: string;
  label: string;
  sub?: string;
  color: string;
  align?: 'left' | 'right';
}) {
  return (
    <div className={align === 'right' ? 'text-right' : ''}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        {label}
      </div>
      <div className="text-[28px] font-bold leading-none tabular-nums" style={{ color }}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] tabular-nums text-slate-400">{sub}</div>}
    </div>
  );
}

/** A small figure in a row of figures. Value in ink, never in a series colour. */
export function StatTile({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  title?: string;
}) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-2 py-2 text-center ring-1 ring-inset ring-white/[0.05]" title={title}>
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.06em] text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-100">{value}</div>
      {hint != null && <div className="truncate text-[10px] tabular-nums text-slate-500">{hint}</div>}
    </div>
  );
}

/** Label / value row, for the dense comparison tables in a breakdown. */
export function CompareRow({
  label,
  left,
  right,
  title,
}: {
  label: string;
  left: ReactNode;
  right: ReactNode;
  title?: string;
}) {
  return (
    <>
      <dt className="min-w-0 truncate py-1 text-slate-400" title={title}>
        {label}
      </dt>
      <dd className="py-1 text-right tabular-nums text-slate-200">{left}</dd>
      <dd className="py-1 text-right tabular-nums text-slate-200">{right}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------
/**
 * A stacked probability bar.
 *
 * 2px surface gaps between segments (the spacer rule) so adjacent fills read as
 * separate marks rather than one continuous ribbon, and rounded outer ends.
 */
export function ProbabilityBar({
  segments,
  height = 10,
}: {
  segments: { value: number; color: string; label: string }[];
  height?: number;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }}>
      {segments.map((s, i) => (
        <div
          key={i}
          className="first:rounded-l-full last:rounded-r-full"
          style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
          title={`${s.label}: ${(s.value * 100).toFixed(1)}%`}
        />
      ))}
    </div>
  );
}

/**
 * A horizontal bar in a ranked list.
 *
 * Scaled to the largest bar rather than to 100%, because these distributions peak
 * in the single digits and an absolute scale would leave every bar invisible.
 */
export function BarRow({
  label,
  value,
  max,
  color,
  valueLabel,
  title,
}: {
  label: ReactNode;
  value: number;
  max: number;
  color: string;
  valueLabel: string;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]" title={title}>
      <span className="w-[3.75rem] shrink-0 text-right tabular-nums text-slate-300">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full"
          style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-12 shrink-0 text-right tabular-nums text-slate-400">{valueLabel}</span>
    </div>
  );
}

/**
 * Recent form as dots.
 *
 * "WWLWDLWWLW" is a string the eye has to parse letter by letter. Dots are read
 * at a glance, and the letter stays in the tooltip for anyone who wants it.
 */
export function FormDots({
  results,
  colors,
}: {
  results: ('W' | 'D' | 'L')[];
  colors: { W: string; D: string; L: string };
}) {
  if (results.length === 0) return <span className="text-slate-600">—</span>;
  return (
    <span className="inline-flex gap-[3px] align-middle">
      {results.map((r, i) => (
        <span
          key={i}
          title={r === 'W' ? 'ganado' : r === 'D' ? 'empatado' : 'perdido'}
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: colors[r] }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------
export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'accent';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-white/[0.06] text-slate-300 ring-white/10',
    good: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
    warning: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    critical: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
    accent: 'bg-sky-500/10 text-sky-300 ring-sky-500/30',
  };
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
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
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${RELIABILITY_STYLE[level]}`}
    >
      <span aria-hidden>{level === 'high' ? '●' : level === 'medium' ? '◐' : '○'}</span>
      {label} · ±{marginPp} pp
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
        className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-left text-[12px] font-medium text-sky-300 transition hover:bg-white/[0.03] hover:text-sky-200"
      >
        <span>{summary}</span>
        <span aria-hidden className="text-slate-500">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
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
        <div className="h-3 w-28 rounded bg-white/[0.06]" />
        <div className="h-3 w-16 rounded bg-white/[0.06]" />
      </div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="h-5 w-1/3 rounded bg-white/[0.08]" />
        <div className="h-5 w-1/3 rounded bg-white/[0.08]" />
      </div>
      <div className="mb-3 h-2.5 w-full rounded-full bg-white/[0.06]" />
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 rounded-xl bg-white/[0.04]" />
        ))}
      </div>
    </Card>
  );
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Cargando partidos">
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
    neutral: 'border-white/[0.07] bg-white/[0.02] text-slate-400',
    warning: 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/90',
    critical: 'border-rose-500/25 bg-rose-500/[0.06] text-rose-200/90',
  };
  return (
    <div className={`rounded-2xl border p-5 text-sm ${tones[tone]}`}>
      <p className="font-medium text-slate-100">{title}</p>
      {children && <div className="mt-1.5 leading-relaxed">{children}</div>}
    </div>
  );
}

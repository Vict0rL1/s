// Shared UI primitives.
//
// Four sports were each rendering their own card, their own stat tile and their
// own section heading, with slightly different padding and type sizes every time.
// The result read as four apps behind one tab bar. These are the pieces they now
// share; anything sport-specific composes them rather than restyling from scratch.

import { useState, type ReactNode } from 'react';
import { INK, RELIABILITY_STYLE } from '../../lib/theme';
import { crestColors, crestPaint, monogram } from '../../lib/teamColors';
import { relativeTime, shortTime } from '../../lib/format';

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------
// ONE surface level, ONE radius.
//
// The card used to be a box (rounded-2xl, border, inset highlight, drop shadow)
// holding panels that were boxes (rounded-xl, fill, inset ring) holding stat tiles
// that were boxes (rounded-xl, fill, inset ring). Three nested rectangles, each
// with its own edge, around numbers that a rule and some space would have grouped
// just as clearly. Every edge is ink the reader has to look past to reach the data.
//
// So: the card is the only filled box on the page. Inside it, sections are
// separated by a hairline and whitespace — which is what a printed table does.

/**
 * The one box. Everything inside it is flat.
 *
 * The only motion in the app is here: the edge brightens a little on hover. Not
 * a lift, not a shadow, not a scale — a card is a sheet of information, and
 * animating it as a button would be a promise the card does not keep. What the
 * brightening does say is "this row is the one you are reading", which on a page
 * of eight near-identical cards is worth one CSS transition.
 */
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
      className={`rounded-xl border border-white/[0.07] bg-[#14161b] transition-colors duration-200 hover:border-white/[0.13] ${className}`}
    >
      {children}
    </As>
  );
}

/**
 * A section INSIDE a card.
 *
 * A rule above and space below — no fill, no ring, no radius. Stacked sections
 * read as one sheet divided into parts, instead of a pile of trays.
 */
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`border-t border-white/[0.07] pt-3 ${className}`}>{children}</section>
  );
}

/** Section heading. Small, uppercase, recessive — it labels, it does not compete. */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7b828d]">
        {children}
      </h4>
      {right && <span className="text-[11px] text-[#7b828d]">{right}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------
/**
 * The headline number of a card.
 *
 * The value is INK, never the series colour — a 28px probability in
 * full-saturation blue next to another in full-saturation orange is a lot of
 * shouting for two figures that are simply "the answer", and a saturated hue is
 * harder to read at that weight than plain light grey. The colour still appears,
 * as a 6px dot in front of the label: enough to say WHICH side this is, which is
 * all the colour was ever needed for. The bar underneath carries the same two
 * colours at the size where they actually do work.
 *
 * Deliberately not a chart: one probability with a label is a figure, and turning
 * it into a donut would add ink without adding information.
 */
export function HeroStat({
  value,
  label,
  sub,
  color,
  align = 'left',
  size = 'lg',
}: {
  value: string;
  label: string;
  sub?: string;
  color: string;
  align?: 'left' | 'center' | 'right';
  size?: 'lg' | 'sm';
}) {
  const box = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : '';
  const row =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <div className={box}>
      {/* The dot sits on the outside edge: leading on the left column, trailing on
          the right one, so the two labels mirror instead of both pointing left. */}
      <div className={`flex items-center gap-1.5 ${row}`}>
        {align !== 'right' && <SeriesDot color={color} />}
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7b828d]">
          {label}
        </span>
        {align === 'right' && <SeriesDot color={color} />}
      </div>
      <div
        className={`mt-1 font-bold leading-none tabular-nums ${size === 'lg' ? 'text-[28px]' : 'text-xl'}`}
        style={{ color: INK.primary }}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] tabular-nums text-[#9aa1ac]">{sub}</div>}
    </div>
  );
}

/**
 * The row that holds a card's secondary figures.
 *
 * One pair of hairlines around the whole group instead of a rounded box around
 * each figure: four boxes said "four things", when what the reader needs is "one
 * group of four".
 */
export function StatRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`grid grid-cols-2 gap-x-4 gap-y-3 border-y border-white/[0.07] py-3 sm:grid-cols-4 ${className}`}
    >
      {children}
    </div>
  );
}

/** A small figure inside a StatRow. Value in ink, never in a series colour. */
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
    <div className="min-w-0" title={title}>
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-[#e8eaed]">{value}</div>
      {hint != null && <div className="truncate text-[10px] tabular-nums text-[#7b828d]">{hint}</div>}
    </div>
  );
}

/**
 * The 6px dot that says which side something belongs to.
 *
 * The same mark in front of a team's name, a hero figure's label and a factor's
 * value, so "blue = this one" is learned once and holds everywhere. It replaced
 * painting each of those in the series colour: a card carried a 15px bold blue
 * name, a 28px blue percentage and a blue bar segment, all repeating the one fact
 * that the bar already made obvious.
 */
export function SeriesDot({ color, className = '' }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${className}`}
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * A team's crest: a small disc in the club's own colours with its monogram.
 *
 * The only place in the app where a team's own colour is allowed. Everything
 * that carries meaning — the bars, the grid, the bands — stays on the shared
 * validated palette, so blue is still the home side whatever the two clubs
 * happen to wear. The crest answers "which club is this", and it answers it
 * faster than reading a name does, which is the whole reason to spend the ink.
 *
 * When the colours are not known the crest goes neutral rather than inventing
 * one, so a card never asserts that a club plays in a colour it does not.
 *
 * `logo` layers a real badge on top when the database happens to have one (the
 * basketball ingest fetches them). It fades in only after it loads and removes
 * itself if it 404s, so a missing image is never a broken-image icon — the
 * coloured disc underneath is always a complete answer on its own.
 */
export function TeamCrest({
  league,
  name,
  code,
  logo,
  size = 22,
  className = '',
}: {
  league: string;
  name: string;
  code?: string | null;
  logo?: string | null;
  size?: number;
  className?: string;
}) {
  const [logoOk, setLogoOk] = useState(false);
  const paint = crestPaint(crestColors(league, name, code));
  const text = monogram(name, code);
  return (
    <span
      aria-hidden
      title={name}
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: paint.fill,
        boxShadow: `inset 0 0 0 1.5px ${paint.ring}`,
      }}
    >
      <span
        className="font-bold leading-none tracking-tight"
        style={{
          color: paint.ink,
          // Three letters have to fit the same disc two letters do.
          fontSize: size * (text.length > 2 ? 0.34 : 0.4),
          opacity: logoOk ? 0 : 1,
        }}
      >
        {text}
      </span>
      {logo && (
        <img
          src={logo}
          alt=""
          loading="lazy"
          onLoad={() => setLogoOk(true)}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
          className="absolute inset-0 h-full w-full object-contain p-[2px]"
        />
      )}
    </span>
  );
}

/**
 * One factor's contribution in a "why" list.
 *
 * The figure is ink and the dot says which side it favours — the same split as
 * HeroStat. The line already ends in the team's name, so painting the whole
 * string blue or orange was colouring text that had already said who it meant.
 */
export function FactorValue({
  color,
  neutral = false,
  children,
}: {
  color: string;
  neutral?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums text-[#c3c9d1]">
      {!neutral && <SeriesDot color={color} />}
      {children}
    </span>
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
      <dt className="min-w-0 truncate py-1 text-[#9aa1ac]" title={title}>
        {label}
      </dt>
      <dd className="py-1 text-right tabular-nums text-[#d5d9df]">{left}</dd>
      <dd className="py-1 text-right tabular-nums text-[#d5d9df]">{right}</dd>
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
      <span className="w-[3.75rem] shrink-0 text-right tabular-nums text-[#c3c9d1]">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full"
          style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-12 shrink-0 text-right tabular-nums text-[#9aa1ac]">{valueLabel}</span>
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
  if (results.length === 0) return <span className="text-[#5c636c]">—</span>;
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
/**
 * A small annotation on a card: "cancha neutral", "partido demo".
 *
 * The neutral tone has no fill at all — it is a word with a hairline round it.
 * Most badges on a card are neutral, and a filled pill for every one of them put
 * a row of grey lozenges above the teams competing with the teams. The coloured
 * tones keep their tint, because those are the ones that need to be noticed.
 */
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
    neutral: 'text-[#9aa1ac] ring-white/[0.10]',
    good: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
    warning: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    critical: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
    // "accent" marks a card the reader has changed (a lineup edit, a swapped
    // starter). A strong neutral says "this one is not the default" without
    // spending a fifth hue on it.
    accent: 'bg-white/[0.12] text-[#e8eaed] ring-white/20',
  };
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------
/**
 * The heading above one day's matches.
 *
 * Sticky, and just under the app's own sticky header — so however far you scroll
 * into a three-week schedule, the day you are looking at is still named. That is
 * the whole reason to group at all: without it, a card in the middle of the list
 * has to carry its own date, and thirty cards each stating their date is thirty
 * copies of information that changes four times.
 */
export function DayHeading({
  label,
  count,
  right,
}: {
  label: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div className="sticky top-[86px] z-20 -mx-1 mb-3 flex items-baseline justify-between gap-3 bg-[#0b0d11]/90 px-1 py-1.5 backdrop-blur-sm">
      <h3 className="text-[13px] font-semibold text-[#e8eaed]">
        {label}
        {count != null && <span className="ml-2 text-[11px] font-normal text-[#7b828d]">{count}</span>}
      </h3>
      {right && <span className="text-[11px] text-[#7b828d]">{right}</span>}
    </div>
  );
}

/**
 * The day strip: a chip per day that has matches.
 *
 * This is the "calendar" — and deliberately not a month grid. A month grid is
 * mostly empty squares: the odds feed only knows about the next week or two, and
 * a schedule knows about a season but with nothing to say about most of it. A
 * strip of only the days that HAVE something shows the same information with no
 * blank space, scrolls with a thumb, and cannot mislead you into tapping a
 * Tuesday that was never going to have games.
 *
 * `null` selects every day, which is the default: a reader who has not asked to
 * filter should see everything.
 */
export function DayFilter({
  days,
  selected,
  onSelect,
}: {
  days: { key: string; label: string; count: number }[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  if (days.length < 2) return null;
  const total = days.reduce((a, d) => a + d.count, 0);
  return (
    <div
      className="mb-4 flex gap-2 overflow-x-auto pb-1"
      role="tablist"
      aria-label="Filtrar por día"
    >
      <button
        role="tab"
        aria-selected={selected === null}
        onClick={() => onSelect(null)}
        className={pillClass(selected === null)}
      >
        Todos
        <span className="ml-1.5 opacity-60">{total}</span>
      </button>
      {days.map((d) => (
        <button
          key={d.key}
          role="tab"
          aria-selected={selected === d.key}
          onClick={() => onSelect(selected === d.key ? null : d.key)}
          className={pillClass(selected === d.key)}
        >
          {d.label}
          <span className="ml-1.5 opacity-60">{d.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The time on a card: the clock, and how far away it is.
 *
 * "20:20" answers where in the day, "en 3 días" answers whether it matters yet.
 * Both in the reader's own time zone.
 */
export function MatchTime({ iso, extra }: { iso: string; extra?: ReactNode }) {
  return (
    <time dateTime={iso} className="tabular-nums">
      {shortTime(iso)}
      <span className="ml-1.5 text-[#5c636c]">{relativeTime(iso)}</span>
      {extra}
    </time>
  );
}

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
  return `shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium ring-1 ring-inset transition ${
    active
      ? 'bg-white/[0.12] text-[#e8eaed] ring-white/[0.18]'
      : 'text-[#9aa1ac] ring-white/[0.08] hover:bg-white/[0.05] hover:text-[#e8eaed]'
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
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${RELIABILITY_STYLE[level]}`}
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
        className="flex w-full items-center justify-between gap-2 py-1.5 text-left text-[12px] font-medium text-[#9aa1ac] transition hover:text-[#e8eaed]"
      >
        <span>{summary}</span>
        <span aria-hidden className="text-[#5c636c]">{open ? '▲' : '▼'}</span>
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
        <div className="h-3 w-28 rounded bg-white/[0.06]" />
        <div className="h-3 w-16 rounded bg-white/[0.06]" />
      </div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="h-5 w-1/3 rounded bg-white/[0.08]" />
        <div className="h-5 w-1/3 rounded bg-white/[0.08]" />
      </div>
      <div className="mb-4 h-2.5 w-full rounded-full bg-white/[0.06]" />
      <div className="grid grid-cols-4 gap-4 border-y border-white/[0.07] py-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2 w-3/4 rounded bg-white/[0.05]" />
            <div className="h-3 w-1/2 rounded bg-white/[0.07]" />
          </div>
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
    neutral: 'border-white/[0.07] bg-white/[0.02] text-[#9aa1ac]',
    warning: 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/90',
    critical: 'border-rose-500/25 bg-rose-500/[0.06] text-rose-200/90',
  };
  return (
    <div className={`rounded-xl border p-5 text-sm ${tones[tone]}`}>
      <p className="font-medium text-[#e8eaed]">{title}</p>
      {children && <div className="mt-1.5 leading-relaxed">{children}</div>}
    </div>
  );
}

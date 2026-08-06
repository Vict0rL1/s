// Shared UI primitives.
//
// Four sports were each rendering their own card, their own stat tile and their
// own section heading, with slightly different padding and type sizes every time.
// The result read as four apps behind one tab bar. These are the pieces they now
// share; anything sport-specific composes them rather than restyling from scratch.

import { useState, type ReactNode } from 'react';
import { INK, LOSS_COLOR, PROFIT_COLOR, RELIABILITY_STYLE } from '../../lib/theme';
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
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#7b828d]">
        {children}
      </h4>
      {right && <span className="text-[13px] text-[#7b828d]">{right}</span>}
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
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#7b828d]">
          {label}
        </span>
        {align === 'right' && <SeriesDot color={color} />}
      </div>
      <div
        className={`mt-1 font-bold leading-none tabular-nums ${size === 'lg' ? 'text-[26px]' : 'text-[20px]'}`}
        style={{ color: INK.primary }}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[13px] tabular-nums text-[#9aa1ac]">{sub}</div>}
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
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[16px] font-semibold tabular-nums text-[#e8eaed]">{value}</div>
      {hint != null && <div className="truncate text-[11px] tabular-nums text-[#7b828d]">{hint}</div>}
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
  // 26, up from 22. A three-letter monogram is sized at a fraction of the disc so
  // it fits, and on a 22px disc that worked out to 7.5px — small enough that CHE
  // and ARS were shapes rather than letters. The disc grew with the rest of the
  // type scale so the floor below never has to clamp.
  size = 26,
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
          // Three letters have to fit the same disc two letters do — but never
          // below 10px, because past that a monogram stops being readable and the
          // crest may as well be a plain dot. On a small disc the letters are
          // allowed to crowd instead of shrinking out of legibility.
          fontSize: Math.max(10, size * (text.length > 2 ? 0.34 : 0.4)),
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
    <div className="flex items-center gap-2 text-[13px]" title={title}>
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
      // `max-w-full` + truncate rather than bare `whitespace-nowrap`: a badge that
      // says "Value: Arizona Cardinals" is as long as the team name, and without a
      // cap it widened the page instead of itself.
      className={`inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[13px] font-medium ring-1 ring-inset ${tones[tone]}`}
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
    // The offset is the app header's MEASURED height, published as --header-h by
    // App. It used to be a hardcoded 86px, which was right until the type scale
    // grew and then silently let the heading slide under the tab bar. A magic
    // number that encodes the size of something else goes stale the moment that
    // something else changes; the fallback only covers the first paint.
    <div
      className="sticky z-20 -mx-1 mb-3 flex items-baseline justify-between gap-3 bg-[#0b0d11]/90 px-1 py-1.5 backdrop-blur-sm"
      style={{ top: 'var(--header-h, 96px)' }}
    >
      <h3 className="text-[15px] font-semibold text-[#e8eaed]">
        {label}
        {count != null && <span className="ml-2 text-[13px] font-normal text-[#7b828d]">{count}</span>}
      </h3>
      {right && <span className="text-[13px] text-[#7b828d]">{right}</span>}
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
 * The final score of a match that has already been played.
 *
 * WHY A CARD SHOWS THIS AT ALL. The schedule now keeps today's matches until
 * midnight instead of dropping them six hours after kick-off, so a game played
 * this morning is still on screen this afternoon — and the one thing you want from
 * it then is how it ended, not a forecast for something that already happened.
 *
 * THREE STATES, and conflating any two of them is a lie:
 *   · finished with a score  → show it, and whether the model called it
 *   · started, no score yet  → "en juego o sin resultado todavía". Scores arrive
 *     with `update-data`, so this is normal for a while and is NOT the model
 *     being wrong or the match not existing.
 *   · not started            → render nothing; the forecast below is the content.
 *
 * The verdict wears a word ("acertó" / "falló"), never colour alone.
 */
export function ResultBanner({
  started,
  score,
  detail,
  modelCalledIt,
}: {
  started: boolean;
  /** "24-17", or "Sinner" for a sport without two scores. Null when unknown. */
  score: string | null;
  detail?: string | null;
  /** Did the model favour the winner? null when there was no forecast to check. */
  modelCalledIt?: boolean | null;
}) {
  if (!started) return null;

  if (score == null) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-[14px] text-[#9aa1ac] ring-1 ring-inset ring-white/[0.08]">
        <span aria-hidden>⏳</span>
        <span>En juego, o el resultado aún no está descargado.</span>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg bg-white/[0.06] px-3 py-2 ring-1 ring-inset ring-white/[0.12]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
            Final
          </span>
          <strong className="text-[20px] font-bold leading-none tabular-nums text-[#e8eaed]">
            {score}
          </strong>
        </span>
        {modelCalledIt != null && (
          <span
            className="text-[13px] font-medium"
            style={{ color: modelCalledIt ? PROFIT_COLOR : LOSS_COLOR }}
          >
            {modelCalledIt ? '✓ el modelo acertó' : '✕ el modelo falló'}
          </span>
        )}
      </div>
      {detail && <div className="mt-0.5 text-[13px] text-[#9aa1ac]">{detail}</div>}
    </div>
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
  return `shrink-0 rounded-full px-3 py-1.5 text-[14px] font-medium ring-1 ring-inset transition ${
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
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[13px] font-medium ring-1 ring-inset ${RELIABILITY_STYLE[level]}`}
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
        className="flex w-full items-center justify-between gap-2 py-1.5 text-left text-[14px] font-medium text-[#9aa1ac] transition hover:text-[#e8eaed]"
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
    <div className={`rounded-xl border p-5 text-[16px] ${tones[tone]}`}>
      <p className="font-medium text-[#e8eaed]">{title}</p>
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
  if (!info?.stale) return null;
  const when = info.through.toLocaleDateString('es', { month: 'long', year: 'numeric' });
  // Under a year, months read more honestly than "0.6 años".
  const gap =
    info.yearsOld >= 1
      ? `${info.yearsOld} ${info.yearsOld === 1 ? 'año' : 'años'}`
      : `${Math.max(1, Math.round((info.yearsOld * 365.25) / 30.4))} meses`;
  return (
    <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-[15px] leading-relaxed text-amber-100/90">
      <p className="font-semibold text-amber-100">
        ⚠️ El historial termina en {when} — hace {gap}
      </p>
      <p className="mt-1">
        {what} no reflejan a los equipos actuales, así que estas predicciones son poco fiables.
        Ejecuta <code className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[14px]">{fix}</code>{' '}
        desde una red que no bloquee las fuentes de datos.
      </p>
    </div>
  );
}

/**
 * "Lo que el modelo destacaría" — the ranked markets panel.
 *
 * WHY IT EXISTS. Each tab shows a card per match, which answers "what about this
 * game". It never answered the question a reader actually arrives with: of all
 * twenty of these, which ones is the model saying something UNUSUAL about? Finding
 * that meant reading every card, which is work the app should be doing.
 *
 * WHAT IT SHOWS AND WHY, in this order per row: the selection (the thing you would
 * write on a slip), the model's probability, the bookmaker's de-vigged one, and the
 * gap. Then the fair odds — the price at which the model considers the bet
 * break-even — because that is the one number a bookmaker never shows you and it is
 * the only way to tell a generous price from a mean one.
 *
 * WHAT IT REFUSES. Ranking is by disagreement with the market, never by the
 * model's confidence, whenever prices exist: "the favourite wins at 92 %" is a
 * price, not a finding. With no prices the panel says so out loud and switches to
 * confidence, which is a weaker claim and is labelled as one — see lib/picks.ts.
 *
 * And the caveat sits ABOVE the list, not under it. On the NFL tab that caveat says
 * the model does not beat the closing line, which is measured and true, and a
 * reader who scrolls straight to the numbers should hit it first.
 */
export function PicksPanel({
  picks,
  basis,
  caveat,
  demoOdds = false,
  stake,
  onStakeChange,
}: {
  picks: {
    id: string; when: string; match: string; market: string; selection: string;
    modelProb: number; marketProb: number | null; odds: number | null;
    edge: number | null; fairOdds: number;
  }[];
  /** 'edge' = ranked against real prices. 'confidence' = no prices to compare. */
  basis: 'edge' | 'confidence';
  caveat: string;
  /**
   * True when the only prices available were generated by this app from the model
   * itself (no API key).
   *
   * Worth its own flag rather than folding into `basis`, because "there is no
   * market" and "the market you see is our own model with a margin on it" send the
   * reader to two different actions: wait for a price, or go get an API key.
   */
  demoOdds?: boolean;
  /** Stake used for the "devolvería" column, so the figure is in the reader's money. */
  stake: number;
  onStakeChange: (n: number) => void;
}) {
  const [open, setOpen] = useState(true);
  // "The model agrees with every price" is a finding, not a reason to render
  // nothing — an empty space where a panel was reads as a bug, and the reader is
  // left wondering whether it failed to load.
  if (picks.length === 0) {
    return (
      <p className="mb-6 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-[14px] leading-relaxed text-[#9aa1ac]">
        El modelo <strong className="font-semibold text-[#c3c9d1]">no discrepa del mercado</strong> en
        ningún mercado por más de 4 puntos porcentuales. Eso es lo normal y es buena señal: significa
        que va calibrado con las casas.
      </p>
    );
  }

  const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]"
      >
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold text-[#e8eaed]">
            {basis === 'edge'
              ? 'Donde el modelo no está de acuerdo con el mercado'
              : 'Lo que el modelo ve más probable'}
          </span>
          <span className="block text-[13px] text-[#7b828d]">
            {basis === 'edge'
              ? `${picks.length} ${picks.length === 1 ? 'mercado' : 'mercados'} con diferencia de 4 pp o más, de mayor a menor`
              : demoOdds
                ? 'las cuotas son de demostración y salen del propio modelo, así que compararlas no diría nada — ordenado por probabilidad'
                : 'sin cuotas que comparar — ordenado por probabilidad, que es una base más débil'}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-[#7b828d]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-white/[0.07]">
          <p className="px-4 py-3 text-[13px] leading-relaxed text-amber-200/80">
            ⚠️ {caveat}
          </p>

          {/* Horizontal scroll on the table only, never the page — a wide row must
              not be able to push the whole layout sideways on a phone. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-[14px]">
              <thead>
                <tr className="border-y border-white/[0.07] text-left text-[12px] uppercase tracking-[0.05em] text-[#7b828d]">
                  <th className="px-4 py-2 font-medium">Partido</th>
                  <th className="px-3 py-2 font-medium">Apuesta</th>
                  <th className="px-3 py-2 text-right font-medium">Modelo</th>
                  <th className="px-3 py-2 text-right font-medium">Mercado</th>
                  <th className="px-3 py-2 text-right font-medium">Dif.</th>
                  <th
                    className="px-3 py-2 text-right font-medium"
                    title="1 ÷ probabilidad del modelo. Por encima de esta cuota el modelo cree que el precio es generoso; por debajo, que es caro."
                  >
                    Cuota mínima
                  </th>
                  <th className="px-4 py-2 text-right font-medium">Devolvería</th>
                </tr>
              </thead>
              <tbody>
                {picks.map((p, i) => (
                  <tr
                    key={`${p.id}-${p.market}-${p.selection}-${i}`}
                    className="border-b border-white/[0.05] last:border-0"
                  >
                    <td className="max-w-[14rem] px-4 py-2.5">
                      <span className="block truncate text-[#c3c9d1]">{p.match}</span>
                      <span className="block text-[12px] text-[#7b828d]">
                        {shortTime(p.when)} · {relativeTime(p.when)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="block font-semibold text-[#e8eaed]">{p.selection}</span>
                      <span className="block text-[12px] text-[#7b828d]">{p.market}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-[#e8eaed]">
                      {pct(p.modelProb)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[#9aa1ac]">
                      {p.marketProb == null ? '—' : pct(p.marketProb)}
                    </td>
                    <td
                      className="px-3 py-2.5 text-right font-semibold tabular-nums"
                      style={{ color: p.edge == null ? INK.muted : p.edge > 0 ? PROFIT_COLOR : LOSS_COLOR }}
                    >
                      {p.edge == null ? '—' : `${p.edge > 0 ? '+' : ''}${(p.edge * 100).toFixed(1)} pp`}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[#c3c9d1]">
                      {p.fairOdds.toFixed(2)}
                      {p.odds != null && (
                        <span
                          className="ml-1.5 text-[12px]"
                          // Green means "the offered price is above what the model
                          // thinks it is worth". With demo odds — generated FROM the
                          // model — that comparison is circular, so the colour is
                          // withheld rather than flattering our own arithmetic.
                          style={{
                            color: !demoOdds && p.odds > p.fairOdds ? PROFIT_COLOR : INK.muted,
                          }}
                          title={`Cuota ofrecida: ${p.odds.toFixed(2)}`}
                        >
                          ({p.odds.toFixed(2)})
                        </span>
                      )}
                    </td>
                    {/* Only at a REAL price. At the fair odds the return is
                        stake ÷ probability, which is break-even BY DEFINITION — so
                        printing it would be arithmetic dressed up as a forecast.
                        What is useful with no price is the minimum odds to look for,
                        and that is already in the column to the left. */}
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#c3c9d1]">
                      {p.odds == null ? (
                        <span className="text-[13px] text-[#7b828d]">
                          busca ≥ {p.fairOdds.toFixed(2)}
                        </span>
                      ) : (
                        (stake * p.odds).toLocaleString('es', { maximumFractionDigits: 0 })
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.07] px-4 py-3">
            <label htmlFor="picks-stake" className="text-[13px] text-[#9aa1ac]">
              Con una apuesta de
            </label>
            <input
              id="picks-stake"
              type="number"
              min={1}
              step={1}
              value={stake}
              onChange={(e) => onStakeChange(Math.max(1, Number(e.target.value) || 1))}
              className="w-28 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-right text-[14px] tabular-nums text-[#e8eaed] ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-2 focus:ring-white/25"
            />
            <span className="text-[13px] text-[#7b828d]">
              · una diferencia a favor no es un beneficio: es una discrepancia entre dos
              estimaciones, y la del mercado suele ser la buena.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The per-sport header, collapsed by default.
 *
 * WHAT IT REPLACES. Every tab opened with a wall of prose before a single
 * prediction: a paragraph explaining the model, a data-origin line, an odds-refresh
 * line, a stale-history warning of two sentences, and a track-record panel. All of
 * it true, all of it read once, and all of it standing between the reader and the
 * thing they opened the app for. On a laptop it was most of the first screen.
 *
 * So it collapses, and it opens with the CONTROLS and the FACTS instead: the refresh
 * button, a few counts as chips, and — this is the part that must not be lost — a
 * short warning chip when the data is stale.
 *
 * WHY THE WARNING SURVIVES THE COLLAPSE. The full stale-history paragraph is the one
 * piece of that block that changes what a reader should DO: it says these numbers
 * describe last season's teams. Hiding that silently would make the app quietly
 * misleading, which is exactly the failure the warning exists to prevent. So the
 * paragraph collapses and a four-word version of it does not. Nothing important
 * disappears; it just stops being a paragraph.
 *
 * The open/closed choice is remembered, and remembered ONCE for all sports: it is a
 * preference about how much chrome the reader wants, not a fact about baseball.
 */
const HEADER_OPEN_KEY = 'predictor.header.open';

export function DashboardHeader({
  chips,
  alert,
  onRefresh,
  refreshing = false,
  refreshTitle,
  children,
}: {
  /** Short facts, always visible: "37.262 partidos", "32 equipos". */
  chips?: ReactNode;
  /** Compact stale-data note. Stays visible when collapsed — see above. */
  alert?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshTitle?: string;
  /** The full block. Hidden until asked for. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HEADER_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(HEADER_OPEN_KEY, next ? '1' : '0');
    } catch {
      // Only affects whether it opens collapsed next time.
    }
  };

  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            title={refreshTitle}
            className="shrink-0 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[14px] font-medium text-[#d5d9df] ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-50"
          >
            {refreshing ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        )}
        {chips && <span className="min-w-0 text-[13px] text-[#7b828d]">{chips}</span>}
        {alert && (
          <span
            className="shrink-0 rounded-full bg-amber-500/[0.12] px-2.5 py-1 text-[13px] font-medium text-amber-200/90"
            title="Los ratings no describen a los equipos actuales. Abre los detalles para ver cómo arreglarlo."
          >
            ⚠️ {alert}
          </span>
        )}
        <button
          onClick={toggle}
          aria-expanded={open}
          className="ml-auto shrink-0 rounded-lg px-2 py-1 text-[13px] font-medium text-[#7b828d] transition hover:bg-white/[0.04] hover:text-[#c3c9d1]"
        >
          {open ? 'Ocultar detalles ▲' : 'Detalles ▼'}
        </button>
      </div>
      {open && <div className="mt-3">{children}</div>}
    </header>
  );
}

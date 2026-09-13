import { useEffect, useRef, useState } from 'react';
import TennisDashboard from './components/TennisDashboard';
import BasketballDashboard from './components/basketball/BasketballDashboard';
import FootballDashboard from './components/football/FootballDashboard';
import BaseballDashboard from './components/baseball/BaseballDashboard';
import NflDashboard from './components/nfl/NflDashboard';
import BetsDashboard from './components/bets/BetsDashboard';
import { SPORT_THEMES, type SportId } from './lib/theme';

/**
 * Sports are separate tabs, not a merged feed.
 *
 * The five differ in almost everything a card needs to show — tennis has a
 * surface and a head-to-head between two people; basketball a home court, a
 * spread and a total; football a DRAW, goals markets and likely scorelines;
 * baseball a STARTING PITCHER, a single named player who moves the forecast more
 * than anything except the teams themselves; American football a HANDICAP that
 * is the headline market and a margin that lumps on 3 and 7 rather than
 * following a curve. One shared list would mean a card that is mostly empty
 * whichever sport it happens to show.
 *
 * Each tab owns its own state and talks only to its own slice of the API, which
 * is also why switching back and forth doesn't refetch or disturb the others.
 *
 * Football then splits again into per-league sub-tabs (see FootballDashboard):
 * nobody reads a merged feed of the Premier League, LaLiga and the Brasileirão.
 *
 * The choice is remembered in localStorage: reopening the app on the tab you were
 * last using is the behaviour anyone expects from a tab bar.
 */
const SPORTS: SportId[] = ['football', 'basketball', 'baseball', 'nfl', 'tennis', 'bets'];

const STORAGE_KEY = 'predictor.sport';

/**
 * How wide the app is allowed to get.
 *
 * This was `max-w-3xl` — 768px. On a laptop that is under half the window, and the
 * app looked like a phone screenshot pasted into the middle of a desktop browser.
 * 768px is the right measure for a column of PROSE; it is the wrong measure for a
 * page whose content is cards, score grids and league tables.
 *
 * 80rem (1280px) with the card lists going two-up on wide screens (see the `xl:`
 * grid in each dashboard). Widening alone would have been worse than the bug: one
 * 1280px-wide card puts "23.7 %" and "76.3 %" at opposite ends of the monitor with
 * a hand's width of nothing between them. The extra room has to buy a second
 * column, not a longer one.
 *
 * Declared once and used by the header, the main column and the footer, because
 * three literals are three chances for the sticky header to stop lining up with
 * the content underneath it.
 */
const SHELL_WIDTH = 'max-w-[80rem]';

function initialSport(): SportId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (SPORTS.includes(saved as SportId)) return saved as SportId;
  } catch {
    // Private browsing / storage disabled — the default is fine.
  }
  return 'football';
}

export default function App() {
  const [sport, setSport] = useState<SportId>(initialSport);
  const theme = SPORT_THEMES[sport];
  const headerRef = useRef<HTMLElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  /**
   * Publish the top bar's height so sticky day headings can sit exactly under it.
   *
   * Measured rather than hardcoded. The offset was a literal 86px until the type
   * scale grew and the headings started sliding beneath the tab bar — a constant
   * that describes the size of a different element is wrong the moment that
   * element changes. A ResizeObserver also covers what a constant never could:
   * a phone rotating, a notch's safe-area inset, and the browser's own font-size
   * setting.
   *
   * It now covers one more case for free. Above 1024px the top bar is
   * `display: none` (the nav moved to the left rail), so its measured height is 0 —
   * and 0 is exactly the right offset there, because nothing is above the content
   * any more. A hardcoded value would have left a gap the width of a header that
   * is not on screen.
   */
  /**
   * Scroll the selected tab fully into view.
   *
   * Six tabs do not fit a 360px phone, and a row that rests half-way through
   * "Fútbol" looks broken rather than scrollable. `nearest` nudges only when the
   * tab is actually clipped, so on a wide screen this does nothing at all.
   */
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [sport]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty('--header-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, sport);
    } catch {
      // Not worth surfacing: it only affects which tab opens next time.
    }
  }, [sport]);

  return (
    <div className="min-h-screen lg:flex">
      {/*
        NAVIGATION LIVES ON THE LEFT from 1024px, and across the top below it.
        Two arrangements of one list, not two lists — see SportNav.

        A vertical rail is the better shape for six items on a wide screen: the
        labels read left-to-right at full length instead of competing for a strip of
        horizontal space, and the whole of the page's own width is left for content.
        Below 1024px it goes back to a top row, because a rail on a 390px phone
        spends a third of the screen on navigation.
      */}
      <aside className="hidden shrink-0 border-r border-white/[0.07] bg-[#0d0f14] lg:block lg:w-[15rem]">
        {/* Sticky and full-height: the nav must stay reachable after scrolling a
            long list of cards, which is the same reason the top bar was sticky. */}
        <div className="sticky top-0 flex h-screen flex-col pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)]">
          <div className="flex items-center gap-2.5 px-4 pb-5 pt-5">
            <span
              aria-hidden
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[17px]"
              style={{ backgroundColor: theme.accentSoft }}
            >
              {theme.emoji}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[16px] font-semibold leading-tight text-[#e8eaed]">
                Sports Predictor
              </h1>
              {/* Wraps rather than truncates: a 15rem rail has room for two short
                  lines and none for "medidos contra resultad…", which is a subtitle
                  spending its width on an ellipsis. */}
              <p className="text-[12px] leading-snug text-[#7b828d]">
                medidos contra resultados reales
              </p>
            </div>
          </div>
          <SportNav sport={sport} onSelect={setSport} vertical />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/*
          The top bar, phones and tablets only. Sticky, because the nav is the app's
          primary control and scrolling a long card should not strand you at the
          bottom of one sport with no way back.
        */}
        <header
          ref={headerRef}
          className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#0b0d11]/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl lg:hidden"
        >
          <div className={`mx-auto ${SHELL_WIDTH} px-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]`}>
            <div className="flex items-center gap-3 pb-1 pt-4">
              <span
                aria-hidden
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[17px]"
                style={{ backgroundColor: theme.accentSoft }}
              >
                {theme.emoji}
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-[17px] font-semibold leading-tight text-[#e8eaed]">
                  Sports Predictor
                </h1>
                {/* Hidden on the narrowest screens: at 390px it truncated to
                    "…medidos contra resultados r…", which is header height spent on
                    half a sentence. */}
                <p className="hidden truncate text-[13px] leading-tight text-[#7b828d] md:block">
                  Modelos explicables, medidos contra resultados reales
                </p>
              </div>
            </div>
            <SportNav sport={sport} onSelect={setSport} activeRef={activeTabRef} />
          </div>
        </header>

        <main className={`mx-auto ${SHELL_WIDTH} px-4 pb-16 pt-6`}>
          {/* Mounted one at a time on purpose: the inactive sports do no fetching. */}
          {sport === 'bets' && <BetsDashboard />}
          {sport === 'football' && <FootballDashboard />}
          {sport === 'basketball' && <BasketballDashboard />}
          {sport === 'baseball' && <BaseballDashboard />}
          {sport === 'nfl' && <NflDashboard />}
          {sport === 'tennis' && <TennisDashboard />}
        </main>

        <footer className={`mx-auto ${SHELL_WIDTH} px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))]`}>
          <p className="border-t border-white/[0.07] pt-4 text-[13px] leading-relaxed text-[#7b828d]">
            Estimación estadística. Cada modelo se mide contra resultados reales y la app registra sus
            propios aciertos, pero ninguno conoce las lesiones de última hora, el clima ni la
            motivación. No es una recomendación para apostar.
          </p>
          <OddsQuotaLine />
        </footer>
      </div>
    </div>
  );

}

/**
 * The sport list, in whichever direction it is asked for.
 *
 * ONE component and not two, because the two arrangements have to stay the same
 * list: the same six sports, the same order, the same accent colour marking the
 * active one, the same `role="tab"` semantics. Two copies would drift the first
 * time a sport is added.
 *
 * The accent line is the only place a sport's identity colour appears anywhere in
 * the app — data marks use the shared validated palette, so a blue bar means "home"
 * on every tab. Vertically it becomes a bar down the left edge, which is the
 * conventional shape for a rail and reads at a glance from the margin.
 */
function SportNav({
  sport,
  onSelect,
  vertical = false,
  activeRef,
}: {
  sport: SportId;
  onSelect: (id: SportId) => void;
  vertical?: boolean;
  /** Only the horizontal row needs this — see the scrollIntoView effect. */
  activeRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <nav
      role="tablist"
      aria-label="Deportes"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={
        vertical
          ? 'flex flex-col gap-0.5 px-2'
          : '-mb-px flex gap-0.5 overflow-x-auto md:gap-1'
      }
    >
      {SPORTS.map((id) => {
        const s = SPORT_THEMES[id];
        const active = sport === id;
        if (vertical) {
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(id)}
              className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[15px] font-medium transition ${
                active
                  ? 'bg-white/[0.06] text-[#e8eaed]'
                  : 'text-[#9aa1ac] hover:bg-white/[0.03] hover:text-[#c3c9d1]'
              }`}
            >
              <span
                aria-hidden
                className="absolute inset-y-1.5 left-0 w-[3px] rounded-full transition"
                style={{ backgroundColor: active ? s.accent : 'transparent' }}
              />
              <span aria-hidden className="text-[16px]">{s.emoji}</span>
              <span className="min-w-0 truncate">{s.label}</span>
            </button>
          );
        }
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            ref={active ? activeRef : undefined}
            onClick={() => onSelect(id)}
            className={`relative shrink-0 rounded-t-lg px-1.5 py-2.5 text-[14px] font-medium transition md:px-3 md:text-[15px] ${
              active ? 'text-[#e8eaed]' : 'text-[#7b828d] hover:text-[#c3c9d1]'
            }`}
          >
            {/* Decorative, and the first thing to go when six tabs have to share a
                phone's width — the word identifies the sport, the accent line
                underneath carries the colour. */}
            <span className="mr-1.5 hidden md:inline" aria-hidden>
              {s.emoji}
            </span>
            {/* Two spans rather than JS width detection: CSS decides, so there is no
                resize listener and no flash of the wrong one. */}
            <span className={s.shortLabel ? 'md:hidden' : ''}>{s.shortLabel ?? s.label}</span>
            {s.shortLabel && <span className="hidden md:inline">{s.label}</span>}
            <span
              aria-hidden
              className="absolute inset-x-1 -bottom-px h-0.5 rounded-full transition"
              style={{ backgroundColor: active ? s.accent : 'transparent' }}
            />
          </button>
        );
      })}
    </nav>
  );
}

/**
 * How much of The Odds API's monthly allowance is left.
 *
 * In the footer, on every tab, because the free plan quietly running out is what
 * broke the live odds — and nothing in the app mentioned it until the numbers
 * simply stopped updating. One line of chrome is a cheap price for never being
 * surprised by that again.
 *
 * Hidden entirely when no key is configured: there is no quota to report, and a
 * line saying so would be noise on the majority of installs.
 */
function OddsQuotaLine() {
  const [q, setQ] = useState<{
    remaining: number | null;
    used: number | null;
    hasKey: boolean;
    reserve: number;
    /** The plan's monthly allowance, learned from the API's own headers. */
    plan: number | null;
    creditsPerCycle: number | null;
    autoRefreshMinutes: number;
    /** What the server worked out it can afford; null until a cycle is measured. */
    recommendedRefreshMinutes: number | null;
    lastError: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/odds-quota')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setQ(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!q?.hasKey) return null;
  const { remaining, used, reserve, plan, lastError } = q;
  const low = remaining != null && remaining <= reserve;
  // The live interval, which is the recommended one unless it has not been
  // measured yet. Shown in whichever unit reads better: "cada 2 h" on a big plan,
  // "cada 3 días" on the free one, where the honest answer really is days.
  const minutes = q.recommendedRefreshMinutes ?? q.autoRefreshMinutes;
  const every =
    minutes >= 1440
      ? `${Math.round(minutes / 1440)} día(s)`
      : minutes >= 90
        ? `${Math.round(minutes / 60)} h`
        : `${minutes} min`;

  return (
    <p className={`mt-3 text-[13px] leading-relaxed ${low ? 'text-amber-300/90' : 'text-[#7b828d]'}`}>
      Cuotas del mercado:{' '}
      {remaining == null ? (
        'sin consultar todavía'
      ) : (
        <>
          <strong className="font-semibold tabular-nums">{remaining}</strong> peticiones restantes
          este mes{plan != null && <> de {plan.toLocaleString('es')}</>}
          {used != null && <> · {used} usadas</>} · se refresca cada {every}
          {q.creditsPerCycle != null && <> · {q.creditsPerCycle} créditos por ciclo</>}
        </>
      )}
      {low && ' · las últimas quedan reservadas para las actualizaciones que pidas a mano'}
      {lastError && <> · {lastError}</>}
    </p>
  );
}

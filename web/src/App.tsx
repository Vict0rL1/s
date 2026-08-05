import { useEffect, useRef, useState } from 'react';
import TennisDashboard from './components/TennisDashboard';
import BasketballDashboard from './components/basketball/BasketballDashboard';
import FootballDashboard from './components/football/FootballDashboard';
import BaseballDashboard from './components/baseball/BaseballDashboard';
import NflDashboard from './components/nfl/NflDashboard';
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
const SPORTS: SportId[] = ['football', 'basketball', 'baseball', 'nfl', 'tennis'];

const STORAGE_KEY = 'predictor.sport';

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

  /**
   * Publish the header's height so sticky day headings can sit exactly under it.
   *
   * Measured rather than hardcoded. The offset was a literal 86px until the type
   * scale grew and the headings started sliding beneath the tab bar — a constant
   * that describes the size of a different element is wrong the moment that
   * element changes. A ResizeObserver also covers what a constant never could:
   * a phone rotating, a notch's safe-area inset, and the browser's own font-size
   * setting.
   */
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
    <div className="min-h-screen">
      {/*
        A sticky header, because the tab bar is the app's primary navigation and
        scrolling a long card should not strand you at the bottom of one sport
        with no way back. The accent line under the active tab is the ONLY place a
        sport's identity colour appears — data marks use the shared, validated
        palette, so a blue bar means "home" on every tab.
      */}
      <header ref={headerRef} className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#0b0d11]/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        {/* Safe-area padding so a notch or a rounded corner never clips the tab
            bar when the app is opened from a phone's home screen. */}
        <div className="mx-auto max-w-3xl px-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
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
              <p className="hidden truncate text-[13px] leading-tight text-[#7b828d] sm:block">
                Modelos explicables, medidos contra resultados reales
              </p>
            </div>
          </div>

          <nav className="-mb-px flex gap-0.5 overflow-x-auto sm:gap-1" role="tablist" aria-label="Deportes">
            {SPORTS.map((id) => {
              const s = SPORT_THEMES[id];
              const active = sport === id;
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSport(id)}
                  className={`relative shrink-0 rounded-t-lg px-1.5 py-2.5 text-[15px] font-medium transition sm:px-3 ${
                    active ? 'text-[#e8eaed]' : 'text-[#7b828d] hover:text-[#c3c9d1]'
                  }`}
                >
                  {/* Decorative, and the first thing to go when five tabs have
                      to share a phone's width — the word is what identifies the
                      sport, the accent line under it carries the colour. */}
                  <span className="mr-1.5 hidden sm:inline" aria-hidden>
                    {s.emoji}
                  </span>
                  {s.label}
                  <span
                    aria-hidden
                    className="absolute inset-x-1 -bottom-px h-0.5 rounded-full transition"
                    style={{ backgroundColor: active ? s.accent : 'transparent' }}
                  />
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16 pt-6">
        {/* Mounted one at a time on purpose: the inactive sports do no fetching. */}
        {sport === 'football' && <FootballDashboard />}
        {sport === 'basketball' && <BasketballDashboard />}
        {sport === 'baseball' && <BaseballDashboard />}
        {sport === 'nfl' && <NflDashboard />}
        {sport === 'tennis' && <TennisDashboard />}
      </main>

      <footer className="mx-auto max-w-3xl px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <p className="border-t border-white/[0.07] pt-4 text-[13px] leading-relaxed text-[#7b828d]">
          Estimación estadística. Cada modelo se mide contra resultados reales y la app registra sus
          propios aciertos, pero ninguno conoce las lesiones de última hora, el clima ni la
          motivación. No es una recomendación para apostar.
        </p>
        <OddsQuotaLine />
      </footer>
    </div>
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
    autoRefreshMinutes: number;
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
  const { remaining, used, reserve, lastError } = q;
  const low = remaining != null && remaining <= reserve;
  const hours = Math.round(q.autoRefreshMinutes / 60);

  return (
    <p className={`mt-3 text-[13px] leading-relaxed ${low ? 'text-amber-300/90' : 'text-[#7b828d]'}`}>
      Cuotas del mercado:{' '}
      {remaining == null ? (
        'sin consultar todavía'
      ) : (
        <>
          <strong className="font-semibold tabular-nums">{remaining}</strong> peticiones restantes
          este mes{used != null && <> · {used} usadas</>} · se refresca cada {hours} h
        </>
      )}
      {low && ' · las últimas quedan reservadas para las actualizaciones que pidas a mano'}
      {lastError && <> · {lastError}</>}
    </p>
  );
}

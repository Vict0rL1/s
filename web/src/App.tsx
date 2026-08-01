import { useEffect, useState } from 'react';
import TennisDashboard from './components/TennisDashboard';
import BasketballDashboard from './components/basketball/BasketballDashboard';
import FootballDashboard from './components/football/FootballDashboard';
import BaseballDashboard from './components/baseball/BaseballDashboard';
import { SPORT_THEMES, type SportId } from './lib/theme';

/**
 * Sports are separate tabs, not a merged feed.
 *
 * The four differ in almost everything a card needs to show — tennis has a
 * surface and a head-to-head between two people; basketball a home court, a
 * spread and a total; football a DRAW, goals markets and likely scorelines;
 * baseball a STARTING PITCHER, a single named player who moves the forecast more
 * than anything except the teams themselves. One shared list would mean a card
 * that is mostly empty whichever sport it happens to show.
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
const SPORTS: SportId[] = ['football', 'basketball', 'baseball', 'tennis'];

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
      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#0b0d11]/85 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-4">
          <div className="flex items-center gap-3 pb-1 pt-4">
            <span
              aria-hidden
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-base"
              style={{ backgroundColor: theme.accentSoft }}
            >
              {theme.emoji}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold leading-tight text-[#e8eaed]">
                Sports Predictor
              </h1>
              <p className="truncate text-[11px] leading-tight text-[#7b828d]">
                Modelos explicables, medidos contra resultados reales
              </p>
            </div>
          </div>

          <nav className="-mb-px flex gap-1 overflow-x-auto" role="tablist" aria-label="Deportes">
            {SPORTS.map((id) => {
              const s = SPORT_THEMES[id];
              const active = sport === id;
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSport(id)}
                  className={`relative shrink-0 rounded-t-lg px-3 py-2.5 text-[13px] font-medium transition ${
                    active ? 'text-[#e8eaed]' : 'text-[#7b828d] hover:text-[#c3c9d1]'
                  }`}
                >
                  <span className="mr-1.5" aria-hidden>
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
        {sport === 'tennis' && <TennisDashboard />}
      </main>

      <footer className="mx-auto max-w-3xl px-4 pb-10">
        <p className="border-t border-white/[0.07] pt-4 text-[11px] leading-relaxed text-[#7b828d]">
          Estimación estadística. Cada modelo se mide contra resultados reales y la app registra sus
          propios aciertos, pero ninguno conoce las lesiones de última hora, el clima ni la
          motivación. No es una recomendación para apostar.
        </p>
      </footer>
    </div>
  );
}

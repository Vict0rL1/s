import { useEffect, useState } from 'react';
import TennisDashboard from './components/TennisDashboard';
import BasketballDashboard from './components/basketball/BasketballDashboard';
import FootballDashboard from './components/football/FootballDashboard';
import BaseballDashboard from './components/baseball/BaseballDashboard';

/**
 * Sports are separate tabs, not a merged feed.
 *
 * The four differ in almost everything a card needs to show — tennis has a
 * surface and a head-to-head between two people; basketball a home court, a
 * spread and a total; football a DRAW, goals markets and likely scorelines;
 * baseball a STARTING PITCHER, which is a single named player who moves the
 * forecast more than anything except the teams themselves. One shared list would
 * mean a card that is mostly empty whichever sport it happens to show.
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
type Sport = 'tennis' | 'basketball' | 'football' | 'baseball';

const SPORTS: { id: Sport; label: string; emoji: string }[] = [
  { id: 'football', label: 'Fútbol', emoji: '⚽' },
  { id: 'basketball', label: 'Baloncesto', emoji: '🏀' },
  { id: 'baseball', label: 'Béisbol', emoji: '⚾' },
  { id: 'tennis', label: 'Tenis', emoji: '🎾' },
];

const STORAGE_KEY = 'predictor.sport';

function initialSport(): Sport {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (SPORTS.some((s) => s.id === saved)) return saved as Sport;
  } catch {
    // Private browsing / storage disabled — the default is fine.
  }
  return 'football';
}

export default function App() {
  const [sport, setSport] = useState<Sport>(initialSport);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, sport);
    } catch {
      // Not worth surfacing: it only affects which tab opens next time.
    }
  }, [sport]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-100">
        {SPORTS.find((s) => s.id === sport)?.emoji} Sports Predictor
      </h1>

      {/* Sport tabs */}
      <nav className="mt-4 flex flex-wrap gap-1 border-b border-slate-700" role="tablist">
        {SPORTS.map((s) => {
          const active = sport === s.id;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={active}
              onClick={() => setSport(s.id)}
              className={`-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium transition ${
                active
                  ? 'border-lime-400 bg-slate-800/60 text-slate-100'
                  : 'border-transparent text-slate-400 hover:bg-slate-800/30 hover:text-slate-200'
              }`}
            >
              <span className="mr-1.5">{s.emoji}</span>
              {s.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-6">
        {/* Mounted one at a time on purpose: the inactive sports do no fetching. */}
        {sport === 'tennis' && <TennisDashboard />}
        {sport === 'basketball' && <BasketballDashboard />}
        {sport === 'football' && <FootballDashboard />}
        {sport === 'baseball' && <BaseballDashboard />}
      </div>

      <footer className="mt-10 border-t border-slate-800 pt-4 text-xs text-slate-500">
        <p>
          ⚠️ Estimación estadística — no considera lesiones ni bajas de última hora, clima, rotaciones
          ni motivación. No es una recomendación para apostar.
        </p>
      </footer>
    </div>
  );
}

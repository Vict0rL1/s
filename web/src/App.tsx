import { useEffect, useState } from 'react';
import TennisDashboard from './components/TennisDashboard';
import BasketballDashboard from './components/basketball/BasketballDashboard';

/**
 * Sports are separate tabs, not a merged feed.
 *
 * Tennis and basketball differ in almost everything a card needs to show — one has
 * a surface and a head-to-head between two people, the other a home court, a
 * spread and a total — so putting both in one list would mean a card that is half
 * empty whichever sport it is showing. Each tab owns its own state and talks only
 * to its own half of the API, which is also why switching back and forth doesn't
 * refetch or disturb the other sport.
 *
 * The choice is remembered in localStorage: reopening the app on the tab you were
 * last using is the behaviour anyone expects from a tab bar.
 */
type Sport = 'tennis' | 'basketball';

const SPORTS: { id: Sport; label: string; emoji: string }[] = [
  { id: 'tennis', label: 'Tenis', emoji: '🎾' },
  { id: 'basketball', label: 'Baloncesto', emoji: '🏀' },
];

const STORAGE_KEY = 'predictor.sport';

function initialSport(): Sport {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'tennis' || saved === 'basketball') return saved;
  } catch {
    // Private browsing / storage disabled — the default is fine.
  }
  return 'tennis';
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
        {sport === 'tennis' ? '🎾' : '🏀'} Sports Predictor
      </h1>

      {/* Sport tabs */}
      <nav className="mt-4 flex gap-1 border-b border-slate-700" role="tablist">
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
        {/* Mounted one at a time on purpose: the inactive sport does no fetching. */}
        {sport === 'tennis' ? <TennisDashboard /> : <BasketballDashboard />}
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

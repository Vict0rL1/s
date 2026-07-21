import type { Prediction } from '../lib/api';
import { pct, surfaceLabelEs, formatDate } from '../lib/format';
import { P1_COLOR, P2_COLOR } from './ProbabilityBars';

function Num({ value, plus = false }: { value: number; plus?: boolean }) {
  const sign = plus && value > 0 ? '+' : '';
  const color = value > 0 ? 'text-lime-400' : value < 0 ? 'text-rose-400' : 'text-slate-400';
  return <span className={color}>{sign}{value}</span>;
}

/** Signal-by-signal breakdown, all in Elo points so the math is transparent. */
export default function MatchDetail({ prediction }: { prediction: Prediction }) {
  const { ratings, form, h2h, adjustedRatings, players, surface, market } = prediction;
  const surfLabel = surfaceLabelEs(surface);

  const rows: {
    label: string;
    p1: React.ReactNode;
    p2: React.ReactNode;
  }[] = [
    {
      label: 'Elo general',
      p1: ratings.p1.overall,
      p2: ratings.p2.overall,
    },
    {
      label: `Elo ${surfLabel.toLowerCase()}`,
      p1: ratings.p1.surface ?? '—',
      p2: ratings.p2.surface ?? '—',
    },
    {
      label: 'Efectivo (0.7·sup + 0.3·gen)',
      p1: ratings.p1.effective,
      p2: ratings.p2.effective,
    },
    {
      label: 'Ajuste forma',
      p1: <Num value={form.p1.delta} plus />,
      p2: <Num value={form.p2.delta} plus />,
    },
    {
      label: 'Ajuste head-to-head',
      p1: <Num value={h2h.delta} plus />,
      p2: <Num value={-h2h.delta} plus />,
    },
    {
      label: 'Rating ajustado',
      p1: <strong>{adjustedRatings.p1}</strong>,
      p2: <strong>{adjustedRatings.p2}</strong>,
    },
    {
      label: 'Prob. del modelo',
      p1: <strong>{pct(prediction.model.prob1, 1)}</strong>,
      p2: <strong>{pct(prediction.model.prob2, 1)}</strong>,
    },
  ];

  return (
    <div className="mt-4 space-y-5 border-t border-slate-700/60 pt-4 text-sm">
      {/* Player headers */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <div className="text-slate-400">Señal</div>
        <div className="w-24 text-right font-semibold" style={{ color: P1_COLOR }}>
          {players.p1.name}
        </div>
        <div className="w-24 text-right font-semibold" style={{ color: P2_COLOR }}>
          {players.p2.name}
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[1fr_auto_auto] gap-2 -my-2">
          <div className="text-slate-400">{r.label}</div>
          <div className="w-24 text-right tabular-nums">{r.p1}</div>
          <div className="w-24 text-right tabular-nums">{r.p2}</div>
        </div>
      ))}

      {/* Form detail */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Forma reciente</div>
        <div className="grid grid-cols-2 gap-4">
          <FormBox name={players.p1.name} color={P1_COLOR} f={form.p1} />
          <FormBox name={players.p2.name} color={P2_COLOR} f={form.p2} />
        </div>
      </div>

      {/* Head-to-head */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-slate-500">Head-to-head</span>
          <span className="text-sm">
            <span style={{ color: P1_COLOR }}>{h2h.p1Wins}</span>
            <span className="text-slate-500"> – </span>
            <span style={{ color: P2_COLOR }}>{h2h.p2Wins}</span>
            <span className="ml-2 text-slate-500">({h2h.total} enfrentamientos)</span>
          </span>
        </div>
        {h2h.recent.length === 0 ? (
          <div className="text-slate-500">Sin enfrentamientos previos.</div>
        ) : (
          <ul className="space-y-1">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex items-center justify-between text-xs text-slate-300">
                <span>
                  {formatDate(m.date)} · {m.tourney_name} ({surfaceLabelEs(m.surface)}) {m.round}
                </span>
                <span className="text-slate-400">
                  ganó{' '}
                  <span style={{ color: m.winnerId === players.p1.id ? P1_COLOR : P2_COLOR }}>
                    {m.winnerId === players.p1.id ? players.p1.name : players.p2.name}
                  </span>{' '}
                  {m.score}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Market */}
      {market.market && (
        <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
          <div className="mb-2 uppercase tracking-wide text-slate-500">Mercado</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-300">
            <span>
              Cuotas: {market.market.odds1} / {market.market.odds2}
            </span>
            <span>
              Prob. implícita: {pct(market.market.implied1)} / {pct(market.market.implied2)}
            </span>
            <span>Overround: {pct(market.market.overround - 1, 1)}</span>
            {market.edge1 != null && (
              <span>
                Ventaja modelo ({players.p1.name}):{' '}
                <Num value={Math.round(market.edge1 * 1000) / 10} plus />
                {' pp'}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FormBox({
  name,
  color,
  f,
}: {
  name: string;
  color: string;
  f: Prediction['form']['p1'];
}) {
  const streakTxt =
    f.streak > 0 ? `${f.streak}V seguidas` : f.streak < 0 ? `${-f.streak}D seguidas` : '—';
  return (
    <div>
      <div className="mb-1 font-medium" style={{ color }}>
        {name}
      </div>
      <div className="text-xs text-slate-400">
        Últimos {f.sampleSize}: {pct(f.winRate)} victorias
      </div>
      <div className="text-xs text-slate-400">Racha: {streakTxt}</div>
    </div>
  );
}

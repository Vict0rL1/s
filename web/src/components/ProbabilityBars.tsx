import type { Prediction } from '../lib/api';
import { pct } from '../lib/format';

export const P1_COLOR = '#a3e635'; // lime-400
export const P2_COLOR = '#38bdf8'; // sky-400

function SplitBar({
  leftFrac,
  leftLabel,
  rightLabel,
  title,
}: {
  leftFrac: number | null;
  leftLabel: string;
  rightLabel: string;
  title: string;
}) {
  const hasData = leftFrac != null;
  const left = hasData ? Math.round(leftFrac * 1000) / 10 : 50;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
        <span>{title}</span>
      </div>
      <div className="flex h-6 w-full overflow-hidden rounded-md ring-1 ring-slate-700/60">
        <div
          className="flex items-center justify-start pl-2 text-xs font-semibold text-slate-900"
          style={{
            width: `${left}%`,
            backgroundColor: hasData ? P1_COLOR : '#475569',
          }}
          aria-label={`${title} ${leftLabel}`}
        >
          {hasData && left >= 18 ? leftLabel : ''}
        </div>
        <div
          className="flex items-center justify-end pr-2 text-xs font-semibold text-slate-900"
          style={{
            width: `${100 - left}%`,
            backgroundColor: hasData ? P2_COLOR : '#334155',
          }}
          aria-label={`${title} ${rightLabel}`}
        >
          {hasData && 100 - left >= 18 ? rightLabel : ''}
        </div>
      </div>
    </div>
  );
}

/**
 * Two "tug of war" bars, stacked: MODEL vs MARKET. The divider position shows
 * each player's win probability. Comparing where the two bars split shows
 * whether the model agrees with the bookmakers.
 */
export default function ProbabilityBars({ prediction }: { prediction: Prediction }) {
  const modelLeft = prediction.model.prob1;
  const market = prediction.market.market;
  const marketLeft = market ? market.implied1 : null;

  return (
    <div className="space-y-3">
      <SplitBar
        title="Modelo"
        leftFrac={modelLeft}
        leftLabel={pct(prediction.model.prob1)}
        rightLabel={pct(prediction.model.prob2)}
      />
      <SplitBar
        title="Mercado (odds sin vig)"
        leftFrac={marketLeft}
        leftLabel={market ? pct(market.implied1) : 'sin odds'}
        rightLabel={market ? pct(market.implied2) : ''}
      />
    </div>
  );
}

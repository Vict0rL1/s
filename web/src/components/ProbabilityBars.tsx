import type { Prediction } from '../lib/api';
import { pct } from '../lib/format';

// The shared, validated categorical pair — see lib/theme.ts. Player 1 wears the
// same blue as every home side in the app and player 2 the same orange, so the
// colour means one thing across all four tabs.
export { HOME_COLOR as P1_COLOR, AWAY_COLOR as P2_COLOR } from '../lib/theme';
import { AWAY_COLOR as P2, HOME_COLOR as P1 } from '../lib/theme';

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
      <div className="mb-1 flex items-center justify-between text-xs text-[#9aa1ac]">
        <span>{title}</span>
      </div>
      <div className="flex h-6 w-full overflow-hidden rounded-md ring-1 ring-white/[0.07]">
        <div
          className="flex items-center justify-start pl-2 text-xs font-semibold text-slate-900"
          style={{
            width: `${left}%`,
            backgroundColor: hasData ? P1 : '#475569',
          }}
          aria-label={`${title} ${leftLabel}`}
        >
          {hasData && left >= 18 ? leftLabel : ''}
        </div>
        <div
          className="flex items-center justify-end pr-2 text-xs font-semibold text-slate-900"
          style={{
            width: `${100 - left}%`,
            backgroundColor: hasData ? P2 : '#334155',
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
        leftLabel={pct(prediction.model.prob1, 1)}
        rightLabel={pct(prediction.model.prob2, 1)}
      />
      <SplitBar
        title="Mercado (odds sin vig)"
        leftFrac={marketLeft}
        leftLabel={market ? pct(market.implied1, 1) : 'sin odds'}
        rightLabel={market ? pct(market.implied2, 1) : ''}
      />
    </div>
  );
}

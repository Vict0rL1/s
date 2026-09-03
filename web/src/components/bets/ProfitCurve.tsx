import { useMemo, useState } from 'react';
import { BREAK_EVEN_COLOR, LOSS_COLOR, PROFIT_COLOR } from '../../lib/theme';
import { signed } from '../../lib/bets';

/**
 * Running profit over time. One series, so no legend — the heading names it.
 *
 * The zero line is the point of this chart: everything above it is a profit you
 * are holding and everything below is a hole you are in, so it is drawn as a real
 * axis rather than left to be inferred. The line takes the colour of where it
 * ENDED, because "am I up or down right now" is the question, and the fill is the
 * same hue at low alpha so the sign reads at a glance.
 *
 * 2px stroke, recessive axis, and a hover crosshair — the data-viz defaults. Under
 * three points it draws nothing: two dots joined by a line is not a trend, it is
 * two numbers pretending to be one.
 */
export default function ProfitCurve({
  points,
  height = 132,
}: {
  points: { day: string; profit: number }[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (points.length < 3) return null;
    const W = 600;
    const H = height;
    const padY = 12;
    const values = points.map((p) => p.profit);
    // The domain always includes zero, or the axis would sit off the chart and the
    // line would look like it never crossed.
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const span = hi - lo || 1;
    const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
    const y = (v: number) => padY + (1 - (v - lo) / span) * (H - padY * 2);
    return {
      W,
      H,
      x,
      y,
      zeroY: y(0),
      line: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.profit).toFixed(1)}`).join(' '),
      area:
        `M${x(0).toFixed(1)},${y(0).toFixed(1)} ` +
        points.map((p, i) => `L${x(i).toFixed(1)},${y(p.profit).toFixed(1)}`).join(' ') +
        ` L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} Z`,
    };
  }, [points, height]);

  if (!geo) return null;

  const final = points[points.length - 1].profit;
  const stroke = final > 0 ? PROFIT_COLOR : final < 0 ? LOSS_COLOR : BREAK_EVEN_COLOR;
  const shown = hover != null ? points[hover] : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
          Beneficio acumulado
        </span>
        <span className="text-[13px] tabular-nums text-[#9aa1ac]">
          {shown ? (
            <>
              {new Date(`${shown.day}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short' })} ·{' '}
              <span className="font-semibold text-[#e8eaed]">{signed(shown.profit)}</span>
            </>
          ) : (
            <span className="font-semibold" style={{ color: stroke }}>
              {signed(final)}
            </span>
          )}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${geo.W} ${geo.H}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Beneficio acumulado, termina en ${signed(final)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - r.left) / r.width;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(frac * (points.length - 1)))));
        }}
      >
        <path d={geo.area} fill={stroke} opacity={0.14} />
        <line x1={0} x2={geo.W} y1={geo.zeroY} y2={geo.zeroY} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
        <path d={geo.line} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {hover != null && (
          <>
            <line
              x1={geo.x(hover)}
              x2={geo.x(hover)}
              y1={0}
              y2={geo.H}
              stroke="rgba(255,255,255,0.28)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={geo.x(hover)}
              cy={geo.y(points[hover].profit)}
              r={4}
              fill={stroke}
              stroke="#14161b"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
    </div>
  );
}

import type { FbGoalMargin, FbPrediction } from '../../lib/football';
import { AWAY_COLOR, DRAW_COLOR, HOME_COLOR, inkOn, withAlpha } from '../../lib/theme';
import { Panel, SectionTitle } from '../ui';

/**
 * The full exact-score grid.
 *
 * A list of "most likely scorelines" answers a narrower question than it looks
 * like it does. 1-1 at 13% sounds decisive until you notice that the six named
 * scores together are barely half the probability in the match, and that the
 * three blocks of the grid — home wins, draws, away wins — are what the 1X2 price
 * is actually made of. Laid out as a matrix, all of that is visible at once:
 * where the mass sits, how lopsided it is, and how much of it is nowhere near the
 * headline score.
 *
 * Nothing here is computed in the browser. `grid.cells[h][a]` is the same object
 * the 1X2, the over/under and both-teams-to-score are sums of on the server, so
 * the matrix cannot drift from the numbers printed above it.
 */
export default function ScoreMatrix({ prediction }: { prediction: FbPrediction }) {
  const { grid, margins } = prediction.goals;
  const home = prediction.teams.home;
  const away = prediction.teams.away;
  const n = grid.maxGoals;

  // Shading is relative to the single most likely cell, not to 100%: the peak of
  // a football score distribution is around 12%, so an absolute scale would leave
  // the entire grid the same shade of nearly-nothing.
  const peak = Math.max(...grid.cells.flat());
  const best = { h: 0, a: 0, p: -1 };
  grid.cells.forEach((row, h) =>
    row.forEach((p, a) => {
      if (p > best.p) Object.assign(best, { h, a, p });
    }),
  );

  return (
    <Panel>
      <SectionTitle right={`filas = ${home.name} · columnas = ${away.name}`}>
        Probabilidad de cada marcador
      </SectionTitle>

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[22rem] border-separate border-spacing-0.5 text-center text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className="w-7" />
              {Array.from({ length: n + 1 }, (_, a) => (
                <th key={a} className="pb-0.5 font-medium" style={{ color: AWAY_COLOR }}>
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.cells.map((row, h) => (
              <tr key={h}>
                <th className="pr-1 text-right font-medium" style={{ color: HOME_COLOR }}>
                  {h}
                </th>
                {row.map((p, a) => (
                  <Cell
                    key={a}
                    p={p}
                    peak={peak}
                    outcome={h > a ? 'home' : h === a ? 'draw' : 'away'}
                    top={h === best.h && a === best.a}
                    title={`${home.name} ${h}–${a} ${away.name}: ${(p * 100).toFixed(2)}%`}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Legend prediction={prediction} tail={grid.tail} />
      <Margins margins={margins} homeName={home.name} awayName={away.name} />
    </Panel>
  );
}

function Cell({
  p, peak, outcome, top, title,
}: {
  p: number;
  peak: number;
  outcome: 'home' | 'draw' | 'away';
  top: boolean;
  title: string;
}) {
  const color = outcome === 'home' ? HOME_COLOR : outcome === 'draw' ? DRAW_COLOR : AWAY_COLOR;
  // Square-rooted so the low-probability cells stay legible instead of collapsing
  // into the background; the eye reads area, not linear opacity.
  const strength = peak > 0 ? Math.sqrt(p / peak) : 0;
  const shown = p >= 0.001 ? (p * 100).toFixed(1) : '·';
  return (
    <td
      title={title}
      className={`rounded px-0.5 py-1 ${top ? 'ring-1 ring-slate-200/70' : ''}`}
      style={{
        backgroundColor: withAlpha(color, strength * 0.85),
        color: inkOn(strength),
        fontWeight: top ? 700 : 400,
      }}
    >
      {shown}
    </td>
  );
}

function Legend({ prediction, tail }: { prediction: FbPrediction; tail: number }) {
  const { model } = prediction;
  const items = [
    { label: `Gana ${prediction.teams.home.name}`, value: model.home, color: HOME_COLOR },
    { label: 'Empate', value: model.draw, color: DRAW_COLOR },
    { label: `Gana ${prediction.teams.away.name}`, value: model.away, color: AWAY_COLOR },
  ];
  return (
    <>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px]">
        {items.map((i) => (
          <div key={i.label} className="rounded bg-slate-900/50 px-1 py-1.5">
            <div
              className="mx-auto mb-1 h-1 w-8 rounded"
              style={{ backgroundColor: i.color }}
            />
            <div className="truncate text-slate-400" title={i.label}>{i.label}</div>
            <div className="font-semibold tabular-nums text-slate-100">
              {(i.value * 100).toFixed(1)}%
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-500">
        Cada bloque de color suma exactamente la probabilidad de ese resultado.
        {tail > 0.0005 && (
          <> Marcadores con más de {prediction.goals.grid.maxGoals} goles por equipo: {(tail * 100).toFixed(2)}%.</>
        )}
      </p>
    </>
  );
}

/**
 * Winning margin — the diagonals of the same grid.
 *
 * "Who wins" and "by how much" are different questions, and two matches with the
 * same 1X2 can be completely different bets on the handicap. Worth its own row.
 */
function Margins({
  margins, homeName, awayName,
}: {
  margins: FbGoalMargin[];
  homeName: string;
  awayName: string;
}) {
  const peak = Math.max(...margins.map((m) => m.probability));
  const edge = Math.max(...margins.map((m) => Math.abs(m.margin)));
  return (
    <div className="mt-3 border-t border-slate-700/50 pt-2">
      <div className="mb-1.5 text-xs uppercase tracking-wide text-slate-500">
        Diferencia de goles
      </div>
      <div className="space-y-0.5">
        {margins.map((m) => {
          const color = m.margin > 0 ? HOME_COLOR : m.margin === 0 ? DRAW_COLOR : AWAY_COLOR;
          const atEdge = Math.abs(m.margin) === edge;
          const label =
            m.margin === 0
              ? 'empate'
              : `${m.margin > 0 ? homeName : awayName} por ${Math.abs(m.margin)}${atEdge ? '+' : ''}`;
          return (
            <div key={m.margin} className="flex items-center gap-2 text-[11px]">
              {/* The outermost rows absorb everything beyond them, so they are
                  "5 or more", not "exactly 5". */}
              <span className="w-9 text-right tabular-nums text-slate-300">
                {atEdge && m.margin !== 0
                  ? `${m.margin > 0 ? '≥+' : '≤−'}${edge}`
                  : m.margin > 0
                    ? `+${m.margin}`
                    : m.margin}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-slate-700/40">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${peak > 0 ? (m.probability / peak) * 100 : 0}%`,
                    backgroundColor: color,
                  }}
                  title={`${label}: ${(m.probability * 100).toFixed(1)}%`}
                />
              </div>
              <span className="w-11 text-right tabular-nums text-slate-400">
                {(m.probability * 100).toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

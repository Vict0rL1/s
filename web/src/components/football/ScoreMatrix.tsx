import type { FbGoalMargin, FbPrediction } from '../../lib/football';
import { AWAY_COLOR, DRAW_COLOR, HOME_COLOR, inkOn, withAlpha } from '../../lib/theme';
import { Panel, SectionTitle } from '../ui';
import { useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

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
  const { t } = useI18n();
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
      <SectionTitle right={t('sm.ejes', { local: home.name, visitante: away.name })}>
        {t('det.probMarcador')}
      </SectionTitle>

      <div className="-mx-1 overflow-x-auto px-1" tabIndex={0}>
        <table className="w-full min-w-[22rem] border-separate border-spacing-0.5 text-center text-[13px] tabular-nums">
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
                    title={`${home.name} ${h}–${a} ${away.name}: ${pctF(p, 2)}`}
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
  const shown = p >= 0.001 ? numF(p * 100, 1) : '·';
  return (
    <td
      title={title}
      className={`rounded px-0.5 py-1 ${top ? 'ring-1 ring-(--line-strong)' : ''}`}
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
  const { t } = useI18n();
  const { model } = prediction;
  const items = [
    { label: t('pm.gana', { nombre: prediction.teams.home.name }), value: model.home, color: HOME_COLOR },
    { label: t('fbc.empateBarra'), value: model.draw, color: DRAW_COLOR },
    { label: t('pm.gana', { nombre: prediction.teams.away.name }), value: model.away, color: AWAY_COLOR },
  ];
  return (
    <>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[13px]">
        {items.map((i) => (
          <div key={i.label} className="rounded bg-(--tint) px-1 py-1.5">
            <div
              className="mx-auto mb-1 h-1 w-8 rounded"
              style={{ backgroundColor: i.color }}
            />
            <div className="break-words text-(--ink-soft)" title={i.label}>{i.label}</div>
            <div className="font-semibold tabular-nums text-(--ink-strong)">
              {pctF(i.value, 1)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[13px] text-(--ink-muted)">
        {t('sm.sumaBloque')}
        {tail > 0.0005 && (
          <> {t('sm.cola', { n: prediction.goals.grid.maxGoals, p: numF(tail * 100, 2) })}</>
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
  const { t } = useI18n();
  const peak = Math.max(...margins.map((m) => m.probability));
  const edge = Math.max(...margins.map((m) => Math.abs(m.margin)));
  return (
    <div className="mt-3 border-t border-(--line) pt-2">
      <div className="mb-1.5 text-[14px] uppercase tracking-wide text-(--ink-muted)">
        {t('sm.diferenciaGoles')}
      </div>
      <div className="space-y-0.5">
        {margins.map((m) => {
          const color = m.margin > 0 ? HOME_COLOR : m.margin === 0 ? DRAW_COLOR : AWAY_COLOR;
          const atEdge = Math.abs(m.margin) === edge;
          const label =
            m.margin === 0
              ? t('fbc.empateValue')
              : t('sm.porMargen', { equipo: m.margin > 0 ? homeName : awayName, n: `${Math.abs(m.margin)}${atEdge ? '+' : ''}` });
          return (
            <div key={m.margin} className="flex items-center gap-2 text-[13px]">
              {/* The outermost rows absorb everything beyond them, so they are
                  "5 or more", not "exactly 5". */}
              <span className="w-9 text-right tabular-nums text-(--ink-body)">
                {atEdge && m.margin !== 0
                  ? `${m.margin > 0 ? '≥+' : '≤−'}${edge}`
                  : m.margin > 0
                    ? `+${m.margin}`
                    : m.margin}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-(--raised)">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${peak > 0 ? (m.probability / peak) * 100 : 0}%`,
                    backgroundColor: color,
                  }}
                  title={`${label}: ${pctF(m.probability, 1)}`}
                />
              </div>
              <span className="w-11 text-right tabular-nums text-(--ink-soft)">
                {pctF(m.probability, 1)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import type { BsbPrediction, BsbRunMargin } from '../../lib/baseball';
import { AWAY_COLOR, HOME_COLOR, inkOn, withAlpha } from '../../lib/theme';
import { Panel, SectionTitle } from '../ui';

/**
 * The full run-by-run grid.
 *
 * Flatter than the football version, and that flatness IS the information. A
 * football match has a most-likely score at around 12%; baseball's peak is barely
 * 3%, because runs are overdispersed and there are simply far more plausible
 * final scores. Anyone who reads "4-3 is the most likely result" as a prediction
 * is being misled by the phrase, and seeing the whole grid fixes that in a way no
 * top-six list can.
 *
 * The diagonal is empty ON PURPOSE: a final baseball score is never tied. The
 * probability that used to sit there is the chance of extra innings, and the
 * server has already pushed it into the one-run cells either side.
 */
export default function RunMatrix({ prediction }: { prediction: BsbPrediction }) {
  const { grid, margins, extraInnings } = prediction.runs;
  const home = prediction.teams.home;
  const away = prediction.teams.away;
  const n = grid.maxRuns;

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
        <table className="w-full min-w-[26rem] border-separate border-spacing-0.5 text-center text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className="w-6" />
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
                    home={h > a}
                    tied={h === a}
                    top={h === best.h && a === best.a}
                    title={
                      h === a
                        ? 'Un marcador final nunca queda empatado: se va a entradas extra'
                        : `${home.name} ${h}–${a} ${away.name}: ${(p * 100).toFixed(2)}%`
                    }
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-center text-[13px]">
        <div className="rounded bg-white/[0.03] px-1 py-1.5">
          <div className="mx-auto mb-1 h-1 w-8 rounded" style={{ backgroundColor: HOME_COLOR }} />
          <div className="truncate text-[#9aa1ac]" title={home.name}>Gana {home.name}</div>
          <div className="font-semibold tabular-nums text-[#e8eaed]">
            {(prediction.model.home * 100).toFixed(1)}%
          </div>
        </div>
        <div className="rounded bg-white/[0.03] px-1 py-1.5">
          <div className="mx-auto mb-1 h-1 w-8 rounded" style={{ backgroundColor: AWAY_COLOR }} />
          <div className="truncate text-[#9aa1ac]" title={away.name}>Gana {away.name}</div>
          <div className="font-semibold tabular-nums text-[#e8eaed]">
            {(prediction.model.away * 100).toFixed(1)}%
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[#7b828d]">
        La diagonal está vacía porque un marcador final nunca queda empatado: esa probabilidad
        ({(extraInnings * 100).toFixed(1)}%, las entradas extra) ya está repartida en las casillas de
        una carrera de diferencia.
        {grid.tail > 0.0005 && (
          <> Marcadores con más de {n} carreras por equipo: {(grid.tail * 100).toFixed(2)}%.</>
        )}
      </p>

      <Margins margins={margins} homeName={home.name} awayName={away.name} />
    </Panel>
  );
}

function Cell({
  p, peak, home, tied, top, title,
}: {
  p: number; peak: number; home: boolean; tied: boolean; top: boolean; title: string;
}) {
  if (tied) {
    return (
      <td
        title={title}
        className="rounded bg-white/[0.03] px-0.5 py-1 text-[#5c636c]"
        aria-label="imposible: empate"
      >
        ×
      </td>
    );
  }
  const color = home ? HOME_COLOR : AWAY_COLOR;
  const strength = peak > 0 ? Math.sqrt(p / peak) : 0;
  return (
    <td
      title={title}
      className={`rounded px-0.5 py-1 ${top ? 'ring-1 ring-white/40' : ''}`}
      style={{
        backgroundColor: withAlpha(color, strength * 0.85),
        color: inkOn(strength),
        fontWeight: top ? 700 : 400,
      }}
    >
      {p >= 0.001 ? (p * 100).toFixed(1) : '·'}
    </td>
  );
}

/**
 * Winning margin — the diagonals of the same grid.
 *
 * The row that matters most in baseball is ±1: the run line is fixed at 1.5, so
 * "wins by exactly one" is the difference between covering and not, and it is the
 * single most likely margin in the sport.
 */
function Margins({
  margins, homeName, awayName,
}: {
  margins: BsbRunMargin[]; homeName: string; awayName: string;
}) {
  const shown = margins.filter((m) => m.margin !== 0);
  const peak = Math.max(...shown.map((m) => m.probability));
  const edge = Math.max(...shown.map((m) => Math.abs(m.margin)));
  return (
    <div className="mt-3 border-t border-white/[0.07] pt-2">
      <div className="mb-1.5 text-[14px] uppercase tracking-wide text-[#7b828d]">
        Diferencia de carreras
      </div>
      <div className="space-y-0.5">
        {shown.map((m) => {
          const atEdge = Math.abs(m.margin) === edge;
          const label = `${m.margin > 0 ? homeName : awayName} por ${Math.abs(m.margin)}${atEdge ? ' o más' : ''}`;
          return (
            <div key={m.margin} className="flex items-center gap-2 text-[13px]">
              <span className="w-9 text-right tabular-nums text-[#c3c9d1]">
                {atEdge ? `${m.margin > 0 ? '≥+' : '≤−'}${edge}` : m.margin > 0 ? `+${m.margin}` : m.margin}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-white/[0.06]">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${peak > 0 ? (m.probability / peak) * 100 : 0}%`,
                    backgroundColor: m.margin > 0 ? HOME_COLOR : AWAY_COLOR,
                  }}
                  title={`${label}: ${(m.probability * 100).toFixed(1)}%`}
                />
              </div>
              <span className="w-11 text-right tabular-nums text-[#9aa1ac]">
                {(m.probability * 100).toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[13px] text-[#7b828d]">
        La línea de carreras se juega a ±1.5, así que todo lo que sea ganar por una carrera —el
        margen más frecuente del béisbol— no cubre.
      </p>
    </div>
  );
}

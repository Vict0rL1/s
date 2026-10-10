import type { BsbPrediction, BsbRunMargin } from '../../lib/baseball';
import { AWAY_COLOR, HOME_COLOR, inkOn, withAlpha } from '../../lib/theme';
import { Panel, SectionTitle } from '../ui';
import { useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

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
  const { t } = useI18n();
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
      <SectionTitle right={t('sm.ejes', { local: home.name, visitante: away.name })}>
        {t('det.probMarcador')}
      </SectionTitle>

      <div className="-mx-1 overflow-x-auto px-1" tabIndex={0}>
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
                        ? t('rm.empate')
                        : `${home.name} ${h}–${a} ${away.name}: ${pctF(p, 2)}`
                    }
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-center text-[13px]">
        <div className="rounded bg-(--tint) px-1 py-1.5">
          <div className="mx-auto mb-1 h-1 w-8 rounded" style={{ backgroundColor: HOME_COLOR }} />
          <div className="break-words text-(--ink-soft)" title={home.name}>{t('pm.gana', { nombre: home.name })}</div>
          <div className="font-semibold tabular-nums text-(--ink-strong)">
            {pctF(prediction.model.home, 1)}
          </div>
        </div>
        <div className="rounded bg-(--tint) px-1 py-1.5">
          <div className="mx-auto mb-1 h-1 w-8 rounded" style={{ backgroundColor: AWAY_COLOR }} />
          <div className="break-words text-(--ink-soft)" title={away.name}>{t('pm.gana', { nombre: away.name })}</div>
          <div className="font-semibold tabular-nums text-(--ink-strong)">
            {pctF(prediction.model.away, 1)}
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-(--ink-muted)">
        {t('rm.diagonal', { p: numF(extraInnings * 100, 1) })}
        {grid.tail > 0.0005 && (
          <> {t('rm.cola', { n, p: numF(grid.tail * 100, 2) })}</>
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
  const { t } = useI18n();
  if (tied) {
    return (
      <td
        title={title}
        className="rounded bg-(--tint) px-0.5 py-1 text-(--ink-faint)"
        aria-label={t('rm.imposible')}
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
      className={`rounded px-0.5 py-1 ${top ? 'ring-1 ring-(--line-strong)' : ''}`}
      style={{
        backgroundColor: withAlpha(color, strength * 0.85),
        color: inkOn(strength),
        fontWeight: top ? 700 : 400,
      }}
    >
      {p >= 0.001 ? numF(p * 100, 1) : '·'}
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
  const { t } = useI18n();
  const shown = margins.filter((m) => m.margin !== 0);
  const peak = Math.max(...shown.map((m) => m.probability));
  const edge = Math.max(...shown.map((m) => Math.abs(m.margin)));
  return (
    <div className="mt-3 border-t border-(--line) pt-2">
      <div className="mb-1.5 text-[14px] uppercase tracking-wide text-(--ink-muted)">
        {t('rm.diferencia')}
      </div>
      <div className="space-y-0.5">
        {shown.map((m) => {
          const atEdge = Math.abs(m.margin) === edge;
          const label = t(atEdge ? 'rm.porMargenMas' : 'rm.porMargen', { equipo: m.margin > 0 ? homeName : awayName, n: Math.abs(m.margin) });
          return (
            <div key={m.margin} className="flex items-center gap-2 text-[13px]">
              <span className="w-9 text-right tabular-nums text-(--ink-body)">
                {atEdge ? `${m.margin > 0 ? '≥+' : '≤−'}${edge}` : m.margin > 0 ? `+${m.margin}` : m.margin}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-(--raised)">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${peak > 0 ? (m.probability / peak) * 100 : 0}%`,
                    backgroundColor: m.margin > 0 ? HOME_COLOR : AWAY_COLOR,
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
      <p className="mt-1.5 text-[13px] text-(--ink-muted)">
        {t('rm.linea')}
      </p>
    </div>
  );
}

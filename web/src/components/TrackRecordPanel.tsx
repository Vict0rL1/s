import { useEffect, useState } from 'react';
import { api, type TrackRecord } from '../lib/api';

/**
 * The app's own scorecard.
 *
 * `npm run backtest` reports how the model does on 20 years of history — useful,
 * but it is not evidence about the matches this user actually looked at. This
 * panel answers that instead: every prediction shown for a real fixture is
 * recorded before the match, then scored once the result arrives.
 *
 * It stays deliberately unflattering. The market's accuracy on the same matches
 * sits next to the model's, an empty record says so plainly rather than showing
 * a reassuring blank, and small samples are labelled as small.
 */
export default function TrackRecordPanel({ tour }: { tour: string }) {
  const [data, setData] = useState<TrackRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .trackRecord(tour)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [tour]);

  // Nothing recorded yet and nothing pending → don't take up space with an
  // empty widget on a fresh install.
  if (failed || !data || (data.resolved === 0 && data.pending === 0)) return null;

  const acc = data.accuracy;
  // Under ~30 resolved matches the percentage swings several points on a single
  // result, so it is presented as provisional rather than as a measurement.
  const thin = data.resolved > 0 && data.resolved < 30;

  return (
    <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-800/40 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Aciertos reales de la app
          </span>
          <br />
          {data.resolved === 0 ? (
            <span className="text-slate-300">
              {data.pending} predicción(es) registradas, esperando resultado.
            </span>
          ) : (
            <span className="text-slate-100">
              <strong className="tabular-nums">{((acc ?? 0) * 100).toFixed(1)}%</strong> de acierto
              en <strong className="tabular-nums">{data.resolved}</strong> predicciones ya jugadas
              {data.pending > 0 && (
                <span className="text-slate-400"> · {data.pending} pendientes</span>
              )}
              {thin && <span className="text-amber-400"> · muestra pequeña</span>}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-sky-400">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4 border-t border-slate-700/60 pt-3 text-xs">
          <p className="text-slate-400">
            Cada predicción se guarda <strong>antes</strong> de que se juegue el partido y se
            puntúa cuando llega el resultado real (al ejecutar{' '}
            <code className="rounded bg-slate-900/60 px-1">npm run update-data</code>). No es el
            backtest histórico: son los partidos que viste en esta app.
          </p>

          {data.resolved > 0 && (
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Acierto" value={`${((acc ?? 0) * 100).toFixed(1)}%`} />
              <Stat label="Brier" value={data.brier?.toFixed(4) ?? '—'} hint="menor es mejor" />
              <Stat label="Log loss" value={data.logLoss?.toFixed(4) ?? '—'} hint="menor es mejor" />
            </div>
          )}

          {/* The comparison that matters: same matches, model vs bookmakers. */}
          {data.vsMarket && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-slate-500">
                Modelo vs mercado ({data.vsMarket.n} partidos con cuotas)
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 font-normal">&nbsp;</th>
                    <th className="py-1 font-normal">Acierto</th>
                    <th className="py-1 font-normal">Brier</th>
                  </tr>
                </thead>
                <tbody className="text-slate-200">
                  <tr>
                    <td className="py-1 text-slate-400">Modelo</td>
                    <td>{fmtPct(data.vsMarket.modelAccuracy)}</td>
                    <td>{data.vsMarket.modelBrier?.toFixed(4) ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-slate-400">Mercado</td>
                    <td>{fmtPct(data.vsMarket.marketAccuracy)}</td>
                    <td>{data.vsMarket.marketBrier?.toFixed(4) ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
              {data.vsMarket.disagreements > 0 && (
                <p className="mt-1 text-slate-400">
                  Discreparon en {data.vsMarket.disagreements} partidos; el modelo acertó en{' '}
                  {fmtPct(data.vsMarket.modelRightOnDisagreement)} de ellos.
                </p>
              )}
            </div>
          )}

          {/* Does the reliability badge predict anything? Checked here. */}
          {data.byReliability.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-slate-500">
                Por fiabilidad declarada
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 font-normal">Nivel</th>
                    <th className="py-1 font-normal">n</th>
                    <th className="py-1 font-normal">Acierto</th>
                    <th className="py-1 font-normal">Brier</th>
                  </tr>
                </thead>
                <tbody className="text-slate-200">
                  {data.byReliability.map((r) => (
                    <tr key={r.level}>
                      <td className="py-1 text-slate-400">{LEVEL_ES[r.level] ?? r.level}</td>
                      <td>{r.n}</td>
                      <td>{fmtPct(r.accuracy)}</td>
                      <td>{r.brier?.toFixed(4) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-slate-500">
                Si el semáforo sirve, «alta» debería tener mejor Brier que «baja».
              </p>
            </div>
          )}

          {/* Calibration: does "70%" actually win 70% of the time? */}
          {data.calibration.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-slate-500">
                Calibración (dicho vs ocurrido)
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 font-normal">Banda</th>
                    <th className="py-1 font-normal">n</th>
                    <th className="py-1 font-normal">Dijo</th>
                    <th className="py-1 font-normal">Ganó</th>
                  </tr>
                </thead>
                <tbody className="text-slate-200">
                  {data.calibration.map((b) => (
                    <tr key={b.label}>
                      <td className="py-1 text-slate-400">{b.label}</td>
                      <td>{b.n}</td>
                      <td>{fmtPct(b.predicted)}</td>
                      <td>{fmtPct(b.observed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.recent.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-slate-500">Últimas resueltas</div>
              <ul className="space-y-1">
                {data.recent.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={r.hit ? 'text-emerald-400' : 'text-rose-400'}>
                      {r.hit ? '✓' : '✗'}
                    </span>
                    <span className="text-slate-300">
                      {r.p1} vs {r.p2}
                      <span className="text-slate-500">
                        {' '}
                        — dijo {fmtPct(Math.max(r.prob1, 1 - r.prob1))} para{' '}
                        {r.prob1 >= 0.5 ? r.p1 : r.p2}; ganó {r.winnerIsP1 ? r.p1 : r.p2}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const LEVEL_ES: Record<string, string> = { high: 'alta', medium: 'media', low: 'baja' };

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded bg-slate-900/50 p-2">
      <div className="text-slate-500">{label}</div>
      <div className="tabular-nums text-slate-100">{value}</div>
      {hint && <div className="text-[10px] text-slate-600">{hint}</div>}
    </div>
  );
}

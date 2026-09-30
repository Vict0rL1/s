import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { Health, RiskResponse } from '../../api/types'
import { fmtBig, fmtNumber, fmtPct } from '../../lib/format'
import { SourceBadge } from '../SourceBadge'

const ZONE_STYLES: Record<string, string> = {
  segura: 'bg-emerald-100 text-emerald-700',
  gris: 'bg-amber-100 text-amber-700',
  riesgo: 'bg-red-100 text-red-700',
}

export function HealthSection({ symbol }: { symbol: string }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [risk, setRisk] = useState<RiskResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setHealth(null)
    setRisk(null)
    setError(null)
    api.health(symbol).then(setHealth, (e) => setError(e.message))
    api.risk(symbol).then(setRisk, () => setRisk(null))
  }, [symbol])

  if (error)
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Sin datos de salud financiera: {error}
      </p>
    )
  if (!health) return <p className="text-sm text-slate-400">Cargando salud financiera…</p>

  const z = health.altman_z
  const f = health.piotroski_f

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">
              Altman Z-score <span className="font-normal text-slate-400">({health.fiscal_year})</span>
            </h2>
            <SourceBadge data={health} />
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums text-slate-900">
              {z.score !== null ? fmtNumber(z.score) : '—'}
            </span>
            {z.zone && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ZONE_STYLES[z.zone]}`}>
                zona {z.zone}
              </span>
            )}
          </div>
          <dl className="mt-3 space-y-1 text-xs text-slate-500">
            {Object.entries(z.components).map(([key, value]) => (
              <div key={key} className="flex justify-between">
                <dt>{key.replace(/_/g, ' ').replace(/^x\d /, '')}</dt>
                <dd className="tabular-nums">{value !== null ? fmtNumber(value, 3) : 'sin dato'}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-slate-400">{z.note}</p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">
            Piotroski F-score{' '}
            <span className="font-normal text-slate-400">
              ({f.fiscal_years?.join(' → ') ?? '—'})
            </span>
          </h2>
          <div className="text-3xl font-semibold tabular-nums text-slate-900">
            {f.score !== null ? `${f.score} / ${f.max_possible}` : '—'}
          </div>
          {f.max_possible < 9 && (
            <p className="text-xs text-amber-600">
              Solo {f.max_possible} de 9 señales evaluables con los datos reportados.
            </p>
          )}
          <ul className="mt-2 space-y-1 text-xs">
            {f.signals.map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    s.passed === null ? 'bg-slate-300' : s.passed ? 'bg-emerald-500' : 'bg-red-400'
                  }`}
                />
                <span className={s.passed === null ? 'text-slate-400' : 'text-slate-600'}>
                  {s.name}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Deuda y riesgo</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <div>
            <dt className="text-xs text-slate-400">Cobertura de intereses</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {health.interest_coverage !== null ? `${fmtNumber(health.interest_coverage, 1)}×` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Deuda neta</dt>
            <dd className="text-lg font-semibold tabular-nums">{fmtBig(health.net_debt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">FCF (último ejercicio)</dt>
            <dd className="text-lg font-semibold tabular-nums">{fmtBig(health.fcf)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Beta vs. SPY (1A)</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {risk?.beta_vs_spy != null ? fmtNumber(risk.beta_vs_spy) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Volatilidad anualizada</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {risk?.annualized_volatility != null ? fmtPct(risk.annualized_volatility) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Máx. drawdown (1A)</dt>
            <dd className="text-lg font-semibold tabular-nums text-red-600">
              {risk?.max_drawdown ? fmtPct(risk.max_drawdown.max_drawdown) : '—'}
            </dd>
          </div>
        </dl>
        {risk?.max_drawdown && (
          <p className="mt-2 text-xs text-slate-400">
            Drawdown: pico {risk.max_drawdown.peak} → valle {risk.max_drawdown.trough}. Ventana:{' '}
            {risk.window}.
          </p>
        )}
      </section>
    </div>
  )
}

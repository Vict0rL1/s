import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { FilterSpec, ScreenerPreset, ScreenResult } from '../api/types'
import { fmtNumber, fmtPct } from '../lib/format'

const METRIC_LABELS: Record<string, string> = {
  pe_ttm: 'P/E (TTM)',
  pb: 'P/B',
  ps_ttm: 'P/S',
  roe: 'ROE',
  gross_margin: 'Margen bruto',
  operating_margin: 'Margen operativo',
  net_margin: 'Margen neto',
  debt_to_equity: 'Deuda / Capital',
  current_ratio: 'Ratio corriente',
  dividend_yield: 'Div. yield',
  revenue_growth_5y: 'Crec. ingresos 5A',
  eps_growth_5y: 'Crec. EPS 5A',
  beta: 'Beta',
  market_cap: 'Capitalización',
}

const PCT_METRICS = new Set([
  'roe', 'gross_margin', 'operating_margin', 'net_margin',
  'dividend_yield', 'revenue_growth_5y', 'eps_growth_5y',
])

function fmtMetric(metric: string, value: number | null) {
  if (value === null || value === undefined) return '—'
  return PCT_METRICS.has(metric) ? fmtPct(value) : fmtNumber(value)
}

function describeFilter(metric: string, spec: FilterSpec) {
  const label = METRIC_LABELS[metric] ?? metric
  const op = spec.op === 'gte' ? '≥' : '≤'
  const value = PCT_METRICS.has(metric) ? `${(spec.value * 100).toFixed(1)} %` : spec.value
  return `${label} ${op} ${value}`
}

export function ScreenerPage() {
  const [presets, setPresets] = useState<ScreenerPreset[]>([])
  const [active, setActive] = useState<ScreenerPreset | null>(null)
  const [universe, setUniverse] = useState('AAPL, MSFT, JNJ, KO, XOM, JPM, PG, VZ')
  const [result, setResult] = useState<ScreenResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.screenerPresets().then(
      (d) => {
        const all = [...d.builtin, ...d.saved]
        setPresets(all)
        setActive(all[0] ?? null)
      },
      () => setPresets([]),
    )
  }, [])

  const run = async () => {
    if (!active) return
    const symbols = universe
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 25)
    if (symbols.length === 0) return
    setBusy(true)
    setError(null)
    try {
      setResult(await api.runScreen({ symbols, filters: active.filters }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">Screener</h1>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Preset</h2>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.name}
              onClick={() => setActive(preset)}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                active?.name === preset.name
                  ? 'bg-slate-900 font-medium text-white'
                  : 'border border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {preset.name}
            </button>
          ))}
          {presets.length === 0 && <p className="text-sm text-slate-400">Cargando presets…</p>}
        </div>

        {active && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3">
            <p className="text-sm text-slate-600">{active.logic_md}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(active.filters).map(([metric, spec]) => (
                <span
                  key={metric}
                  className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200"
                >
                  {describeFilter(metric, spec)}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">
          Universo a evaluar{' '}
          <span className="font-normal text-slate-400">(máx. 25 tickers, separados por coma)</span>
        </h2>
        <textarea
          value={universe}
          onChange={(e) => setUniverse(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={run}
            disabled={busy || !active}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? 'Evaluando…' : 'Ejecutar screener'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </section>

      {result && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-700">
              {result.passed} de {result.evaluated} pasan el filtro
            </h2>
          </div>
          <p className="mb-3 text-xs text-slate-400">{result.note}</p>

          <ul className="space-y-2">
            {result.results.map((row) => (
              <li
                key={row.symbol}
                className={`rounded-lg border p-3 ${
                  row.passes ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <Link
                    to={`/ticker/${row.symbol}`}
                    className="font-medium text-slate-800 hover:underline"
                  >
                    {row.symbol}
                  </Link>
                  <span
                    className={`text-xs font-medium ${
                      row.passes ? 'text-emerald-700' : 'text-slate-400'
                    }`}
                  >
                    {row.passes ? 'Pasa' : 'No pasa'}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {row.checks.map((check) => (
                    <span
                      key={check.metric}
                      title={`${METRIC_LABELS[check.metric] ?? check.metric}: ${fmtMetric(
                        check.metric,
                        check.actual,
                      )}`}
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        check.passed
                          ? 'bg-white text-slate-600 ring-1 ring-slate-200'
                          : 'bg-red-50 text-red-700 ring-1 ring-red-200'
                      }`}
                    >
                      {METRIC_LABELS[check.metric] ?? check.metric}:{' '}
                      {fmtMetric(check.metric, check.actual)}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          {result.unavailable.length > 0 && (
            <p className="mt-3 text-xs text-slate-400">
              Sin fundamentales: {result.unavailable.map((u) => u.symbol).join(', ')}
            </p>
          )}
        </section>
      )}
    </div>
  )
}

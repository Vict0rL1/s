import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { DcfResponse, ScenarioAssumptions, ValuationDefaults } from '../../api/types'
import { fmtBig, fmtNumber, fmtPct } from '../../lib/format'
import { SourceBadge } from '../SourceBadge'

type ScenarioName = 'bear' | 'base' | 'bull'
const SCENARIO_LABELS: Record<ScenarioName, string> = {
  bear: 'Bajista',
  base: 'Base',
  bull: 'Alcista',
}

interface Inputs {
  base_fcf: string
  net_debt: string
  shares_outstanding: string
  years: string
  scenarios: Record<ScenarioName, { growth: string; wacc: string; terminal: string }>
}

function pctInput(value: number): string {
  return (value * 100).toFixed(1)
}

export function ValuationSection({ symbol }: { symbol: string }) {
  const [defaults, setDefaults] = useState<ValuationDefaults | null>(null)
  const [inputs, setInputs] = useState<Inputs | null>(null)
  const [result, setResult] = useState<DcfResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDefaults(null)
    setInputs(null)
    setResult(null)
    setError(null)
    api.valuationDefaults(symbol).then((d) => {
      setDefaults(d)
      const g = d.suggested_growth_capped ?? 0.05
      setInputs({
        base_fcf: d.base_fcf !== null ? String(Math.round(d.base_fcf)) : '',
        net_debt: d.net_debt !== null ? String(Math.round(d.net_debt)) : '0',
        shares_outstanding:
          d.shares_outstanding !== null ? String(Math.round(d.shares_outstanding)) : '',
        years: '5',
        scenarios: {
          bear: { growth: pctInput(Math.max(g - 0.03, -0.05)), wacc: '11.0', terminal: '2.0' },
          base: { growth: pctInput(g), wacc: '10.0', terminal: '2.5' },
          bull: { growth: pctInput(g + 0.03), wacc: '9.0', terminal: '3.0' },
        },
      })
    }, (e) => setError(e.message))
  }, [symbol])

  const run = async () => {
    if (!inputs) return
    setBusy(true)
    setError(null)
    try {
      const scenarios: Record<string, ScenarioAssumptions> = {}
      for (const name of ['bear', 'base', 'bull'] as ScenarioName[]) {
        const s = inputs.scenarios[name]
        scenarios[name] = {
          growth_rate: parseFloat(s.growth) / 100,
          discount_rate: parseFloat(s.wacc) / 100,
          terminal_growth: parseFloat(s.terminal) / 100,
        }
      }
      const resp = await api.dcf(symbol, {
        base_fcf: parseFloat(inputs.base_fcf),
        years: parseInt(inputs.years, 10) || 5,
        net_debt: parseFloat(inputs.net_debt) || 0,
        shares_outstanding: inputs.shares_outstanding
          ? parseFloat(inputs.shares_outstanding)
          : null,
        scenarios,
      })
      setResult(resp)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error en el cálculo')
    } finally {
      setBusy(false)
    }
  }

  if (error && !inputs)
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        No hay datos para prellenar el DCF: {error}
      </p>
    )
  if (!defaults || !inputs)
    return <p className="text-sm text-slate-400">Calculando valores de partida…</p>

  const setScenario = (name: ScenarioName, field: 'growth' | 'wacc' | 'terminal', value: string) =>
    setInputs({
      ...inputs,
      scenarios: {
        ...inputs.scenarios,
        [name]: { ...inputs.scenarios[name], [field]: value },
      },
    })

  const inputCls =
    'w-full rounded border border-slate-300 px-2 py-1 text-sm tabular-nums focus:border-sky-500 focus:outline-none'

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">DCF por escenarios</h2>
          <SourceBadge data={defaults} />
        </div>
        <p className="mb-3 text-xs text-slate-500">
          {defaults.note} Crecimiento histórico ({defaults.historical_growth.years}A): ingresos{' '}
          {fmtPct(defaults.historical_growth.revenue_cagr)}, FCF{' '}
          {fmtPct(defaults.historical_growth.fcf_cagr)}.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="text-xs text-slate-500">
            FCF base (año {defaults.fiscal_year ?? '—'})
            <input
              className={inputCls}
              value={inputs.base_fcf}
              onChange={(e) => setInputs({ ...inputs, base_fcf: e.target.value })}
            />
          </label>
          <label className="text-xs text-slate-500">
            Deuda neta
            <input
              className={inputCls}
              value={inputs.net_debt}
              onChange={(e) => setInputs({ ...inputs, net_debt: e.target.value })}
            />
          </label>
          <label className="text-xs text-slate-500">
            Acciones en circulación
            <input
              className={inputCls}
              value={inputs.shares_outstanding}
              onChange={(e) => setInputs({ ...inputs, shares_outstanding: e.target.value })}
            />
          </label>
          <label className="text-xs text-slate-500">
            Años de proyección
            <input
              className={inputCls}
              value={inputs.years}
              onChange={(e) => setInputs({ ...inputs, years: e.target.value })}
            />
          </label>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(['bear', 'base', 'bull'] as ScenarioName[]).map((name) => (
            <div key={name} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">
                {SCENARIO_LABELS[name]}
              </div>
              <label className="mb-1 block text-xs text-slate-500">
                Crecimiento FCF (%/año)
                <input
                  className={inputCls}
                  value={inputs.scenarios[name].growth}
                  onChange={(e) => setScenario(name, 'growth', e.target.value)}
                />
              </label>
              <label className="mb-1 block text-xs text-slate-500">
                WACC / tasa de descuento (%)
                <input
                  className={inputCls}
                  value={inputs.scenarios[name].wacc}
                  onChange={(e) => setScenario(name, 'wacc', e.target.value)}
                />
              </label>
              <label className="block text-xs text-slate-500">
                Crecimiento terminal (%)
                <input
                  className={inputCls}
                  value={inputs.scenarios[name].terminal}
                  onChange={(e) => setScenario(name, 'terminal', e.target.value)}
                />
              </label>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={run}
            disabled={busy || !inputs.base_fcf}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? 'Calculando…' : 'Calcular rango de valor'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </section>

      {result && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            Rango de valor intrínseco{' '}
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">
              calculado con tus supuestos — no es una predicción
            </span>
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {(['bear', 'base', 'bull'] as ScenarioName[]).map((name) => {
              const sc = result.scenarios[name]
              if (!sc) return null
              const vs =
                sc.value_per_share !== null && result.current_price
                  ? sc.value_per_share / result.current_price - 1
                  : null
              return (
                <div key={name} className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">{SCENARIO_LABELS[name]}</div>
                  <div className="text-2xl font-semibold tabular-nums text-slate-900">
                    {sc.value_per_share !== null
                      ? fmtNumber(sc.value_per_share)
                      : fmtBig(sc.equity_value)}
                  </div>
                  <div className="text-xs text-slate-500">
                    {vs !== null && (
                      <>
                        {fmtPct(vs)} vs. precio actual ({fmtNumber(result.current_price)}) ·{' '}
                      </>
                    )}
                    terminal pesa {fmtPct(sc.terminal_weight)}
                  </div>
                </div>
              )
            })}
          </div>

          {result.sensitivity && (
            <div className="mt-4">
              <h3 className="mb-1 text-xs font-semibold text-slate-600">
                Sensibilidad (escenario base): valor/acción según WACC × crecimiento
              </h3>
              <div className="overflow-x-auto">
                <table className="text-xs tabular-nums">
                  <thead>
                    <tr>
                      <th className="p-1 text-left font-normal text-slate-400">WACC \ g</th>
                      {result.sensitivity.growth_rates.map((g) => (
                        <th key={g} className="p-1 text-right font-normal text-slate-400">
                          {fmtPct(g, 0)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.sensitivity.rows.map((row) => (
                      <tr key={row.discount_rate}>
                        <td className="p-1 text-slate-400">{fmtPct(row.discount_rate, 0)}</td>
                        {row.values.map((v, i) => (
                          <td key={i} className="p-1 text-right text-slate-700">
                            {v !== null ? fmtNumber(v, 0) : '·'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Si la matriz se mueve mucho entre celdas vecinas, el valor central es poco
                robusto: la incertidumbre es información, no un defecto.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

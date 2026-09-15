import type { Fundamentals } from '../api/types'
import { fmtBig, fmtNumber, fmtPct } from '../lib/format'
import { SourceBadge } from './SourceBadge'

type Kind = 'ratio' | 'pct' | 'big'

const ROWS: { key: string; label: string; kind: Kind }[] = [
  { key: 'market_cap', label: 'Capitalización', kind: 'big' },
  { key: 'pe_ttm', label: 'P/E (TTM)', kind: 'ratio' },
  { key: 'pb', label: 'P/B', kind: 'ratio' },
  { key: 'ps_ttm', label: 'P/S (TTM)', kind: 'ratio' },
  { key: 'roe', label: 'ROE', kind: 'pct' },
  { key: 'gross_margin', label: 'Margen bruto', kind: 'pct' },
  { key: 'operating_margin', label: 'Margen operativo', kind: 'pct' },
  { key: 'net_margin', label: 'Margen neto', kind: 'pct' },
  { key: 'debt_to_equity', label: 'Deuda / Capital', kind: 'ratio' },
  { key: 'current_ratio', label: 'Ratio corriente', kind: 'ratio' },
  { key: 'dividend_yield', label: 'Rentabilidad por dividendo', kind: 'pct' },
  { key: 'eps_growth_5y', label: 'Crec. EPS 5A (anualizado)', kind: 'pct' },
  { key: 'revenue_growth_5y', label: 'Crec. ingresos 5A (anualizado)', kind: 'pct' },
  { key: 'beta', label: 'Beta', kind: 'ratio' },
  { key: 'week52_high', label: 'Máximo 52 semanas', kind: 'ratio' },
  { key: 'week52_low', label: 'Mínimo 52 semanas', kind: 'ratio' },
]

function fmt(value: number | null, kind: Kind): string {
  if (kind === 'pct') return fmtPct(value)
  if (kind === 'big') return fmtBig(value)
  return fmtNumber(value)
}

export function FundamentalsGrid({ data }: { data: Fundamentals }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">
          Fundamentales básicos <span className="font-normal text-slate-400">(TTM)</span>
        </h2>
        <SourceBadge data={data} />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        {ROWS.map(({ key, label, kind }) => (
          <div key={key} className="flex flex-col border-b border-slate-100 py-1.5">
            <dt className="text-xs text-slate-400">{label}</dt>
            <dd className="text-sm font-medium tabular-nums text-slate-800">
              {fmt(data.metrics[key] ?? null, kind)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-slate-400">
        Un guion (—) significa que la fuente no reporta el dato; nunca se rellena con
        ceros ni estimaciones.
      </p>
    </section>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { EtfComparison, EtfRecommendation } from '../api/types'
import { SourceBadge } from '../components/SourceBadge'
import { fmtBig, fmtPct } from '../lib/format'

const ETF_ACTION_STYLES: Record<string, string> = {
  comprar: 'bg-emerald-600 text-white',
  vigilar: 'bg-amber-100 text-amber-800',
  evitar: 'bg-red-600 text-white',
  ninguna: 'bg-slate-100 text-slate-500',
}

/** Cuál de estos ETFs está mejor construido, y cuáles se repiten entre sí. */
function EtfPicks({ reco }: { reco: EtfRecommendation }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">Recomendación</h2>

      {/* El error más caro al montar una cartera de ETFs va arriba, no al pie:
          se compran tres fondos creyendo que se diversifica y los tres llevan
          dentro las mismas diez empresas. */}
      {reco.avisos.map((a, i) => (
        <p
          key={i}
          className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900"
        >
          {a}
        </p>
      ))}

      <ul className="mt-3 space-y-2">
        {reco.evaluados.map((e) => (
          <li key={e.symbol} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-slate-900">{e.symbol}</span>
                <span className="text-xs text-slate-500">{e.name}</span>
              </div>
              <span
                className={`rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                  ETF_ACTION_STYLES[e.action] ?? ETF_ACTION_STYLES.ninguna
                }`}
              >
                {e.action}
              </span>
            </div>
            <ul className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-slate-600">
              {e.reasons.map((r, i) => (
                <li key={i}>· {r}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">{reco.nota}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
        {reco.aviso_solapamiento}
      </p>
    </section>
  )
}

function OverlapBar({ value }: { value: number }) {
  // Escala: 40 % de solapamiento por peso ya es mucha exposición duplicada.
  const width = Math.min((value / 0.4) * 100, 100)
  const tone = value > 0.25 ? 'bg-red-400' : value > 0.1 ? 'bg-amber-400' : 'bg-emerald-400'
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
      <div className={`h-full ${tone}`} style={{ width: `${width}%` }} />
    </div>
  )
}

export function EtfsPage() {
  const [input, setInput] = useState('VOO, QQQ, VTI')
  const [data, setData] = useState<EtfComparison | null>(null)
  const [reco, setReco] = useState<EtfRecommendation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const compare = async (e: React.FormEvent) => {
    e.preventDefault()
    const symbols = input
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 4)
    if (symbols.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const [comparacion, recomendacion] = await Promise.all([
        api.compareEtfs(symbols),
        api.recomendarEtfs(symbols),
      ])
      setData(comparacion)
      setReco(recomendacion)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
      setData(null)
      setReco(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">ETFs</h1>

      <form onSubmit={compare} className="flex flex-wrap gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Hasta 4 ETFs separados por coma (VOO, QQQ, VTI)"
          className="w-96 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
        />
        <button
          disabled={busy}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? 'Analizando…' : 'Analizar y recomendar'}
        </button>
      </form>

      {error && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {error}
        </p>
      )}

      {reco && <EtfPicks reco={reco} />}

      {data && Object.keys(data.errors).length > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Sin datos para: {Object.keys(data.errors).join(', ')} (¿es un ETF cotizado en EE. UU.?)
        </p>
      )}

      {data && data.etfs.length > 0 && (
        <>
          <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Comparador lado a lado</h2>
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                  <th className="py-1 pr-2 font-normal">Métrica</th>
                  {data.etfs.map((etf) => (
                    <th key={etf.symbol} className="px-2 py-1 text-right font-normal">
                      {etf.symbol}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['Nombre', (e: (typeof data.etfs)[0]) => e.name ?? '—'],
                  ['Categoría', (e: (typeof data.etfs)[0]) => e.category ?? '—'],
                  ['Expense ratio', (e: (typeof data.etfs)[0]) => fmtPct(e.expense_ratio, 2)],
                  ['AUM', (e: (typeof data.etfs)[0]) => fmtBig(e.aum)],
                  ['Div. yield', (e: (typeof data.etfs)[0]) => fmtPct(e.dividend_yield)],
                ].map(([label, get]) => (
                  <tr key={label as string} className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-500">{label as string}</td>
                    {data.etfs.map((etf) => (
                      <td key={etf.symbol} className="px-2 py-1.5 text-right text-slate-800">
                        {(get as (e: typeof etf) => string)(etf)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex justify-end">
              {data.etfs[0] && <SourceBadge data={data.etfs[0]} />}
            </div>
          </section>

          {data.overlaps.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="mb-1 text-sm font-semibold text-slate-700">
                Solapamiento entre ETFs
              </h2>
              <p className="mb-3 text-xs text-slate-400">{data.note}</p>
              <ul className="space-y-3">
                {data.overlaps.map((o) => (
                  <li key={`${o.a}-${o.b}`}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium text-slate-700">
                        {o.a} ↔ {o.b}
                      </span>
                      <span className="tabular-nums text-slate-600">
                        {fmtPct(o.overlap_weight)} del peso · {o.shared_count} posiciones
                      </span>
                    </div>
                    <OverlapBar value={o.overlap_weight} />
                    {o.common_holdings.length > 0 && (
                      <p className="mt-1 text-xs text-slate-400">
                        Compartidas:{' '}
                        {o.common_holdings.slice(0, 6).map((c) => c.symbol).join(', ')}
                        {o.common_holdings.length > 6 ? '…' : ''}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {data.etfs.map((etf) => (
              <section key={etf.symbol} className="rounded-xl border border-slate-200 bg-white p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  {etf.symbol} · mayores posiciones
                </h3>
                {etf.top_holdings.length === 0 ? (
                  <p className="text-sm text-slate-400">Sin composición publicada.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {etf.top_holdings.map((h) => (
                      <li key={h.symbol} className="flex justify-between border-b border-slate-100 py-1">
                        <Link to={`/ticker/${h.symbol}`} className="text-slate-700 hover:underline">
                          {h.symbol}
                          <span className="ml-2 text-xs text-slate-400">{h.name ?? ''}</span>
                        </Link>
                        <span className="tabular-nums text-slate-600">{fmtPct(h.weight)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {Object.keys(etf.sector_weights).length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-xs text-slate-400">Desglose sectorial</div>
                    <ul className="space-y-0.5 text-xs">
                      {Object.entries(etf.sector_weights)
                        .sort((a, b) => b[1] - a[1])
                        .map(([sector, weight]) => (
                          <li key={sector} className="flex justify-between text-slate-600">
                            <span className="capitalize">{sector.replace(/_/g, ' ')}</span>
                            <span className="tabular-nums">{fmtPct(weight)}</span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                {etf.coverage_note && (
                  <p className="mt-2 text-[10px] text-slate-400">{etf.coverage_note}</p>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

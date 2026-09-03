import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { FilingsResponse } from '../../api/types'
import { SourceBadge } from '../SourceBadge'

function FilingList({ title, items }: { title: string; items: FilingsResponse['filings'] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-700">{title}</h2>
      {items.length === 0 && <p className="text-sm text-slate-400">Sin filings recientes.</p>}
      <ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
        {items.map((filing) => (
          <li
            key={filing.accession_no}
            className="flex items-center justify-between border-b border-slate-100 py-1.5"
          >
            <a
              href={filing.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-sky-700 hover:underline"
            >
              {filing.type}
            </a>
            <span className="text-xs text-slate-400">{filing.filed_at}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function FilingsSection({ symbol }: { symbol: string }) {
  const [data, setData] = useState<FilingsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    api.filings(symbol).then(setData, (e) => setError(e.message))
  }, [symbol])

  if (error)
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Sin filings: {error}
      </p>
    )
  if (!data) return <p className="text-sm text-slate-400">Cargando filings de EDGAR…</p>

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <SourceBadge data={data} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <FilingList title="Filings de la empresa (10-K, 10-Q, 8-K…)" items={data.filings} />
        <FilingList
          title="Actividad de insiders (Forms 3/4/5)"
          items={data.insider_filings}
        />
      </div>
      <p className="text-xs text-slate-400">
        Cada enlace abre el documento original en sec.gov. El detalle por transacción de
        insiders (importes y precios) llega en una iteración futura; por ahora se listan los
        filings con su fecha.
      </p>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type {
  EarningsEvent,
  IndexEntry,
  MacroIndicator,
  SectorEntry,
  YieldCurve,
} from '../api/types'
import { fmtChangePct, fmtNumber } from '../lib/format'

function ChangeChip({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return <span className="text-slate-400">—</span>
  const up = pct >= 0
  return (
    <span className={`font-medium tabular-nums ${up ? 'text-emerald-600' : 'text-red-600'}`}>
      {fmtChangePct(pct)}
    </span>
  )
}

export function DashboardPage() {
  const [indices, setIndices] = useState<IndexEntry[] | null>(null)
  const [sectors, setSectors] = useState<SectorEntry[] | null>(null)
  const [curve, setCurve] = useState<YieldCurve | null>(null)
  const [macro, setMacro] = useState<MacroIndicator[] | null>(null)
  const [events, setEvents] = useState<EarningsEvent[] | null>(null)

  useEffect(() => {
    api.marketOverview().then((d) => setIndices(d.indices), () => setIndices([]))
    api.marketSectors().then((d) => setSectors(d.sectors), () => setSectors([]))
    api.yieldCurve().then(setCurve, () => setCurve(null))
    api.macro().then((d) => setMacro(d.indicators), () => setMacro([]))
    api.calendar().then((d) => setEvents(d.events), () => setEvents([]))
  }, [])

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">Dashboard de mercado</h1>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(indices ?? []).map((ix) => (
          <div key={ix.symbol} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-400">{ix.label}</div>
            <div className="text-lg font-semibold tabular-nums text-slate-900">
              {ix.quote ? fmtNumber(ix.quote.price) : '—'}
            </div>
            <ChangeChip pct={ix.quote?.change_pct} />
          </div>
        ))}
        {indices === null && <p className="text-sm text-slate-400">Cargando índices…</p>}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">
            Sectores hoy <span className="font-normal text-slate-400">(ETFs SPDR como proxy)</span>
          </h2>
          {sectors === null && <p className="text-sm text-slate-400">Cargando…</p>}
          <ul className="space-y-1">
            {(sectors ?? []).map((s) => {
              const pct = s.change_pct
              const width = pct === null ? 0 : Math.min(Math.abs(pct) * 25, 100)
              return (
                <li key={s.symbol} className="flex items-center gap-2 text-sm">
                  <Link
                    to={`/ticker/${s.symbol}`}
                    className="w-44 shrink-0 truncate text-slate-600 hover:underline"
                  >
                    {s.label}
                  </Link>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
                    <div
                      className={`h-full ${pct !== null && pct >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <span className="w-16 text-right">
                    <ChangeChip pct={pct} />
                  </span>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">
            Curva de rendimientos EE. UU.{' '}
            <span className="font-normal text-slate-400">(FRED, cierre anterior)</span>
          </h2>
          {curve === null ? (
            <p className="text-sm text-slate-400">
              Sin datos de FRED (¿falta FRED_API_KEY en .env?).
            </p>
          ) : (
            <>
              <div className="flex items-end gap-2">
                {curve.curve.map((point) => (
                  <div key={point.series_id} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-xs tabular-nums text-slate-600">
                      {point.value !== null ? fmtNumber(point.value, 2) : '—'}
                    </span>
                    <div
                      className="w-full rounded-t bg-sky-300"
                      style={{ height: `${(point.value ?? 0) * 14}px` }}
                    />
                    <span className="text-[10px] text-slate-400">{point.tenor}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Spread 10A−2A:{' '}
                <span
                  className={`font-medium tabular-nums ${
                    (curve.spread_10y_2y ?? 0) < 0 ? 'text-red-600' : 'text-slate-700'
                  }`}
                >
                  {curve.spread_10y_2y !== null ? `${fmtNumber(curve.spread_10y_2y, 2)} pp` : '—'}
                </span>{' '}
                · {curve.note}
              </p>
            </>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Macro (FRED)</h2>
          <dl className="grid grid-cols-3 gap-3">
            {(macro ?? []).map((m) => (
              <div key={m.series_id}>
                <dt className="text-xs text-slate-400">{m.label}</dt>
                <dd className="text-lg font-semibold tabular-nums text-slate-800">
                  {m.value !== null ? `${fmtNumber(m.value, 1)} %` : '—'}
                </dd>
                <dd className="text-[10px] text-slate-400">{m.ts ?? ''}</dd>
              </div>
            ))}
          </dl>
          {macro !== null && macro.length === 0 && (
            <p className="text-sm text-slate-400">Sin datos (¿falta FRED_API_KEY?).</p>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">
            Próximos resultados <span className="font-normal text-slate-400">(14 días)</span>
          </h2>
          {events === null && <p className="text-sm text-slate-400">Cargando…</p>}
          {events !== null && events.length === 0 && (
            <p className="text-sm text-slate-400">
              Sin eventos (¿falta FINNHUB_API_KEY en .env?).
            </p>
          )}
          <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
            {(events ?? []).slice(0, 40).map((ev) => (
              <li
                key={`${ev.symbol}-${ev.date}`}
                className="flex items-center justify-between border-b border-slate-100 py-1"
              >
                <Link to={`/ticker/${ev.symbol}`} className="font-medium text-slate-700 hover:underline">
                  {ev.symbol}
                </Link>
                <span className="text-xs text-slate-500">
                  {ev.date}
                  {ev.eps_estimate !== null ? ` · EPS est. ${fmtNumber(ev.eps_estimate)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

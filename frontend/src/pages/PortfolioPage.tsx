import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Portfolio, PriceAlert, RiskBudget, WatchlistItem } from '../api/types'
import { fmtChangePct, fmtNumber, fmtPct } from '../lib/format'

type Tab = 'portafolio' | 'watchlist' | 'alertas'

function RiskBudgetPanel({ risk }: { risk: RiskBudget }) {
  const excedido = risk.riesgo_total_pct > risk.tope_pct
  const pct = Math.min(risk.riesgo_total_pct / risk.tope_pct, 1.6) * 100
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Riesgo abierto</h2>
        <span className="text-[11px] text-slate-400">
          tope sugerido {risk.tope_pct} % · por grupo {risk.tope_grupo_pct} %
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-3xl font-semibold tabular-nums ${excedido ? 'text-red-600' : 'text-slate-900'}`}>
          {risk.riesgo_total_pct.toFixed(1)} %
        </span>
        <span className="text-xs text-slate-400">
          {excedido ? 'por encima del tope' : `quedan ${risk.margen_pct.toFixed(1)} % de margen`}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${excedido ? 'bg-red-500' : 'bg-emerald-500'}`}
             style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {risk.avisos.map((a, i) => (
        <p key={i} className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">{a}</p>
      ))}
      {Object.keys(risk.por_grupo).length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Por grupo que se mueve junto
          </div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {Object.entries(risk.por_grupo).sort((a, b) => b[1] - a[1]).map(([grupo, valor]) => (
              <li key={grupo} className="flex justify-between gap-3">
                <span className="text-slate-600">{grupo}</span>
                <span className={`tabular-nums ${valor > risk.tope_grupo_pct ? 'text-red-600' : 'text-slate-700'}`}>
                  {valor.toFixed(1)} %
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">{risk.nota}</p>
    </section>
  )
}

function Pnl({ value, pct }: { value: number | null; pct: number | null }) {
  if (value === null) return <span className="text-slate-400">—</span>
  const up = value >= 0
  return (
    <span className={`tabular-nums font-medium ${up ? 'text-emerald-600' : 'text-red-600'}`}>
      {up ? '+' : ''}
      {fmtNumber(value)}
      {pct !== null && <span className="ml-1 text-xs">({fmtPct(pct)})</span>}
    </span>
  )
}

function PortfolioTab() {
  const [data, setData] = useState<Portfolio | null>(null)
  const [form, setForm] = useState({ symbol: '', quantity: '', cost: '' })
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.portfolio().then(setData, (e) => setError(e.message))
  }, [])
  useEffect(load, [load])

  const addPosition = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api.addPosition({
        symbol: form.symbol.trim().toUpperCase(),
        quantity: parseFloat(form.quantity),
        cost_basis: parseFloat(form.cost),
      })
      setForm({ symbol: '', quantity: '', cost: '' })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    }
  }

  const close = async (id: number) => {
    const raw = window.prompt('Precio de venta por acción:')
    if (!raw) return
    const price = parseFloat(raw)
    if (Number.isNaN(price)) return
    await api.closePosition(id, price)
    load()
  }

  const inputCls =
    'rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-sky-500 focus:outline-none'

  return (
    <div className="space-y-4">
      <form onSubmit={addPosition} className="flex flex-wrap items-end gap-2">
        <input
          className={`${inputCls} w-32`}
          placeholder="Ticker"
          value={form.symbol}
          onChange={(e) => setForm({ ...form, symbol: e.target.value })}
        />
        <input
          className={`${inputCls} w-28`}
          placeholder="Acciones"
          value={form.quantity}
          onChange={(e) => setForm({ ...form, quantity: e.target.value })}
        />
        <input
          className={`${inputCls} w-32`}
          placeholder="Coste/acción"
          value={form.cost}
          onChange={(e) => setForm({ ...form, cost: e.target.value })}
        />
        <button className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
          Añadir posición
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </form>

      {data && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-400">Invertido</div>
              <div className="text-xl font-semibold tabular-nums">
                {fmtNumber(data.summary.total_invested)}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-400">Valor de mercado</div>
              <div className="text-xl font-semibold tabular-nums">
                {data.summary.total_market_value !== null
                  ? fmtNumber(data.summary.total_market_value)
                  : '—'}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-400">No realizado</div>
              <div className="text-xl">
                <Pnl value={data.summary.unrealized_pnl} pct={data.summary.unrealized_pct} />
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-xs text-slate-400">Realizado (cerradas)</div>
              <div className="text-xl">
                <Pnl value={data.summary.realized_pnl} pct={null} />
              </div>
            </div>
          </section>

          {data.summary.priced_positions < data.summary.total_positions && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              {data.summary.total_positions - data.summary.priced_positions} posición(es) sin
              precio disponible quedan fuera de los totales. {data.note}
            </p>
          )}

          {data.risk_budget && <RiskBudgetPanel risk={data.risk_budget} />}

          {data.concentration_warnings.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1 text-xs font-semibold text-slate-600">Concentración</div>
              <ul className="text-xs text-slate-600">
                {data.concentration_warnings.map((w) => (
                  <li key={w}>· {w}</li>
                ))}
              </ul>
            </div>
          )}

          <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Posiciones abiertas</h2>
            {data.positions.length === 0 ? (
              <p className="text-sm text-slate-400">Sin posiciones abiertas.</p>
            ) : (
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                    {['Ticker', 'Sector', 'Acciones', 'Coste', 'Precio', 'Valor', 'No realizado', 'Peso', ''].map(
                      (h) => (
                        <th key={h} className="px-2 py-1 font-normal">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.positions.map((p) => {
                    const weight = data.allocation_by_position.find((a) => a.label === p.symbol)
                    return (
                      <tr key={p.id} className="border-b border-slate-100">
                        <td className="px-2 py-1.5">
                          <Link to={`/ticker/${p.symbol}`} className="font-medium hover:underline">
                            {p.symbol}
                          </Link>
                        </td>
                        <td className="px-2 py-1.5 text-xs text-slate-500">{p.sector}</td>
                        <td className="px-2 py-1.5 tabular-nums">{fmtNumber(p.quantity, 0)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{fmtNumber(p.cost_basis)}</td>
                        <td className="px-2 py-1.5 tabular-nums">
                          {p.price !== null ? fmtNumber(p.price) : '—'}
                        </td>
                        <td className="px-2 py-1.5 tabular-nums">
                          {p.market_value !== null ? fmtNumber(p.market_value) : '—'}
                        </td>
                        <td className="px-2 py-1.5">
                          <Pnl value={p.unrealized_pnl} pct={p.unrealized_pct} />
                        </td>
                        <td className="px-2 py-1.5 tabular-nums text-slate-600">
                          {weight ? fmtPct(weight.weight) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <button
                            onClick={() => close(p.id)}
                            className="text-xs text-slate-400 hover:text-slate-700"
                          >
                            Cerrar
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>

          {data.allocation_by_sector.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-semibold text-slate-700">Exposición por sector</h2>
              <ul className="space-y-1">
                {data.allocation_by_sector.map((s) => (
                  <li key={s.label} className="flex items-center gap-2 text-sm">
                    <span className="w-40 shrink-0 truncate text-slate-600">{s.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
                      <div className="h-full bg-sky-400" style={{ width: `${s.weight * 100}%` }} />
                    </div>
                    <span className="w-16 text-right tabular-nums text-slate-600">
                      {fmtPct(s.weight)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.closed_positions.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-semibold text-slate-700">Posiciones cerradas</h2>
              <ul className="space-y-1 text-sm">
                {data.closed_positions.map((p) => (
                  <li key={p.id} className="flex justify-between border-b border-slate-100 py-1">
                    <span className="text-slate-700">
                      {p.symbol}
                      <span className="ml-2 text-xs text-slate-400">
                        {p.closed_at.slice(0, 10)}
                      </span>
                    </span>
                    <Pnl value={p.realized_pnl} pct={null} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function WatchlistTab() {
  const [items, setItems] = useState<WatchlistItem[]>([])
  const [symbol, setSymbol] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.watchlist().then((d) => setItems(d.items), (e) => setError(e.message))
  }, [])
  useEffect(load, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api.addToWatchlist({ symbol: symbol.trim().toUpperCase(), notes: null })
      setSymbol('')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="flex gap-2">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="Añadir ticker"
          className="w-48 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
        />
        <button className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
          Añadir
        </button>
        {error && <span className="self-center text-sm text-red-600">{error}</span>}
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-slate-400">Watchlist vacía.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3"
            >
              <div>
                <Link to={`/ticker/${item.symbol}`} className="font-medium hover:underline">
                  {item.symbol}
                </Link>
                <span className="ml-2 text-xs text-slate-400">
                  {item.name ?? ''} {item.sector ? `· ${item.sector}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-4">
                {item.quote ? (
                  <span className="tabular-nums text-slate-700">
                    {fmtNumber(item.quote.price)}
                    <span
                      className={`ml-2 text-sm ${
                        (item.quote.change_pct ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {fmtChangePct(item.quote.change_pct)}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-slate-400">sin precio</span>
                )}
                <button
                  onClick={async () => {
                    await api.removeFromWatchlist(item.id)
                    load()
                  }}
                  className="text-xs text-slate-400 hover:text-red-600"
                >
                  Quitar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AlertsTab() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([])
  const [form, setForm] = useState<{ symbol: string; op: 'lt' | 'gt'; price: string }>({
    symbol: '',
    op: 'lt',
    price: '',
  })

  const load = useCallback(() => {
    api.alerts().then((d) => setAlerts(d.alerts), () => setAlerts([]))
  }, [])
  useEffect(load, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    await api.addAlert({
      symbol: form.symbol.trim().toUpperCase(),
      op: form.op,
      price: parseFloat(form.price),
    })
    setForm({ symbol: '', op: 'lt', price: '' })
    load()
  }

  const inputCls =
    'rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-sky-500 focus:outline-none'

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <input
          className={`${inputCls} w-32`}
          placeholder="Ticker"
          value={form.symbol}
          onChange={(e) => setForm({ ...form, symbol: e.target.value })}
        />
        <select
          className={inputCls}
          value={form.op}
          onChange={(e) => setForm({ ...form, op: e.target.value as 'lt' | 'gt' })}
        >
          <option value="lt">baja de</option>
          <option value="gt">sube de</option>
        </select>
        <input
          className={`${inputCls} w-32`}
          placeholder="Precio"
          value={form.price}
          onChange={(e) => setForm({ ...form, price: e.target.value })}
        />
        <button className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
          Crear alerta
        </button>
      </form>

      <p className="text-xs text-slate-400">
        Las alertas se evalúan cuando abres esta pestaña (con el precio cacheado). No hay
        notificaciones push: es una app local, no un servicio en marcha.
      </p>

      {alerts.length === 0 ? (
        <p className="text-sm text-slate-400">Sin alertas configuradas.</p>
      ) : (
        <ul className="space-y-2">
          {alerts.map((a) => (
            <li
              key={a.id}
              className={`flex items-center justify-between rounded-xl border p-3 ${
                a.triggered ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="text-sm">
                <span className="font-medium text-slate-800">{a.symbol}</span>
                <span className="ml-2 text-slate-500">
                  {a.condition.op === 'lt' ? 'baja de' : 'sube de'} {fmtNumber(a.condition.price)}
                </span>
                {a.triggered && (
                  <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs text-amber-900">
                    Cumplida
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm tabular-nums text-slate-600">
                  {a.current_price !== null ? fmtNumber(a.current_price) : '—'}
                </span>
                <button
                  onClick={async () => {
                    await api.deleteAlert(a.id)
                    load()
                  }}
                  className="text-xs text-slate-400 hover:text-red-600"
                >
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PortfolioPage() {
  const [tab, setTab] = useState<Tab>('portafolio')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'portafolio', label: 'Portafolio' },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'alertas', label: 'Alertas' },
  ]

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">Portafolio y seguimiento</h1>
      <nav className="flex gap-1 border-b border-slate-200">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === id
                ? 'border-slate-900 font-medium text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'portafolio' && <PortfolioTab />}
      {tab === 'watchlist' && <WatchlistTab />}
      {tab === 'alertas' && <AlertsTab />}
    </div>
  )
}

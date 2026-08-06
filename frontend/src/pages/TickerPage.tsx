import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import type { Fundamentals, History, HistoryRange, Profile, Quote } from '../api/types'
import { FundamentalsGrid } from '../components/FundamentalsGrid'
import { PriceChart } from '../components/PriceChart'
import { SourceBadge } from '../components/SourceBadge'
import { FilingsSection } from '../components/ticker/FilingsSection'
import { FinancialsSection } from '../components/ticker/FinancialsSection'
import { HealthSection } from '../components/ticker/HealthSection'
import { ValuationSection } from '../components/ticker/ValuationSection'
import { fmtBig, fmtChangePct, fmtNumber } from '../lib/format'

const RANGES: HistoryRange[] = ['1M', '3M', '6M', 'YTD', '1Y', '5Y', '10Y']

type TabName = 'resumen' | 'fundamentales' | 'valoracion' | 'salud' | 'filings'

// Las pestañas cargan sus datos solo al abrirse: no se gastan llamadas de API
// en análisis que no estás mirando.
const TABS: { id: TabName; label: string }[] = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'fundamentales', label: 'Fundamentales' },
  { id: 'valoracion', label: 'Valoración' },
  { id: 'salud', label: 'Salud y riesgo' },
  { id: 'filings', label: 'Filings' },
]

interface TickerData {
  quote: Quote
  profile: Profile | null
  fundamentals: Fundamentals | null
}

function lastNonNull(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) return values[i]
  }
  return null
}

export function TickerPage() {
  const { symbol: routeSymbol } = useParams()
  const navigate = useNavigate()
  const symbol = (routeSymbol ?? '').toUpperCase()

  const [input, setInput] = useState(symbol)
  const [tab, setTab] = useState<TabName>('resumen')
  const [range, setRange] = useState<HistoryRange>('1Y')
  const [data, setData] = useState<TickerData | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (sym: string) => {
    setLoading(true)
    setError(null)
    try {
      // La cotización es imprescindible; perfil y fundamentales pueden faltar
      // en la fuente sin que eso rompa la vista.
      const [quote, profile, fundamentals] = await Promise.all([
        api.quote(sym),
        api.profile(sym).catch(() => null),
        api.fundamentals(sym).catch(() => null),
      ])
      setData({ quote, profile, fundamentals })
    } catch (e) {
      setData(null)
      setError(
        e instanceof ApiError && e.status === 404
          ? `No se encontró el símbolo «${sym}» en las fuentes configuradas.`
          : e instanceof Error
            ? e.message
            : 'Error desconocido',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (symbol) void load(symbol)
    setTab('resumen')
  }, [symbol, load])

  useEffect(() => {
    if (!symbol) return
    let alive = true
    api.history(symbol, range).then(
      (h) => alive && setHistory(h),
      () => alive && setHistory(null),
    )
    return () => {
      alive = false
    }
  }, [symbol, range])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const cleaned = input.trim().toUpperCase()
    if (cleaned) navigate(`/ticker/${cleaned}`)
  }

  const quote = data?.quote
  const up = (quote?.change ?? 0) >= 0
  const rsi = history ? lastNonNull(history.indicators.rsi14) : null

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ticker (p. ej. AAPL, MSFT, SHOP.TO)"
          className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Analizar
        </button>
      </form>

      {loading && <p className="text-sm text-slate-500">Cargando {symbol}…</p>}
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {quote && !loading && (
        <>
          <header className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h1 className="text-xl font-semibold text-slate-900">
                  {data?.profile?.name ?? quote.symbol}
                  <span className="ml-2 text-sm font-normal text-slate-400">
                    {quote.symbol}
                    {data?.profile?.exchange ? ` · ${data.profile.exchange}` : ''}
                    {data?.profile?.sector ? ` · ${data.profile.sector}` : ''}
                  </span>
                </h1>
                <div className="mt-1 flex items-baseline gap-3">
                  <span className="text-3xl font-semibold tabular-nums text-slate-900">
                    {fmtNumber(quote.price)}
                    <span className="ml-1 text-base font-normal text-slate-400">
                      {quote.currency ?? data?.profile?.currency ?? ''}
                    </span>
                  </span>
                  <span
                    className={`text-lg font-medium tabular-nums ${
                      up ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {quote.change !== null && quote.change > 0 ? '+' : ''}
                    {fmtNumber(quote.change)} ({fmtChangePct(quote.change_pct)})
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                <SourceBadge data={quote} freshness={quote.freshness} />
                <div className="text-xs text-slate-400">
                  Ant.: {fmtNumber(quote.prev_close)} · Rango día:{' '}
                  {fmtNumber(quote.day_low)}–{fmtNumber(quote.day_high)}
                  {data?.profile?.market_cap
                    ? ` · Cap.: ${fmtBig(data.profile.market_cap)}`
                    : ''}
                </div>
              </div>
            </div>
          </header>

          <nav className="flex gap-1 border-b border-slate-200">
            {TABS.map(({ id, label }) => (
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

          {tab === 'fundamentales' && <FinancialsSection symbol={symbol} />}
          {tab === 'valoracion' && <ValuationSection symbol={symbol} />}
          {tab === 'salud' && <HealthSection symbol={symbol} />}
          {tab === 'filings' && <FilingsSection symbol={symbol} />}

          <section
            className={`rounded-xl border border-slate-200 bg-white p-4 ${tab === 'resumen' ? '' : 'hidden'}`}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    onClick={() => setRange(r)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                      r === range
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                {rsi !== null && (
                  <span
                    className="text-xs text-slate-500"
                    title="RSI 14 sobre el intervalo mostrado; calculado por la app a partir de los datos"
                  >
                    RSI 14: <span className="font-medium tabular-nums">{fmtNumber(rsi, 1)}</span>
                  </span>
                )}
                {history && <SourceBadge data={history} />}
              </div>
            </div>
            {history ? (
              <PriceChart history={history} />
            ) : (
              <p className="py-16 text-center text-sm text-slate-400">
                Sin histórico disponible para {symbol} en las fuentes configuradas.
              </p>
            )}
          </section>

          {tab === 'resumen' && data?.fundamentals && (
            <FundamentalsGrid data={data.fundamentals} />
          )}
        </>
      )}

      {!symbol && !loading && (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">
          <p className="text-sm">
            Escribe un ticker para ver precio, gráfico y fundamentales básicos.
          </p>
          <p className="mt-1 text-xs">
            Toda cifra muestra su fuente y fecha. Esta app no da señales de compra ni
            predicciones.
          </p>
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { DailySignal, MarketInfo, TodayResponse } from '../api/types'
import { fmtChangePct, fmtNumber, relativeTime } from '../lib/format'

// Una empresa "favorable" puntúa mejor que sus comparables de sector. No es
// una recomendación de compra y la UI no debe insinuar que lo sea: por eso el
// verde marca "mira esto primero", no "compra".
const LABEL_STYLES: Record<string, string> = {
  'muy favorable': 'bg-emerald-100 text-emerald-800',
  favorable: 'bg-emerald-50 text-emerald-700',
  neutral: 'bg-slate-100 text-slate-600',
  desfavorable: 'bg-amber-50 text-amber-700',
  'muy desfavorable': 'bg-red-100 text-red-700',
}

const FAMILY_LABELS: Record<string, string> = {
  value: 'Valor',
  quality: 'Calidad',
  momentum: 'Momentum',
  sentiment: 'Sentimiento',
}

type View = 'favorables' | 'neutrales' | 'desfavorables' | 'todas'

/** El compuesto vive de facto en [-2, 2]; se mapea a 0-100 % para la barra. */
function scoreToPct(score: number): number {
  return Math.min(Math.max((score + 2) / 4, 0), 1) * 100
}

function Chip({ label }: { label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        LABEL_STYLES[label] ?? 'bg-slate-100 text-slate-600'
      }`}
    >
      {label}
    </span>
  )
}

/** Minigráfico de un año en SVG. Sin librería: son 32 puntos y una polilínea. */
function Sparkline({ serie, subiendo }: { serie: number[]; subiendo: boolean }) {
  if (serie.length < 2) return <div className="h-6 w-20" />
  const min = Math.min(...serie)
  const max = Math.max(...serie)
  const span = max - min || 1
  const puntos = serie
    .map((v, i) => {
      const x = (i / (serie.length - 1)) * 78 + 1
      const y = 22 - ((v - min) / span) * 20
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 80 24" className="h-6 w-20 overflow-visible" aria-hidden>
      <polyline
        points={puntos}
        fill="none"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        className={subiendo ? 'stroke-emerald-500' : 'stroke-red-400'}
      />
    </svg>
  )
}

/** Dónde está el precio dentro de su rango de 52 semanas. */
function RangeBar({ position }: { position: number }) {
  return (
    <div className="relative h-1 w-full rounded-full bg-slate-100">
      <div
        className="absolute top-1/2 h-2 w-0.5 -translate-y-1/2 rounded-full bg-slate-500"
        style={{ left: `${Math.min(Math.max(position, 0), 1) * 100}%` }}
      />
    </div>
  )
}

const FACTOR_KEYS = ['value', 'quality', 'momentum'] as const

/** Tres barras finas: de un vistazo se ve de dónde sale la puntuación.
 *  Los rótulos van una sola vez en la cabecera, no repetidos en cada fila. */
function FactorBars({
  families,
  withLabels = false,
}: {
  families: Record<string, number | null>
  withLabels?: boolean
}) {
  return (
    <div className="flex gap-3">
      {FACTOR_KEYS.map((key) => {
        const raw = families[key]
        return (
          <div key={key} className="w-16">
            {withLabels && (
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">
                {FAMILY_LABELS[key]}
              </div>
            )}
            <div
              className="h-1 overflow-hidden rounded-full bg-slate-100"
              title={`${FAMILY_LABELS[key]}: ${
                raw === null || raw === undefined ? 'sin dato' : fmtNumber(raw, 2)
              }`}
            >
              {raw !== null && raw !== undefined && (
                <div
                  className={`h-full ${raw >= 0 ? 'bg-emerald-400' : 'bg-red-300'}`}
                  style={{ width: `${scoreToPct(raw)}%` }}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Cabecera de columnas: alineada con la fila, con las mismas anchuras. */
function ListHeader() {
  return (
    <div className="flex items-center gap-4 border-b border-slate-100 px-4 py-2 text-[10px] uppercase tracking-wide text-slate-400">
      <span className="w-7 shrink-0" />
      <span className="w-40 shrink-0">Empresa</span>
      <span className="hidden w-20 shrink-0 lg:block">Año</span>
      <span className="hidden w-24 shrink-0 text-right sm:block">Precio</span>
      <span className="hidden flex-1 pl-4 md:block">
        <span className="flex gap-3">
          {FACTOR_KEYS.map((key) => (
            <span key={key} className="w-16">
              {FAMILY_LABELS[key]}
            </span>
          ))}
        </span>
      </span>
      <span className="ml-auto pr-[6.5rem] text-right">Puntuación</span>
    </div>
  )
}

function SignalRow({
  signal,
  expanded,
  onToggle,
}: {
  signal: DailySignal
  expanded: boolean
  onToggle: () => void
}) {
  const positive = signal.score >= 0
  return (
    <li className="border-b border-slate-100 last:border-0">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-slate-50"
      >
        <span className="w-7 shrink-0 text-xs tabular-nums text-slate-300">
          {signal.rank}
        </span>

        <span className="w-40 shrink-0">
          <span className="font-medium text-slate-900">{signal.symbol}</span>
          <span className="block truncate text-xs text-slate-400">
            {signal.context.name ?? signal.context.sector_name ?? '—'}
          </span>
        </span>

        {/* Un año de precio: la forma dice de un vistazo si viene de subida
            o de caída, algo que la puntuación por sí sola no cuenta. */}
        <span className="hidden w-20 shrink-0 lg:block">
          {signal.price?.spark?.length ? (
            <Sparkline
              serie={signal.price.spark}
              subiendo={
                signal.price.spark[signal.price.spark.length - 1] >=
                signal.price.spark[0]
              }
            />
          ) : null}
        </span>

        <span className="hidden w-24 shrink-0 text-right sm:block">
          {signal.price ? (
            <>
              <span className="block text-sm tabular-nums text-slate-800">
                {fmtNumber(signal.price.last, 2)}
              </span>
              <span
                className={`block text-xs tabular-nums ${
                  (signal.price.change_pct ?? 0) >= 0
                    ? 'text-emerald-600'
                    : 'text-red-500'
                }`}
              >
                {fmtChangePct(signal.price.change_pct)}
              </span>
            </>
          ) : (
            <span className="block text-sm text-slate-300">—</span>
          )}
        </span>

        <span className="hidden flex-1 pl-4 md:block">
          <FactorBars families={signal.families} />
        </span>

        <span className="ml-auto flex items-center gap-3">
          <span
            className={`w-12 text-right text-sm font-semibold tabular-nums ${
              positive ? 'text-emerald-700' : 'text-red-600'
            }`}
          >
            {signal.score > 0 ? '+' : ''}
            {fmtNumber(signal.score, 2)}
          </span>
          <Chip label={signal.label} />
          <span
            className={`text-slate-300 transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          >
            ›
          </span>
        </span>
      </button>

      {expanded && (
        <div className="space-y-3 bg-slate-50/70 px-4 pb-4 pt-1 md:pl-[4.75rem]">
          <div className="md:hidden">
            <FactorBars families={signal.families} withLabels />
          </div>
          {signal.price && (
            <div className="max-w-md">
              <div className="flex items-baseline justify-between text-xs text-slate-500">
                <span>Rango de 52 semanas</span>
                <span className="tabular-nums">
                  {fmtNumber(signal.price.low_52w, 2)} –{' '}
                  {fmtNumber(signal.price.high_52w, 2)}
                </span>
              </div>
              {signal.price.range_position !== null && (
                <div className="mt-1.5">
                  <RangeBar position={signal.price.range_position} />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Cotiza en el percentil{' '}
                    {Math.round(signal.price.range_position * 100)} de su rango
                    anual · {signal.price.points} sesiones ·{' '}
                    {signal.price.source ?? 'fuente desconocida'}
                    {signal.price.as_of
                      ? `, ${relativeTime(signal.price.as_of)}`
                      : ''}
                  </p>
                </div>
              )}
            </div>
          )}
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div>
              <dt className="inline text-slate-400">Sector: </dt>
              <dd className="inline text-slate-700">
                {signal.context.sector_name ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-400">Puesto en su sector: </dt>
              <dd className="inline text-slate-700">{signal.sector_rank ?? '—'}</dd>
            </div>
            <div>
              <dt className="inline text-slate-400">Cobertura de datos: </dt>
              <dd className="inline text-slate-700">
                {Math.round(signal.coverage * 100)} %
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-400">Horizonte: </dt>
              <dd className="inline text-slate-700">{signal.horizon}</dd>
            </div>
          </dl>
          {signal.probability_note && (
            <p className="text-xs leading-snug text-slate-500">
              {signal.probability_note}
            </p>
          )}
          <Link
            to={`/ticker/${signal.symbol}`}
            className="inline-block text-xs font-medium text-sky-700 hover:underline"
          >
            Ver el análisis completo de {signal.symbol} →
          </Link>
        </div>
      )}
    </li>
  )
}

export function TodayPage() {
  const [markets, setMarkets] = useState<MarketInfo[]>([])
  const [market, setMarket] = useState('us_sp500')
  const [data, setData] = useState<TodayResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('favorables')
  const [sector, setSector] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = (which: string, refresh = false) => {
    setBusy(true)
    setError(null)
    api.today(which, refresh).then(
      (d) => {
        setData(d)
        setBusy(false)
      },
      (e) => {
        setError(e instanceof Error ? e.message : 'Error')
        setBusy(false)
      },
    )
  }

  useEffect(() => {
    api.markets().then((d) => setMarkets(d.markets), () => undefined)
  }, [])

  useEffect(() => {
    // Al cambiar de mercado los filtros previos ya no aplican.
    setData(null)
    setSector(null)
    setExpanded(null)
    load(market)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market])

  const rows = useMemo(() => {
    if (!data?.signals || !data.thresholds) return []
    const { favorable, desfavorable } = data.thresholds
    let base = data.signals
    if (view === 'favorables') base = base.filter((s) => s.score >= favorable)
    else if (view === 'desfavorables') {
      // De la peor hacia arriba: lo primero que se ve es lo más flojo.
      base = base.filter((s) => s.score <= desfavorable).slice().reverse()
    } else if (view === 'neutrales') {
      base = base.filter((s) => s.score > desfavorable && s.score < favorable)
    }
    if (sector !== null) base = base.filter((s) => s.context.sector_key === sector)
    const q = query.trim().toUpperCase()
    if (q) {
      base = base.filter(
        (s) =>
          s.symbol.includes(q) || (s.context.name ?? '').toUpperCase().includes(q),
      )
    }
    return base
  }, [data, view, sector, query])

  // Buscar es para encontrar una empresa concreta, esté en el cubo que esté:
  // filtrar además por vista haría que "no aparece" volviera a ser posible.
  const encontradoFuera = useMemo(() => {
    if (!data?.signals || !query.trim()) return null
    const q = query.trim().toUpperCase()
    const enTodas = data.signals.filter(
      (s) => s.symbol.includes(q) || (s.context.name ?? '').toUpperCase().includes(q),
    )
    return enTodas.length > rows.length ? enTodas.length - rows.length : null
  }, [data, query, rows.length])

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Hoy</h1>
          {/* Altura acotada: la cabecera no debe crecer con lo larga que sea
              la descripción del mercado que toque. */}
          <p className="mt-0.5 max-w-3xl text-sm leading-snug text-slate-500">
            {data?.market_description ??
              'Empresas puntuadas contra sus comparables de sector. Sin elegir nada.'}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          {data && (
            <span>
              {data.cached ? 'Calculado ' : 'Recalculado '}
              {relativeTime(data.fetched_at ?? data.as_of)}
            </span>
          )}
          <button
            onClick={() => load(market, true)}
            disabled={busy}
            className="rounded-lg border border-slate-200 px-2.5 py-1 font-medium text-slate-600 transition-colors hover:bg-white disabled:opacity-50"
          >
            {busy ? 'Puntuando…' : 'Actualizar'}
          </button>
        </div>
      </header>

      {markets.length > 1 && (
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
          {markets.map((m) => (
            <button
              key={m.key}
              onClick={() => setMarket(m.key)}
              title={`${m.companies} empresas · ${m.sectors} sectores`}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                market === m.key
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}

      {busy && !data && (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">Puntuando el universo…</p>
          <p className="mt-1 text-xs text-slate-400">
            La primera pasada del día descarga un fundamental por empresa y puede
            tardar un par de minutos. Después queda en caché 6 h.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {error}
        </div>
      )}

      {data && !data.signals && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          El servidor devolvió una respuesta con un formato que esta versión no
          entiende. Pulsa «Actualizar» para recalcular la lista desde cero.
        </div>
      )}

      {data?.signals && data.thresholds && data.counts && (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
                {(
                  [
                    ['favorables', `Favorables (${data.counts.favorables})`],
                    ['neutrales', `Neutrales (${data.counts.neutrales})`],
                    ['desfavorables', `A evitar (${data.counts.desfavorables})`],
                    ['todas', `Todas (${data.scored})`],
                  ] as [View, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setView(key)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      view === key
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar ticker o empresa…"
                aria-label="Buscar ticker o empresa"
                className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setSector(null)}
                className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                  sector === null
                    ? 'bg-slate-200 text-slate-900'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                Todos los sectores
              </button>
              {data.sectors
                .filter((s) => s.usable)
                .map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setSector(sector === s.key ? null : s.key)}
                    className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                      sector === s.key
                        ? 'bg-slate-200 text-slate-900'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {s.name}
                  </button>
                ))}
            </div>
          </div>

          {!data.complete && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-sky-900">
                  Cobertura parcial: {data.scored} de {data.requested} empresas
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sky-200">
                  <div
                    className="h-full bg-sky-500 transition-all"
                    style={{ width: `${(data.scored / data.requested) * 100}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] leading-snug text-sky-800">
                  Las APIs gratuitas limitan cuántos fundamentales se descargan de
                  una vez. Lo descargado queda en caché 24 h, así que cada pasada
                  avanza y ninguna repite trabajo.
                </p>
              </div>
              <button
                onClick={() => load(market, true)}
                disabled={busy}
                className="shrink-0 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
              >
                {busy ? 'Descargando…' : 'Seguir completando'}
              </button>
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {rows.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-400">
                {query.trim() ? (
                  <>
                    <p>
                      «{query.trim()}» no está en {data.market_name}.
                    </p>
                    <p className="mt-1 text-xs">
                      Puede estar en otro mercado, o fuera del universo. Búscala
                      directamente en{' '}
                      <Link
                        to={`/ticker/${query.trim().toUpperCase()}`}
                        className="font-medium text-sky-700 hover:underline"
                      >
                        Acciones
                      </Link>
                      : ahí se analiza cualquier ticker, esté o no en la lista.
                    </p>
                  </>
                ) : (
                  <p>Nada que mostrar con este filtro.</p>
                )}
              </div>
            ) : (
              <>
                <ListHeader />
                <ul>
                  {rows.map((signal) => (
                    <SignalRow
                      key={signal.symbol}
                      signal={signal}
                      expanded={expanded === signal.symbol}
                      onToggle={() =>
                        setExpanded(expanded === signal.symbol ? null : signal.symbol)
                      }
                    />
                  ))}
                </ul>
              </>
            )}
          </div>


          <div className="flex flex-wrap justify-between gap-3 text-xs text-slate-400">
            <span>
              {encontradoFuera !== null && (
                <button
                  onClick={() => setView('todas')}
                  className="mr-2 font-medium text-sky-700 hover:underline"
                >
                  {encontradoFuera} coincidencia
                  {encontradoFuera === 1 ? '' : 's'} más en otras vistas — ver todas
                </button>
              )}
              {data.scored} empresas puntuadas de {data.requested}
              {data.data_meta && 'retrieved_at' in data.data_meta
                ? ` · universo actualizado el ${data.data_meta.retrieved_at}`
                : ''}
            </span>
            {data.unavailable.length > 0 && (
              <span>{data.unavailable.length} sin datos suficientes</span>
            )}
          </div>

          <p className="rounded-xl bg-slate-100 px-4 py-3 text-xs leading-relaxed text-slate-500">
            {data.disclaimer}
          </p>
        </>
      )}
    </div>
  )
}

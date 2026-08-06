import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type {
  BacktestResponse,
  QuantSignal,
  ScanResponse,
  SignalExplanation,
  SignalResponse,
  UniverseInfo,
} from '../api/types'
import { fmtNumber, fmtPct } from '../lib/format'
import { useLlmStatus } from '../lib/llm'

const LABEL_STYLES: Record<string, string> = {
  'muy favorable': 'bg-emerald-100 text-emerald-800',
  favorable: 'bg-emerald-50 text-emerald-700',
  neutral: 'bg-slate-100 text-slate-600',
  desfavorable: 'bg-amber-50 text-amber-700',
  'muy desfavorable': 'bg-red-100 text-red-800',
  'sin datos': 'bg-slate-100 text-slate-400',
}

const FAMILY_LABELS: Record<string, string> = {
  value: 'Valor',
  quality: 'Calidad',
  momentum: 'Momentum',
  sentiment: 'Sentimiento',
}

const BUCKET_LABELS: Record<string, string> = {
  muy_alto: 'Muy alto',
  alto: 'Alto',
  medio: 'Medio',
  bajo: 'Bajo',
  muy_bajo: 'Muy bajo',
}

/** Barra divergente centrada en cero: a la izquierda resta, a la derecha suma. */
function ContributionBar({ value }: { value: number }) {
  const width = Math.min(Math.abs(value) / 1.5, 1) * 50
  return (
    <div className="relative h-2 w-full rounded bg-slate-100">
      <div className="absolute left-1/2 top-0 h-full w-px bg-slate-300" />
      <div
        className={`absolute top-0 h-full ${value >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
        style={
          value >= 0
            ? { left: '50%', width: `${width}%` }
            : { right: '50%', width: `${width}%` }
        }
      />
    </div>
  )
}

function SignalCard({ signal }: { signal: QuantSignal }) {
  const [explanation, setExplanation] = useState<SignalExplanation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const llm = useLlmStatus()

  const explain = async () => {
    setBusy(true)
    setError(null)
    try {
      setExplanation(await api.explainSignal(signal.symbol, signal))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {signal.rank && (
              <span className="text-xs font-medium text-slate-400">#{signal.rank}</span>
            )}
            <Link
              to={`/ticker/${signal.symbol}`}
              className="font-semibold text-slate-800 hover:underline"
            >
              {signal.symbol}
            </Link>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${LABEL_STYLES[signal.label] ?? ''}`}>
              {signal.label}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-slate-400">
            {signal.context.name ?? ''}
            {signal.context.sector ? ` · ${signal.context.sector}` : ''}
          </div>
        </div>

        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums text-slate-900">
            {signal.score !== null ? (signal.score > 0 ? '+' : '') + fmtNumber(signal.score) : '—'}
          </div>
          <div className="text-[10px] text-slate-400">
            z-score vs. universo · cobertura {fmtPct(signal.coverage, 0)}
          </div>
        </div>
      </div>

      {/* Probabilidad: solo si el modelo está calibrado */}
      <div className="mt-3 rounded-lg bg-slate-50 p-3">
        {signal.probability !== null && signal.probability_ci ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tabular-nums text-slate-800">
                {fmtPct(signal.probability, 0)}
              </span>
              <span className="text-xs text-slate-500">
                IC 95 %: {fmtPct(signal.probability_ci[0], 0)} –{' '}
                {fmtPct(signal.probability_ci[1], 0)} · n={signal.sample_size}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{signal.probability_note}</p>
          </>
        ) : (
          <p className="text-xs text-slate-500">
            <span className="font-medium text-slate-600">Sin probabilidad estimada.</span>{' '}
            {signal.probability_note}
          </p>
        )}
      </div>

      {/* Atribución por familia de factores */}
      {Object.keys(signal.contributions).length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">
            De dónde viene la puntuación
          </div>
          {Object.entries(signal.contributions).map(([family, value]) => (
            <div key={family} className="flex items-center gap-2 text-xs">
              <span className="w-24 shrink-0 text-slate-600">
                {FAMILY_LABELS[family] ?? family}
              </span>
              <ContributionBar value={value} />
              <span
                className={`w-14 shrink-0 text-right tabular-nums ${
                  value >= 0 ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {value > 0 ? '+' : ''}
                {fmtNumber(value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {signal.events.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500">Eventos detectados</span>
            <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white">
              clasificado por IA
            </span>
          </div>
          <ul className="space-y-0.5 text-xs text-slate-600">
            {signal.events.slice(0, 4).map((ev, i) => (
              <li key={i} className="flex gap-2">
                <span className={ev.weight >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                  {ev.weight > 0 ? '▲' : ev.weight < 0 ? '▼' : '•'}
                </span>
                <span>
                  {ev.category.replace(/_/g, ' ')}{' '}
                  <span className="text-slate-400">(confianza {ev.confidence})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        {!explanation && signal.score !== null && llm?.configured && (
          <button
            onClick={explain}
            disabled={busy}
            title="Claude explica los factores ya calculados; no genera la puntuación"
            className="rounded-lg border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
          >
            {busy ? 'Explicando…' : 'Explicar esta lectura (IA)'}
          </button>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>

      {explanation && (
        <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
              Generado por IA
            </span>
            <span className="text-[10px] text-violet-500">{explanation.model}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-slate-700">{explanation.content_md}</p>
          <p className="mt-2 text-[10px] text-violet-500">{explanation.disclaimer}</p>
        </div>
      )}
    </li>
  )
}

function BacktestPanel({ result }: { result: BacktestResponse }) {
  const weak = result.reliable_buckets === 0 || result.n_observations === 0
  return (
    <section
      className={`rounded-xl border p-4 ${
        weak ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      <h2 className="mb-1 text-sm font-semibold text-slate-700">
        Validación walk-forward ({result.horizon_months} meses)
      </h2>
      <p className="mb-3 text-sm font-medium text-slate-700">{result.verdict}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs text-slate-400">Observaciones</div>
          <div className="text-xl font-semibold tabular-nums">{result.n_observations}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Rebalanceos</div>
          <div className="text-xl font-semibold tabular-nums">{result.n_rebalances}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Acierto global</div>
          <div className="text-xl font-semibold tabular-nums">
            {result.overall_hit_rate !== null ? fmtPct(result.overall_hit_rate, 0) : '—'}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Rangos calibrados</div>
          <div className="text-xl font-semibold tabular-nums">{result.reliable_buckets}</div>
        </div>
      </div>

      {Object.keys(result.calibration).length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                {['Rango de puntuación', 'n', 'Aciertos', 'Tasa', 'IC 95 %', 'Fiable'].map((h) => (
                  <th key={h} className="px-2 py-1 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {['muy_alto', 'alto', 'medio', 'bajo', 'muy_bajo']
                .filter((b) => result.calibration[b])
                .map((bucket) => {
                  const c = result.calibration[bucket]
                  return (
                    <tr key={bucket} className="border-b border-slate-100">
                      <td className="px-2 py-1.5 text-slate-700">{BUCKET_LABELS[bucket]}</td>
                      <td className="px-2 py-1.5 tabular-nums">{c.n}</td>
                      <td className="px-2 py-1.5 tabular-nums">{c.hits}</td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {c.rate !== null ? fmtPct(c.rate, 0) : '—'}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums text-slate-500">
                        {fmtPct(c.ci_low, 0)} – {fmtPct(c.ci_high, 0)}
                      </td>
                      <td className="px-2 py-1.5">
                        {c.reliable ? (
                          <span className="text-emerald-600">sí</span>
                        ) : (
                          <span className="text-slate-400">muestra corta</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">{result.methodology}</p>
      {result.missing.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          Sin histórico suficiente: {result.missing.join(', ')}
        </p>
      )}
    </section>
  )
}

function UncalibratedBanner() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <b>Modelo sin calibrar.</b> El ranking muestra solo puntuación relativa. Pulsa{' '}
      <i>Validar modelo</i> en la pestaña <i>Universo propio</i> para ejecutar el backtest
      walk-forward; hasta entonces la app no publica ninguna probabilidad.
    </div>
  )
}

/** Modo automático: la app trae las candidatas y las ordena. */
function ScanMode() {
  const [universes, setUniverses] = useState<UniverseInfo[]>([])
  const [selected, setSelected] = useState('megacaps')
  const [topN, setTopN] = useState(10)
  const [result, setResult] = useState<ScanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.universes().then((d) => setUniverses(d.universes), () => setUniverses([]))
  }, [])

  const scan = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await api.scanUniverse(selected, topN))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const active = universes.find((u) => u.key === selected)

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Elige un universo</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {universes.map((u) => (
            <button
              key={u.key}
              onClick={() => setSelected(u.key)}
              className={`rounded-lg border p-3 text-left ${
                selected === u.key
                  ? 'border-slate-900 bg-slate-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="text-sm font-medium text-slate-800">{u.name}</div>
              <div className="text-xs text-slate-400">{u.size} empresas</div>
            </button>
          ))}
          <button
            onClick={() => setSelected('watchlist')}
            className={`rounded-lg border p-3 text-left ${
              selected === 'watchlist'
                ? 'border-slate-900 bg-slate-50'
                : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="text-sm font-medium text-slate-800">Mi watchlist</div>
            <div className="text-xs text-slate-400">las que ya sigues</div>
          </button>
        </div>

        {active && (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            {active.description}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={scan}
            disabled={busy}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? 'Analizando universo…' : 'Buscar las mejor puntuadas'}
          </button>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Mostrar top
            <select
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1"
            >
              {[5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        {busy && (
          <p className="mt-2 text-xs text-slate-500">
            La primera pasada tarda ~1 minuto porque descarga los fundamentales de todo el
            universo. Quedan cacheados 24 h, así que las siguientes son inmediatas.
          </p>
        )}
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>

      {result && (
        <>
          {!result.calibrated && <UncalibratedBanner />}

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-700">
              {result.universe_name} — top {result.top.length}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {result.scored} de {result.requested} empresas puntuadas · momentum de{' '}
              {result.momentum_coverage} vía {result.momentum_source ?? 'n/d'} · pesos:{' '}
              {Object.entries(result.weights)
                .map(([f, w]) => `${FAMILY_LABELS[f] ?? f} ${(w * 100).toFixed(0)} %`)
                .join(' · ')}
            </p>
            {result.unavailable.length > 0 && (
              <p className="mt-1 text-xs text-amber-700">
                Sin datos: {result.unavailable.map((u) => u.symbol).join(', ')}
              </p>
            )}
          </section>

          <ul className="space-y-3">
            {result.top.map((signal) => (
              <SignalCard key={signal.symbol} signal={signal} />
            ))}
          </ul>

          <details className="rounded-xl border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">
              Ranking completo del universo ({result.all_ranked.length})
            </summary>
            <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {result.all_ranked.map((row) => (
                <li
                  key={row.symbol}
                  className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-slate-50"
                >
                  <span className="flex items-center gap-2">
                    <span className="w-6 text-xs text-slate-400">{row.rank ?? '—'}</span>
                    <Link to={`/ticker/${row.symbol}`} className="hover:underline">
                      {row.symbol}
                    </Link>
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${LABEL_STYLES[row.label] ?? ''}`}
                    >
                      {row.label}
                    </span>
                    <span className="w-12 text-right tabular-nums text-slate-600">
                      {row.score !== null ? (row.score > 0 ? '+' : '') + fmtNumber(row.score) : '—'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </details>

          <p className="text-xs text-slate-400">{result.note}</p>
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            {result.disclaimer}
          </p>
        </>
      )}
    </div>
  )
}

/** Modo manual: tú das los tickers. Incluye el backtest. */
function ManualMode() {
  const [universe, setUniverse] = useState('AAPL, MSFT, GOOGL, JNJ, KO, XOM, JPM, PG')
  const [useNews, setUseNews] = useState(false)
  const [result, setResult] = useState<SignalResponse | null>(null)
  const [backtest, setBacktest] = useState<BacktestResponse | null>(null)
  const [busy, setBusy] = useState<'score' | 'backtest' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const symbols = () =>
    universe
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 15)

  const run = async (what: 'score' | 'backtest') => {
    setBusy(what)
    setError(null)
    try {
      if (what === 'score') setResult(await api.scoreSignals(symbols(), useNews))
      else setBacktest(await api.runBacktest(symbols(), 12, 6))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <label className="mb-1 block text-xs font-medium text-slate-500">
          Universo a puntuar (3–15 tickers, separados por coma)
        </label>
        <textarea
          value={universe}
          onChange={(e) => setUniverse(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            onClick={() => run('score')}
            disabled={busy !== null}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy === 'score' ? 'Puntuando…' : 'Puntuar universo'}
          </button>
          <button
            onClick={() => run('backtest')}
            disabled={busy !== null}
            title="Descarga estados financieros de EDGAR (gratis) y valida el modelo fuera de muestra"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === 'backtest' ? 'Validando…' : 'Validar modelo (backtest)'}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={useNews}
              onChange={(e) => setUseNews(e.target.checked)}
            />
            Incluir sentimiento de noticias (gasta API de Claude)
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>

      {backtest && <BacktestPanel result={backtest} />}

      {result && (
        <>
          {!result.calibrated && <UncalibratedBanner />}
          <div className="text-xs text-slate-400">
            {result.universe_size} empresas puntuadas
            {result.unavailable.length > 0 &&
              ` · sin datos: ${result.unavailable.map((u) => u.symbol).join(', ')}`}
          </div>
          <ul className="space-y-3">
            {result.signals.map((signal) => (
              <SignalCard key={signal.symbol} signal={signal} />
            ))}
          </ul>
          <p className="text-xs text-slate-400">{result.note}</p>
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            {result.disclaimer}
          </p>
        </>
      )}
    </div>
  )
}

export function SignalsPage() {
  const [mode, setMode] = useState<'scan' | 'manual'>('scan')

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">Señales cuantitativas</h1>
        <p className="mt-1 text-sm text-slate-500">
          Modelo de factores (valor, calidad, momentum, sentimiento) con horizonte de 6-12
          meses. Puntúa empresas <b>unas contra otras</b>, no contra umbrales absolutos.
        </p>
      </div>

      <div className="rounded-lg border-l-4 border-slate-400 bg-slate-50 p-3 text-sm text-slate-700">
        <b>Cómo leer esto.</b> Encabezar el ranking significa que la empresa sale mejor
        parada que sus comparables en los factores del modelo — no que vaya a subir. La
        probabilidad solo aparece tras validar el modelo con el backtest, y aun entonces es
        una frecuencia histórica con intervalo de confianza, no una predicción sobre esa
        empresa en concreto.
      </div>

      <nav className="flex gap-1 border-b border-slate-200">
        {(
          [
            ['scan', 'Descubrir automáticamente'],
            ['manual', 'Universo propio'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              mode === id
                ? 'border-slate-900 font-medium text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {mode === 'scan' ? <ScanMode /> : <ManualMode />}
    </div>
  )
}

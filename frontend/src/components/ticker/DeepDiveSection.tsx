import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type {
  DeepDiveNarrative,
  DeepDiveReport,
  MultipleStats,
} from '../../api/types'
import { fmtBig, fmtNumber, fmtPct } from '../../lib/format'
import { useLlmStatus } from '../../lib/llm'

const STANCE_STYLES: Record<string, string> = {
  constructiva: 'bg-emerald-50 border-emerald-300 text-emerald-900',
  mixta: 'bg-slate-50 border-slate-300 text-slate-800',
  cautelosa: 'bg-amber-50 border-amber-300 text-amber-900',
}

const SEVERITY_STYLES: Record<string, string> = {
  alto: 'bg-red-100 text-red-800',
  medio: 'bg-amber-100 text-amber-800',
}

const TREND_LABELS: Record<string, string> = {
  mejorando: '▲ mejorando',
  'deteriorándose': '▼ deteriorándose',
  estable: '→ estable',
}

function Section({ title, reading, children }: { title: string; reading?: string; children?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      {reading && <p className="mt-1 text-sm text-slate-600">{reading}</p>}
      {children}
    </section>
  )
}

/** Barra que sitúa el múltiplo actual dentro de su rango histórico. */
function RangeBar({ stats }: { stats: MultipleStats }) {
  if (!stats.available || stats.current == null || stats.min == null || stats.max == null) {
    return null
  }
  const span = stats.max - stats.min
  const pos = span > 0 ? ((stats.current - stats.min) / span) * 100 : 50
  const medianPos = span > 0 && stats.median != null ? ((stats.median - stats.min) / span) * 100 : 50
  return (
    <div className="relative mt-1 h-6">
      <div className="absolute top-2.5 h-1 w-full rounded bg-gradient-to-r from-emerald-200 via-slate-200 to-red-200" />
      <div
        className="absolute top-1 h-4 w-px bg-slate-400"
        style={{ left: `${medianPos}%` }}
        title={`Mediana ${fmtNumber(stats.median)}`}
      />
      <div
        className="absolute top-0.5 h-5 w-1 rounded bg-slate-900"
        style={{ left: `calc(${Math.min(Math.max(pos, 0), 100)}% - 2px)` }}
        title={`Actual ${fmtNumber(stats.current)}`}
      />
    </div>
  )
}

function ValuationBlock({ report }: { report: DeepDiveReport }) {
  const labels: Record<string, string> = { pe: 'P/E', pb: 'P/B', fcf_yield: 'FCF yield' }
  return (
    <Section title="Valoración frente a su propia historia" reading={report.valuation.reading}>
      <div className="mt-3 space-y-4">
        {Object.entries(report.valuation.multiples).map(([key, stats]) => (
          <div key={key}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-slate-700">{labels[key] ?? key}</span>
              {stats.available ? (
                <span className="tabular-nums text-slate-600">
                  actual{' '}
                  <b>
                    {key === 'fcf_yield' ? fmtPct(stats.current) : fmtNumber(stats.current)}
                  </b>{' '}
                  · mediana{' '}
                  {key === 'fcf_yield' ? fmtPct(stats.median) : fmtNumber(stats.median)} ·
                  percentil {fmtPct(stats.percentile, 0)}
                </span>
              ) : (
                <span className="text-xs text-slate-400">{stats.reason}</span>
              )}
            </div>
            <RangeBar stats={stats} />
            {stats.available && (
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>
                  mín {key === 'fcf_yield' ? fmtPct(stats.min) : fmtNumber(stats.min)}
                </span>
                <span>{stats.n} observaciones · {report.valuation.years_covered} años</span>
                <span>
                  máx {key === 'fcf_yield' ? fmtPct(stats.max) : fmtNumber(stats.max)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {report.valuation.cheapness_score !== null && (
        <p className="mt-3 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
          Índice de baratura frente a su historia:{' '}
          <b>{fmtPct(report.valuation.cheapness_score, 0)}</b> (100 % = lo más barata que
          ha estado en el periodo).
        </p>
      )}

      <ul className="mt-2 space-y-1">
        {report.valuation.caveats.map((c, i) => (
          <li key={i} className="text-[11px] leading-snug text-amber-700">
            ⚠ {c}
          </li>
        ))}
      </ul>
    </Section>
  )
}

export function DeepDiveSection({ symbol }: { symbol: string }) {
  const [report, setReport] = useState<DeepDiveReport | null>(null)
  const [narrative, setNarrative] = useState<DeepDiveNarrative | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const llm = useLlmStatus()

  useEffect(() => {
    setReport(null)
    setNarrative(null)
    setError(null)
    api.deepDive(symbol).then(setReport, (e) => setError(e.message))
  }, [symbol])

  const writeNarrative = async () => {
    if (!report) return
    setBusy(true)
    try {
      setNarrative(await api.deepDiveNarrative(symbol, report))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  if (error)
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        {error}
      </p>
    )
  if (!report) return <p className="text-sm text-slate-400">Elaborando el informe…</p>

  const { business, growth, margins, debt, cash_flow: cash, verdict } = report

  return (
    <div className="space-y-4">
      {/* Veredicto arriba: es la síntesis, no un adorno final */}
      <section className={`rounded-xl border-2 p-4 ${STANCE_STYLES[verdict.stance] ?? ''}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Lectura conjunta: postura {verdict.stance}
          </h2>
          {verdict.quant_label && (
            <span className="text-xs">
              señal cuantitativa vs. pares: <b>{verdict.quant_label}</b>
            </span>
          )}
        </div>
        <p className="mt-2 text-sm">{verdict.summary}</p>

        <div className="mt-3">
          <div className="text-xs font-semibold">Qué rompería esta lectura</div>
          <ul className="mt-1 space-y-0.5">
            {verdict.what_would_change_it.map((c, i) => (
              <li key={i} className="text-xs">
                · {c}
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-3 text-[11px] leading-snug opacity-80">{verdict.disclaimer}</p>
      </section>

      <Section title="El negocio">
        <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-400">Sector</dt>
            <dd>{business.sector ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Capitalización</dt>
            <dd className="tabular-nums">{fmtBig(business.market_cap)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">
              Ingresos ({business.latest_fiscal_year})
            </dt>
            <dd className="tabular-nums">{fmtBig(business.latest_revenue)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Años de histórico</dt>
            <dd className="tabular-nums">{business.years_of_history}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] text-slate-400">{business.note}</p>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Crecimiento" reading={growth.reading}>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
            {[
              ['Ingresos 5A', growth.revenue_cagr],
              ['Ingresos 3A', growth.revenue_cagr_3y],
              ['EPS 5A', growth.eps_cagr],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-xs text-slate-400">{label as string}</dt>
                <dd className="tabular-nums">{fmtPct(value as number | null)}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
            {growth.yoy.slice(-5).map((y) => (
              <li key={y.year} className="flex justify-between">
                <span>{y.year}</span>
                <span className="tabular-nums">{fmtPct(y.growth)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Márgenes" reading={margins.reading}>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
            {(['gross_margin', 'operating_margin', 'net_margin'] as const).map((key) => (
              <div key={key}>
                <dt className="text-xs text-slate-400">
                  {key === 'gross_margin' ? 'Bruto' : key === 'operating_margin' ? 'Operativo' : 'Neto'}
                </dt>
                <dd className="tabular-nums">{fmtPct(margins.current[key])}</dd>
                <dd className="text-[10px] text-slate-400">
                  {TREND_LABELS[margins.trends[key] ?? ''] ?? ''}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="Deuda y solidez" reading={debt.reading}>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-400">Deuda neta</dt>
              <dd className="tabular-nums">{fmtBig(debt.net_debt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Deuda/Capital</dt>
              <dd className="tabular-nums">{fmtNumber(debt.debt_to_equity)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Cobertura</dt>
              <dd className="tabular-nums">
                {debt.interest_coverage !== null ? `${fmtNumber(debt.interest_coverage, 1)}×` : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Altman Z</dt>
              <dd className="tabular-nums">
                {fmtNumber(debt.altman_z.score)}
                {debt.altman_z.zone && (
                  <span className="ml-1 text-[10px] text-slate-500">({debt.altman_z.zone})</span>
                )}
              </dd>
            </div>
          </dl>
        </Section>

        <Section title="Flujo de caja" reading={cash.reading}>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-slate-400">FCF</dt>
              <dd className="tabular-nums">{fmtBig(cash.current.fcf as number | null)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Conversión</dt>
              <dd className="tabular-nums">
                {fmtPct(cash.current.fcf_conversion as number | null)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Capex/Ingresos</dt>
              <dd className="tabular-nums">
                {fmtPct(cash.current.capex_intensity as number | null)}
              </dd>
            </div>
          </dl>
        </Section>
      </div>

      <ValuationBlock report={report} />

      {report.dcf && (
        <Section title="Valor intrínseco (DCF precargado)">
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {(['bear', 'base', 'bull'] as const).map((kind) => {
              const sc = report.dcf!.scenarios[kind]
              if (!sc) return null
              const vs =
                sc.value_per_share !== null && report.price
                  ? sc.value_per_share / report.price - 1
                  : null
              return (
                <div key={kind} className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">
                    {kind === 'bear' ? 'Bajista' : kind === 'base' ? 'Base' : 'Alcista'}
                  </div>
                  <div className="text-xl font-semibold tabular-nums">
                    {fmtNumber(sc.value_per_share)}
                  </div>
                  <div className="text-xs text-slate-500">
                    {vs !== null && `${fmtPct(vs)} vs. precio · `}terminal{' '}
                    {fmtPct(sc.terminal_weight)}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">{report.dcf.note}</p>
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Riesgos detectados en los datos">
          {report.risks.length === 0 ? (
            <p className="mt-1 text-sm text-slate-400">
              Ninguno de los umbrales del modelo se dispara. No significa ausencia de
              riesgo: los riesgos cualitativos (competencia, regulación, gestión) no salen
              de las cifras.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {report.risks.map((r, i) => (
                <li key={i} className="rounded-lg border border-slate-200 p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_STYLES[r.severity] ?? ''}`}
                    >
                      {r.severity}
                    </span>
                    <span className="text-sm font-medium text-slate-700">{r.type}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">{r.evidence}</p>
                  <p className="text-xs text-slate-400">{r.why}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Catalizadores próximos (6-18 meses)">
          {report.catalysts.length === 0 ? (
            <p className="mt-1 text-sm text-slate-400">Ninguno identificado en los datos.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {report.catalysts.map((c, i) => (
                <li key={i} className="flex justify-between border-b border-slate-100 py-1">
                  <span className="text-slate-700">
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {c.type}
                      </a>
                    ) : (
                      c.type
                    )}
                    <span className="ml-2 text-xs text-slate-400">{c.detail}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{c.when ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Narrativa por IA, siempre al final y siempre etiquetada.
          Sin ANTHROPIC_API_KEY la sección entera desaparece: el informe
          calculado se sostiene solo. */}
      {(narrative || llm?.configured) && (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        {!narrative ? (
          <>
            <h3 className="text-sm font-semibold text-slate-700">Narrativa del informe</h3>
            <p className="mt-1 text-sm text-slate-500">
              Claude puede escribir el informe en prosa a partir de las cifras de arriba.
              No genera ningún número: solo los interpreta.
            </p>
            <button
              onClick={writeNarrative}
              disabled={busy}
              className="mt-2 rounded-lg border border-violet-300 px-3 py-1.5 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
            >
              {busy ? 'Redactando…' : 'Redactar informe (IA)'}
            </button>
          </>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                Generado por IA
              </span>
              <span className="text-[10px] text-violet-500">{narrative.model}</span>
            </div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
              {narrative.content_md}
            </div>
            <p className="mt-3 text-[10px] text-violet-500">{narrative.disclaimer}</p>
          </>
        )}
      </section>
      )}

      <p className="text-[11px] text-slate-400">
        Informe calculado a partir de SEC EDGAR ({report.data_sources.financials}) y precios
        de {report.data_sources.quote ?? 'n/d'}. Generado el{' '}
        {report.generated_at?.slice(0, 16).replace('T', ' ')}.
      </p>
    </div>
  )
}

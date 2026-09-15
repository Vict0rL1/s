import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { ScenarioRecord, ThesisRecord, TrackRecord } from '../api/types'
import { fmtDateTime, fmtNumber, fmtPct } from '../lib/format'

const KIND_LABELS: Record<string, string> = { bear: 'Bajista', base: 'Base', bull: 'Alcista' }

function OutcomeChip({ scenario }: { scenario: ScenarioRecord }) {
  if (!scenario.outcome) {
    return (
      <span
        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500"
        title={scenario.reason ?? 'Escenario sin dirección definida'}
      >
        no evaluable
      </span>
    )
  }
  const hit = scenario.outcome === 'acertado'
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        hit ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
      }`}
    >
      {scenario.outcome} · dirección {scenario.direction}
    </span>
  )
}

function TrackRecordPanel({ record }: { record: TrackRecord }) {
  const { summary } = record
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-700">Registro de aciertos</h2>
      <p className="mb-3 text-xs text-slate-400">{summary.note}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs text-slate-400">Escenarios guardados</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">{summary.total}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Evaluables</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">
            {summary.evaluable}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Tasa de acierto direccional</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">
            {summary.hit_rate !== null ? fmtPct(summary.hit_rate, 0) : '—'}
          </div>
          <div className="text-[10px] text-slate-400">
            {summary.hits} aciertos / {summary.misses} fallos
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Error mediano de estimación</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">
            {summary.median_estimate_error_pct !== null
              ? fmtPct(summary.median_estimate_error_pct)
              : '—'}
          </div>
        </div>
      </div>

      {record.scenarios.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                {['Ticker', 'Escenario', 'Creado', 'Precio ancla', 'Estimado', 'Precio hoy', 'Movimiento', 'Resultado'].map(
                  (h) => (
                    <th key={h} className="px-2 py-1 font-normal">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {record.scenarios.map((s) => (
                <tr key={s.scenario_id} className="border-b border-slate-100">
                  <td className="px-2 py-1.5">
                    <Link to={`/ticker/${s.symbol}`} className="font-medium hover:underline">
                      {s.symbol}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5 text-slate-600">{KIND_LABELS[s.kind] ?? s.kind}</td>
                  <td className="px-2 py-1.5 text-xs text-slate-500">
                    {s.created_at.slice(0, 10)} ({s.days_elapsed} d)
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">
                    {s.price_at_creation !== null ? fmtNumber(s.price_at_creation) : '—'}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">
                    {s.value_mid !== null ? fmtNumber(s.value_mid) : '—'}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">
                    {s.current_price !== null ? fmtNumber(s.current_price) : '—'}
                  </td>
                  <td
                    className={`px-2 py-1.5 tabular-nums ${
                      (s.price_change_pct ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {s.price_change_pct !== null ? fmtPct(s.price_change_pct) : '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    <OutcomeChip scenario={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function ThesesPage() {
  const [theses, setTheses] = useState<ThesisRecord[]>([])
  const [record, setRecord] = useState<TrackRecord | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ symbol: '', title: '', body: '', invalidation: '' })
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.theses().then((d) => setTheses(d.theses), (e) => setError(e.message))
    api.trackRecord().then(setRecord, () => setRecord(null))
  }, [])
  useEffect(load, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api.createThesis({
        symbol: form.symbol.trim().toUpperCase(),
        title: form.title,
        body_md: form.body,
        invalidation_criteria: form.invalidation || null,
      })
      setForm({ symbol: '', title: '', body: '', invalidation: '' })
      setShowForm(false)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    }
  }

  const addScenario = async (thesisId: number) => {
    const kind = window.prompt('Escenario (bear / base / bull):', 'base')
    if (!kind || !['bear', 'base', 'bull'].includes(kind)) return
    const raw = window.prompt('Valor intrínseco estimado por acción:')
    if (!raw) return
    const value = parseFloat(raw)
    if (Number.isNaN(value)) return
    const result = await api.addScenario(thesisId, {
      kind: kind as 'bear' | 'base' | 'bull',
      assumptions: {},
      value_mid: value,
    })
    if (result.warning) window.alert(result.warning)
    load()
  }

  const inputCls =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-800">Tesis y escenarios</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          {showForm ? 'Cancelar' : 'Nueva tesis'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={create} className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <input
            className={inputCls}
            placeholder="Ticker"
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Título de la tesis"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <textarea
            className={inputCls}
            rows={4}
            placeholder="Tu tesis: por qué crees lo que crees, y qué supuestos clave la sostienen."
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
          <textarea
            className={inputCls}
            rows={2}
            placeholder="¿Qué te haría cambiar de opinión? (criterios de invalidación)"
            value={form.invalidation}
            onChange={(e) => setForm({ ...form, invalidation: e.target.value })}
          />
          <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
            Guardar tesis
          </button>
          {error && <span className="ml-3 text-sm text-red-600">{error}</span>}
        </form>
      )}

      {record && <TrackRecordPanel record={record} />}

      {theses.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          Sin tesis guardadas. Escribe una antes de comprar: la app la fechará y te la enseñará
          después junto al resultado real.
        </p>
      )}

      <div className="space-y-3">
        {theses.map((thesis) => (
          <article key={thesis.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-800">
                  <Link to={`/ticker/${thesis.symbol}`} className="hover:underline">
                    {thesis.symbol}
                  </Link>
                  <span className="ml-2 font-normal">{thesis.title}</span>
                </h2>
                <div className="text-xs text-slate-400">
                  Escrita el {fmtDateTime(thesis.created_at)} · hace {thesis.days_elapsed} días
                  {thesis.current_price !== null && ` · precio hoy ${fmtNumber(thesis.current_price)}`}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => addScenario(thesis.id)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  + Escenario
                </button>
                <button
                  onClick={async () => {
                    if (window.confirm(`¿Borrar la tesis «${thesis.title}»?`)) {
                      await api.deleteThesis(thesis.id)
                      load()
                    }
                  }}
                  className="text-xs text-slate-400 hover:text-red-600"
                >
                  Borrar
                </button>
              </div>
            </div>

            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{thesis.body_md}</p>

            {thesis.invalidation_criteria && (
              <div className="mt-2 rounded-lg border-l-2 border-amber-400 bg-amber-50 px-3 py-2">
                <div className="text-xs font-semibold text-amber-800">
                  Qué me haría cambiar de opinión
                </div>
                <p className="text-sm text-amber-900">{thesis.invalidation_criteria}</p>
              </div>
            )}

            {thesis.scenarios.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {thesis.scenarios.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm"
                  >
                    <span className="text-slate-700">
                      <b>{KIND_LABELS[s.kind] ?? s.kind}</b>
                      {s.value_mid !== null && ` · valor estimado ${fmtNumber(s.value_mid)}`}
                      {s.price_at_creation !== null &&
                        ` · precio entonces ${fmtNumber(s.price_at_creation)}`}
                      <span className="ml-2 text-xs text-slate-400">hace {s.days_elapsed} d</span>
                    </span>
                    <OutcomeChip scenario={s} />
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}

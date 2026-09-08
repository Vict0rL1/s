import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type {
  Comparables,
  DcfInverso,
  RangoGlobal,
  Sensibilidad,
  SupuestosEscenario,
  Valoracion,
  WatchlistItem,
} from '../api/types'
import { fmtNumber } from '../lib/format'

const ESCENARIOS = ['bajista', 'base', 'alcista'] as const
type NombreEscenario = (typeof ESCENARIOS)[number]

const TONO: Record<NombreEscenario, string> = {
  bajista: 'text-red-700',
  base: 'text-slate-800',
  alcista: 'text-emerald-700',
}

const pct = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`

/** La barra del rango, con el precio actual marcado encima.
 *
 *  Es deliberadamente una BARRA y no un número: enseñar «vale 280 $» sería el
 *  precio objetivo que este módulo no produce. Lo que se ve es la horquilla y
 *  dónde cae el precio dentro (o fuera) de ella. */
function BarraRango({
  bajo,
  alto,
  actual,
  tono = 'bg-slate-400',
}: {
  bajo: number
  alto: number
  actual?: number | null
  tono?: string
}) {
  const min = Math.min(bajo, actual ?? bajo)
  const max = Math.max(alto, actual ?? alto)
  const span = max - min || 1
  const izq = ((bajo - min) / span) * 100
  const ancho = ((alto - bajo) / span) * 100
  const marca = actual !== null && actual !== undefined ? ((actual - min) / span) * 100 : null
  return (
    <div className="relative h-6">
      <div className="absolute top-2.5 h-1 w-full rounded-full bg-slate-200" />
      <div
        className={`absolute top-2.5 h-1 rounded-full ${tono}`}
        style={{ left: `${izq}%`, width: `${Math.max(ancho, 1)}%` }}
      />
      {marca !== null && (
        <div
          className="absolute top-0.5 h-5 w-0.5 bg-slate-900"
          style={{ left: `calc(${marca}% - 1px)` }}
          title={`Precio actual: ${actual}`}
        />
      )}
    </div>
  )
}

function RangoGlobalPanel({ g }: { g: RangoGlobal }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">
        Rango de valor, del escenario más pesimista al más optimista
      </h2>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums text-slate-900">
          {fmtNumber(g.bajo, 0)} – {fmtNumber(g.alto, 0)}
        </span>
        {g.precio_actual !== null && (
          <span className="text-sm text-slate-500">
            cotiza a{' '}
            <span className="font-medium tabular-nums text-slate-800">
              {fmtNumber(g.precio_actual, 0)}
            </span>{' '}
            ({g.posicion})
          </span>
        )}
      </div>
      <div className="mt-2">
        <BarraRango bajo={g.bajo} alto={g.alto} actual={g.precio_actual} />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{g.nota}</p>
    </section>
  )
}

/** Los tres escenarios, cada uno con su rango y sus supuestos editables. */
function Escenarios({
  data,
  supuestos,
  onCambiar,
  onAplicar,
  busy,
}: {
  data: Valoracion
  supuestos: Record<string, SupuestosEscenario>
  onCambiar: (n: string, campo: keyof SupuestosEscenario, v: number) => void
  onAplicar: () => void
  busy: boolean
}) {
  const precio = data.entradas.precio_actual
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">
        Escenarios, con sus supuestos
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        {data.nota_supuestos}
      </p>

      <div className="mt-4 space-y-4">
        {ESCENARIOS.filter((n) => data.escenarios[n]).map((nombre) => {
          const e = data.escenarios[nombre]
          const s = supuestos[nombre] ?? e.supuestos
          return (
            <div key={nombre} className="rounded-lg border border-slate-100 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className={`text-sm font-medium capitalize ${TONO[nombre]}`}>
                  {nombre}
                </span>
                {e.rango.disponible ? (
                  <span className="tabular-nums text-slate-900">
                    {fmtNumber(e.rango.bajo, 0)}{' '}
                    <span className="text-slate-400">–</span>{' '}
                    <span className="font-medium">{fmtNumber(e.rango.centro, 0)}</span>{' '}
                    <span className="text-slate-400">–</span> {fmtNumber(e.rango.alto, 0)}
                  </span>
                ) : (
                  <span className="text-xs text-amber-700">sin rango calculable</span>
                )}
              </div>

              {e.rango.disponible && (
                <div className="mt-1">
                  <BarraRango
                    bajo={e.rango.bajo!}
                    alto={e.rango.alto!}
                    actual={precio}
                    tono={
                      nombre === 'bajista'
                        ? 'bg-red-400'
                        : nombre === 'alcista'
                          ? 'bg-emerald-400'
                          : 'bg-slate-400'
                    }
                  />
                </div>
              )}

              <div className="mt-2 grid grid-cols-3 gap-3">
                {(
                  [
                    ['growth_rate', 'Crecimiento FCF'],
                    ['discount_rate', 'WACC'],
                    ['terminal_growth', 'Perpetuidad'],
                  ] as [keyof SupuestosEscenario, string][]
                ).map(([campo, etiqueta]) => (
                  <label key={campo} className="block">
                    <span className="block text-[10px] uppercase tracking-wide text-slate-400">
                      {etiqueta}
                    </span>
                    <div className="flex items-baseline gap-1">
                      <input
                        type="number"
                        step={0.1}
                        value={(s[campo] * 100).toFixed(1)}
                        onChange={(ev) =>
                          onCambiar(nombre, campo, Number(ev.target.value) / 100)
                        }
                        className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-sm tabular-nums focus:border-sky-500 focus:outline-none"
                      />
                      <span className="text-xs text-slate-400">%</span>
                    </div>
                  </label>
                ))}
              </div>

              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                {e.rango.nota}
              </p>
            </div>
          )
        })}
      </div>

      <button
        onClick={onAplicar}
        disabled={busy}
        className="mt-3 rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Calculando…' : 'Recalcular con mis supuestos'}
      </button>
    </section>
  )
}

function SensibilidadPanel({ s }: { s: Sensibilidad }) {
  if (!s.disponible || !s.supuestos?.length) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-500">{s.nota}</p>
      </section>
    )
  }
  const mayor = s.supuestos[0].recorrido_pct || 1
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">
        Qué supuesto mueve más el resultado
      </h2>
      <ul className="mt-3 space-y-2">
        {s.supuestos.map((f) => (
          <li key={f.supuesto}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-slate-700">{f.etiqueta}</span>
              <span className="tabular-nums text-slate-900">
                {f.recorrido_pct.toFixed(0)} %
                {f.asimetrico && (
                  <span
                    className="ml-1.5 text-[10px] text-amber-700"
                    title="Mueve más hacia un lado que hacia el otro"
                  >
                    asimétrico
                  </span>
                )}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 w-full rounded-full bg-slate-100">
              <div
                className="h-1.5 rounded-full bg-slate-500"
                style={{ width: `${(f.recorrido_pct / mayor) * 100}%` }}
              />
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-slate-400">
              {fmtNumber(f.valor_abajo, 0)} → {fmtNumber(f.valor_arriba, 0)}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{s.nota}</p>
    </section>
  )
}

/** La pregunta más útil de las cuatro: qué hay que creerse. */
function InversoPanel({ inv }: { inv: DcfInverso }) {
  if (!inv.disponible || !inv.curva?.disponible) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">DCF inverso</h2>
        <p className="mt-1 text-xs text-slate-500">
          {inv.nota ?? inv.curva?.nota ?? 'No disponible.'}
        </p>
      </section>
    )
  }
  const puntos = inv.curva.puntos.filter((p) => p.crecimiento_implicito !== null)
  const maxAbs = Math.max(...puntos.map((p) => Math.abs(p.crecimiento_implicito!)), 0.01)
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">
        DCF inverso: qué descuenta el precio de hoy
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{inv.resumen}</p>

      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wide text-slate-400">
          Crecimiento del FCF implícito, según la tasa de descuento
        </div>
        <ul className="mt-1 space-y-1">
          {inv.curva.puntos.map((p) => (
            <li key={p.discount_rate} className="flex items-center gap-2 text-sm">
              <span className="w-14 text-xs tabular-nums text-slate-400">
                {pct(p.discount_rate, 0)}
              </span>
              {p.crecimiento_implicito === null ? (
                <span className="text-xs text-amber-700">fuera de rango</span>
              ) : (
                <>
                  <div className="relative h-2 flex-1 rounded-full bg-slate-100">
                    <div
                      className={`absolute top-0 h-2 rounded-full ${
                        p.crecimiento_implicito >= 0 ? 'bg-sky-500' : 'bg-amber-500'
                      }`}
                      style={{
                        left: '50%',
                        width: `${(Math.abs(p.crecimiento_implicito) / maxAbs) * 50}%`,
                        transform:
                          p.crecimiento_implicito < 0
                            ? `translateX(-${(Math.abs(p.crecimiento_implicito) / maxAbs) * 100}%)`
                            : undefined,
                      }}
                    />
                  </div>
                  <span className="w-16 text-right tabular-nums text-slate-800">
                    {pct(p.crecimiento_implicito)}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      {inv.contraste?.disponible && (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-xs leading-relaxed text-slate-700">{inv.contraste.nota}</p>
          {inv.contraste.referencias && (
            <p className="mt-1 text-[11px] text-slate-400">
              Crecimiento histórico:{' '}
              {Object.entries(inv.contraste.referencias)
                .map(([k, v]) => `${k} ${pct(v)}`)
                .join(' · ')}
            </p>
          )}
        </div>
      )}

      {inv.margen?.disponible && (
        <p className="mt-3 text-xs leading-relaxed text-slate-600">{inv.margen.nota}</p>
      )}
    </section>
  )
}

function ComparablesPanel({ c }: { c: Comparables }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">
        Comparables, ajustados por crecimiento y calidad
      </h2>

      {c.disponible && c.fiable && c.intervalo ? (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3">
            <span className="text-lg font-semibold tabular-nums text-slate-900">
              {c.etiqueta_multiplo} {c.intervalo.bajo} – {c.intervalo.alto}
            </span>
            <span className="text-sm text-slate-500">
              cotiza a{' '}
              <span className="font-medium text-slate-800">{c.multiplo_objetivo}</span>{' '}
              ({c.dentro_del_intervalo ? 'dentro' : 'fuera'})
            </span>
          </div>
          <div className="mt-1">
            <BarraRango
              bajo={c.intervalo.bajo}
              alto={c.intervalo.alto}
              actual={c.multiplo_objetivo}
              tono="bg-sky-400"
            />
          </div>
          <p className="mt-1 text-[11px] tabular-nums text-slate-400">
            {c.pares_usables} pares · {c.grados_libertad} grados de libertad · R²{' '}
            {c.r2}
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-amber-800">{c.nota}</p>
      )}

      {c.precio_implicito?.disponible && (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-xs leading-relaxed text-slate-700">
            {c.precio_implicito.nota}
          </p>
          {c.precio_implicito.aviso && (
            <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
              {c.precio_implicito.aviso}
            </p>
          )}
        </div>
      )}

      {c.pares && c.pares.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 text-left font-medium">Par</th>
                <th className="py-1.5 text-right font-medium">Múltiplo</th>
                <th className="py-1.5 text-right font-medium">Crecimiento</th>
                <th className="py-1.5 text-right font-medium">Calidad (ROE)</th>
                <th className="py-1.5 text-right font-medium">Residuo</th>
              </tr>
            </thead>
            <tbody>
              {c.pares.map((p) => (
                <tr key={p.symbol} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 text-slate-700">{p.symbol}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-900">
                    {p.multiplo}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">
                    {pct(p.crecimiento)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">
                    {pct(p.calidad)}
                  </td>
                  <td
                    className={`py-1.5 text-right tabular-nums ${
                      p.residuo > 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {p.residuo > 0 ? '+' : ''}
                    {p.residuo}
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

export function ValuationPage() {
  const [entrada, setEntrada] = useState('')
  const [symbol, setSymbol] = useState('')
  const [seguidas, setSeguidas] = useState<string[]>([])
  const [data, setData] = useState<Valoracion | null>(null)
  const [supuestos, setSupuestos] = useState<Record<string, SupuestosEscenario>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.watchlist().then(
      (w) => setSeguidas(w.items.map((i: WatchlistItem) => i.symbol)),
      () => setSeguidas([]),
    )
  }, [])

  const correr = useCallback(
    async (s: string, escenarios?: Record<string, SupuestosEscenario>) => {
      setBusy(true)
      setError(null)
      try {
        const d = await api.valorar(s, escenarios ? { escenarios } : {})
        setData(d)
        setSymbol(s)
        setSupuestos(
          Object.fromEntries(
            Object.entries(d.escenarios).map(([k, v]) => [k, { ...v.supuestos }]),
          ),
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error')
        setData(null)
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">Valoración</h1>
      <p className="text-xs leading-relaxed text-slate-500">
        DCF por escenarios, DCF inverso, comparables ajustados por crecimiento y
        calidad, y qué supuesto decide el resultado.{' '}
        <strong>Aquí no hay ningún precio objetivo</strong> — hay rangos, un
        intervalo y una curva.
      </p>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const s = entrada.trim().toUpperCase()
            if (s) correr(s)
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={entrada}
            onChange={(e) => setEntrada(e.target.value)}
            placeholder="AAPL"
            className="w-36 rounded-lg border border-slate-300 px-3 py-1.5 text-sm uppercase focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Calculando…' : 'Valorar'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </form>
        {seguidas.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-400">De tu watchlist:</span>
            {seguidas.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setEntrada(s)
                  correr(s)
                }}
                className={`rounded-full px-2 py-0.5 text-xs ${
                  symbol === s
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </section>

      {data && (
        <>
          {data.rango_global && <RangoGlobalPanel g={data.rango_global} />}
          <SensibilidadPanel s={data.sensibilidad} />
          <Escenarios
            data={data}
            supuestos={supuestos}
            busy={busy}
            onCambiar={(n, campo, v) =>
              setSupuestos((prev) => ({ ...prev, [n]: { ...prev[n], [campo]: v } }))
            }
            onAplicar={() => correr(symbol, supuestos)}
          />
          <InversoPanel inv={data.dcf_inverso} />
          <ComparablesPanel c={data.comparables} />

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              De dónde salen las entradas
            </h3>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ['FCF de partida', fmtNumber(data.entradas.base_fcf / 1e6, 0) + ' M'],
                ['Deuda neta', fmtNumber(data.entradas.net_debt / 1e6, 0) + ' M'],
                [
                  'Acciones',
                  data.entradas.shares_outstanding
                    ? fmtNumber(data.entradas.shares_outstanding / 1e6, 0) + ' M'
                    : '—',
                ],
                ['Ejercicio', String(data.entradas.fiscal_year ?? '—')],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[10px] uppercase tracking-wide text-slate-400">
                    {k}
                  </dt>
                  <dd className="tabular-nums text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-[11px] text-slate-400">
              Estados financieros de {data.entradas.source}, ejercicio{' '}
              {String(data.entradas.fiscal_year)}. Crecimiento histórico:{' '}
              ingresos {pct(data.entradas.crecimiento_historico.revenue_cagr)} ·
              FCF {pct(data.entradas.crecimiento_historico.fcf_cagr)} · BPA{' '}
              {pct(data.entradas.crecimiento_historico.eps_cagr)}.
            </p>
          </section>

          <p className="text-[11px] leading-relaxed text-slate-400">
            {data.disclaimer}
          </p>
        </>
      )}
    </div>
  )
}

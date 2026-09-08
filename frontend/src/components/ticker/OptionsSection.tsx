import { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type {
  ActividadOpciones,
  EstructuraTemporal,
  MovimientoEsperado,
  PrimaDeRiesgo,
  SeñalesDeOpciones,
  SkewSignal,
} from '../../api/types'
import { fmtNumber } from '../../lib/format'

const pct = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`

/** Una nota al pie. Lo que hace legible al número de arriba, no decoración. */
function Nota({ children }: { children: React.ReactNode }) {
  if (!children) return null
  return <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{children}</p>
}

function Bloque({
  titulo,
  pregunta,
  children,
}: {
  titulo: string
  pregunta: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">{titulo}</h3>
      <p className="mt-0.5 text-xs text-slate-500">{pregunta}</p>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Cuando una señal no se puede calcular, decirlo ocupa el mismo sitio. */
function NoDisponible({ nota }: { nota?: string }) {
  return <p className="text-sm text-slate-500">{nota ?? 'No hay datos suficientes.'}</p>
}

function Prima({ p }: { p: PrimaDeRiesgo }) {
  if (!p.disponible) return <NoDisponible nota={p.nota} />
  const prima = p.prima ?? 0
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Implícita 30 d
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">
            {pct(p.iv)}
          </div>
        </div>
        <div className="text-xl text-slate-300">−</div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Realizada 30 d
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-500">
            {pct(p.rv)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Prima</div>
          <div
            className={`text-2xl font-semibold tabular-nums ${
              prima > 0 ? 'text-amber-700' : 'text-sky-700'
            }`}
          >
            {prima > 0 ? '+' : ''}
            {pct(prima)}
          </div>
        </div>
        {p.percentil !== null && p.percentil !== undefined && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Percentil propio
            </div>
            <div className="text-2xl font-semibold tabular-nums text-slate-800">
              {fmtNumber(p.percentil, 0)}
            </div>
          </div>
        )}
      </div>
      <Nota>{p.nota}</Nota>
      {/* El sesgo va SIEMPRE, tenga o no percentil: es la letra pequeña de la
          resta misma, no un aviso de cobertura. */}
      <p className="mt-1 text-[11px] leading-relaxed text-amber-700">{p.aviso_sesgo}</p>
    </>
  )
}

function Skew({ s }: { s: SkewSignal }) {
  if (!s.disponible) return <NoDisponible nota={s.nota} />
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Put 25Δ ({s.strike_put})
          </div>
          <div className="text-xl font-semibold tabular-nums text-slate-800">
            {pct(s.iv_put_25d)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Call 25Δ ({s.strike_call})
          </div>
          <div className="text-xl font-semibold tabular-nums text-slate-800">
            {pct(s.iv_call_25d)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Skew</div>
          <div
            className={`text-2xl font-semibold tabular-nums ${
              (s.skew ?? 0) < 0 ? 'text-amber-700' : 'text-slate-800'
            }`}
          >
            {(s.skew ?? 0) > 0 ? '+' : ''}
            {pct(s.skew)}
          </div>
        </div>
      </div>
      <Nota>{s.nota}</Nota>
    </>
  )
}

function Estructura({ e }: { e: EstructuraTemporal }) {
  if (!e.disponible) return <NoDisponible nota={e.nota} />
  const ivs = e.puntos.map((p) => p.iv)
  const min = Math.min(...ivs)
  const max = Math.max(...ivs)
  const span = max - min || 1
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            e.forma === 'backwardation'
              ? 'bg-amber-100 text-amber-800'
              : 'bg-slate-100 text-slate-700'
          }`}
        >
          {e.forma?.toUpperCase()}
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {e.puntos.map((p) => (
          <li key={p.vencimiento} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-500">
              {p.dias} d
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-slate-400"
                style={{ width: `${30 + ((p.iv - min) / span) * 70}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-700">
              {pct(p.iv)}
            </span>
          </li>
        ))}
      </ul>
      <Nota>{e.nota}</Nota>
    </>
  )
}

function Movimiento({ m }: { m: MovimientoEsperado }) {
  const { implicito: imp, historico: hist, comparacion: cmp } = m
  if (!imp.disponible && !hist.disponible) {
    return <NoDisponible nota={imp.nota ?? hist.nota} />
  }
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Implícito (straddle)
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">
            {imp.disponible ? `±${fmtNumber(imp.movimiento_pct, 1)} %` : '—'}
          </div>
          {imp.vencimiento && (
            <div className="text-[10px] text-slate-400">
              vence {imp.vencimiento} · resultados {imp.resultados}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Mediana real de la empresa
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-500">
            {hist.disponible ? `${fmtNumber(hist.mediana_abs_pct, 1)} %` : '—'}
          </div>
          {hist.disponible && (
            <div className="text-[10px] text-slate-400">
              {hist.n} resultados · mayor {fmtNumber(hist.maximo_abs_pct, 1)} %
            </div>
          )}
        </div>
        {cmp.disponible && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Razón</div>
            <div className="text-2xl font-semibold tabular-nums text-slate-800">
              {fmtNumber(cmp.razon, 2)}×
            </div>
          </div>
        )}
      </div>

      {hist.disponible && hist.movimientos.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {hist.movimientos.map((mv) => (
            <span
              key={mv.fecha}
              title={mv.fecha}
              className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${
                Math.abs(mv.movimiento_pct) > (imp.movimiento_pct ?? Infinity)
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {mv.movimiento_pct > 0 ? '+' : ''}
              {fmtNumber(mv.movimiento_pct, 1)} %
            </span>
          ))}
        </div>
      )}

      <Nota>{cmp.disponible ? cmp.nota : (imp.nota ?? hist.nota)}</Nota>
      {imp.disponible && <Nota>{imp.nota}</Nota>}
    </>
  )
}

function Actividad({ a }: { a: ActividadOpciones }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Volumen calls / puts
          </div>
          <div className="text-xl font-semibold tabular-nums text-slate-800">
            {a.volumen_calls.toLocaleString('es')} / {a.volumen_puts.toLocaleString('es')}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Put/Call (volumen)
          </div>
          <div className="text-xl font-semibold tabular-nums text-slate-800">
            {fmtNumber(a.put_call_volumen, 2)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Volumen / OI
          </div>
          <div className="text-xl font-semibold tabular-nums text-slate-800">
            {fmtNumber(a.volumen_sobre_oi, 2)}
          </div>
        </div>
        {a.inusual && a.inusual.z !== null && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Contra su media
            </div>
            <div
              className={`text-xl font-semibold tabular-nums ${
                Math.abs(a.inusual.z) >= 2 ? 'text-amber-700' : 'text-slate-800'
              }`}
            >
              {a.inusual.z > 0 ? '+' : ''}
              {fmtNumber(a.inusual.z, 1)} σ
            </div>
          </div>
        )}
      </div>

      {a.posiciones_nuevas.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
              <th className="pb-1 font-medium">Contrato</th>
              <th className="pb-1 text-right font-medium">Volumen</th>
              <th className="pb-1 text-right font-medium">Abierto</th>
              <th className="pb-1 text-right font-medium">×</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {a.posiciones_nuevas.map((p) => (
              <tr key={`${p.tipo}-${p.strike}`}>
                <td className="py-1 text-slate-700">
                  {p.tipo === 'call' ? 'Call' : 'Put'} {p.strike}
                </td>
                <td className="py-1 text-right tabular-nums text-slate-700">
                  {p.volumen.toLocaleString('es')}
                </td>
                <td className="py-1 text-right tabular-nums text-slate-500">
                  {p.oi.toLocaleString('es')}
                </td>
                <td className="py-1 text-right font-medium tabular-nums text-amber-700">
                  {fmtNumber(p.ratio, 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Nota>{a.nota_posiciones}</Nota>
      <Nota>{a.nota_base}</Nota>
    </>
  )
}

export function OptionsSection({ symbol }: { symbol: string }) {
  const [datos, setDatos] = useState<SeñalesDeOpciones | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    setCargando(true)
    setError(null)
    setDatos(null)
    api
      .opciones(symbol)
      .then(setDatos, (e: ApiError) => setError(e.message))
      .finally(() => setCargando(false))
  }, [symbol])

  if (cargando) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        Leyendo la cadena de opciones…
      </p>
    )
  }
  if (error) {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        {error}
      </p>
    )
  }
  if (!datos) return null

  if (!datos.disponible) {
    return (
      <div className="space-y-3">
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          {datos.nota}
        </p>
        {datos.calidad && <Nota>{datos.calidad.nota}</Nota>}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* La regla de la casa, arriba del todo y no en letra pequeña: esto va al
          lado del fundamental, no dentro de él. */}
      <p className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-relaxed text-sky-900">
        {datos.aviso}
      </p>

      {datos.sin_precios && datos.nota_precios && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {datos.nota_precios}
        </p>
      )}

      {datos.prima_de_riesgo && (
        <Bloque
          titulo="Prima de riesgo"
          pregunta="¿Se está pagando más por cubrirse de lo que la acción se mueve de verdad?"
        >
          <Prima p={datos.prima_de_riesgo} />
        </Bloque>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {datos.skew && (
          <Bloque titulo="Skew 25Δ" pregunta="¿A qué lado le tiene miedo el mercado?">
            <Skew s={datos.skew} />
          </Bloque>
        )}
        {datos.estructura_temporal && (
          <Bloque titulo="Estructura temporal" pregunta="¿El susto es ahora o más adelante?">
            <Estructura e={datos.estructura_temporal} />
          </Bloque>
        )}
      </div>

      {datos.movimiento_esperado && (
        <Bloque
          titulo="Movimiento esperado en resultados"
          pregunta="¿Lo que se paga se parece a lo que esta empresa hace de verdad?"
        >
          <Movimiento m={datos.movimiento_esperado} />
        </Bloque>
      )}

      {datos.actividad && (
        <Bloque
          titulo="Volumen y posiciones abiertas"
          pregunta="¿Se está montando algo hoy que no estaba ayer?"
        >
          <Actividad a={datos.actividad} />
        </Bloque>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <Nota>{datos.base_historica?.nota}</Nota>
        {datos.calidad && <Nota>{datos.calidad.nota}</Nota>}
        <Nota>
          {datos.vencimientos_leidos?.length} de {datos.vencimientos_totales} vencimientos
          leídos{datos.fuente ? ` · fuente: ${datos.fuente}` : ''}
          {datos.cacheado ? ' (de caché)' : ''}
        </Nota>
        {datos.fallo_calendario && (
          <Nota>Calendario de resultados no disponible: {datos.fallo_calendario}</Nota>
        )}
      </div>
    </div>
  )
}

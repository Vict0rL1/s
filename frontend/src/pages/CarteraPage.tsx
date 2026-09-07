import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type {
  CaracteristicasDeCartera,
  ConcentracionReal,
  CrisisEstresada,
  ExposicionAgregada,
  LookThroughEtf,
  MatrizCorrelacion,
  RiesgoDeCartera,
} from '../api/types'
import { fmtBig, fmtNumber, fmtPct } from '../lib/format'

/** Color de una celda de correlación.
 *
 *  Escala divergente y no un degradado de un solo color: el signo importa más
 *  que la magnitud. Un +0,9 y un −0,9 son igual de fuertes y opuestos, y
 *  pintarlos como «mucho» y «poco» del mismo tono los confundiría. */
function tonoCorrelacion(v: number): string {
  if (v >= 0.85) return 'bg-red-100 text-red-800'
  if (v >= 0.6) return 'bg-amber-100 text-amber-800'
  if (v >= 0.3) return 'bg-slate-100 text-slate-700'
  if (v >= -0.2) return 'bg-sky-50 text-sky-800'
  return 'bg-emerald-100 text-emerald-800'
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{children}</p>
  )
}

function Seccion({
  titulo,
  subtitulo,
  children,
}: {
  titulo: string
  subtitulo: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">{titulo}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{subtitulo}</p>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** La matriz de correlación entre posiciones. */
function Correlacion({ c }: { c: MatrizCorrelacion }) {
  if (!c.disponible || !c.matriz || !c.simbolos) {
    return <p className="text-sm text-slate-500">{c.nota}</p>
  }
  const { simbolos, matriz } = c
  return (
    <>
      <div className="overflow-x-auto">
        <table className="text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className="sticky left-0 bg-white p-1" />
              {simbolos.map((s) => (
                <th key={s} className="p-1 font-medium text-slate-500">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matriz.map((fila, i) => (
              <tr key={simbolos[i]}>
                <th className="sticky left-0 bg-white p-1 pr-2 text-right font-medium text-slate-600">
                  {simbolos[i]}
                </th>
                {fila.map((v, j) => (
                  <td key={simbolos[j]} className="p-0.5">
                    <div
                      className={`rounded px-1.5 py-1 text-center ${
                        i === j ? 'text-slate-300' : tonoCorrelacion(v)
                      }`}
                    >
                      {i === j ? '—' : fmtNumber(v, 2)}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {c.parejas && c.parejas.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
          <span>
            Más pegadas:{' '}
            <strong className="text-slate-800">
              {c.parejas[0].a}–{c.parejas[0].b}
            </strong>{' '}
            ({fmtNumber(c.parejas[0].corr, 2)})
          </span>
          <span>
            Más sueltas:{' '}
            <strong className="text-slate-800">
              {c.parejas[c.parejas.length - 1].a}–{c.parejas[c.parejas.length - 1].b}
            </strong>{' '}
            ({fmtNumber(c.parejas[c.parejas.length - 1].corr, 2)})
          </span>
          {c.media !== null && c.media !== undefined && (
            <span>
              Media: <strong className="text-slate-800">{fmtNumber(c.media, 2)}</strong>
            </span>
          )}
        </div>
      )}
      <Aviso>{c.nota}</Aviso>
    </>
  )
}

/** Cuántas apuestas independientes hay detrás de N tickers. */
function Concentracion({ c }: { c: ConcentracionReal }) {
  if (!c.disponible || c.apuestas_efectivas === undefined) {
    return <p className="text-sm text-slate-500">{c.nota}</p>
  }
  const posiciones = c.posiciones ?? 0
  // Menos de la mitad de apuestas que de posiciones: la diversificación es
  // aparente. El color lo dice antes de que nadie lea el número.
  const alarma = c.apuestas_efectivas < posiciones * 0.5
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            Posiciones
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">
            {posiciones}
          </div>
        </div>
        <div className="text-2xl text-slate-300">→</div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            Apuestas independientes
          </div>
          <div
            className={`text-2xl font-semibold tabular-nums ${
              alarma ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {fmtNumber(c.apuestas_efectivas, 1)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            Explica un solo movimiento
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-800">
            {fmtNumber(c.primera_componente_pct, 0)} %
          </div>
        </div>
      </div>

      {c.autovalores_pct && c.autovalores_pct.length > 1 && (
        <div className="mt-4">
          <div className="mb-1 text-[11px] text-slate-400">
            Reparto de la variación entre movimientos independientes
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
            {c.autovalores_pct.map((p, i) => (
              <div
                key={i}
                className={i === 0 ? 'bg-slate-700' : 'bg-slate-300'}
                style={{ width: `${p}%` }}
                title={`Componente ${i + 1}: ${fmtNumber(p, 1)} %`}
              />
            ))}
          </div>
        </div>
      )}
      <Aviso>{c.nota}</Aviso>
    </>
  )
}

function Exposicion({ e, titulo }: { e: ExposicionAgregada; titulo: string }) {
  const max = e.filas[0]?.peso_pct ?? 1
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{titulo}</div>
      <ul className="mt-2 space-y-1.5">
        {e.filas.map((f) => (
          <li key={f.etiqueta} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-xs text-slate-600" title={f.etiqueta}>
              {f.etiqueta}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-slate-400"
                style={{ width: `${(f.peso_pct / max) * 100}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-700">
              {fmtNumber(f.peso_pct, 1)} %
            </span>
          </li>
        ))}
      </ul>
      {e.nota && <Aviso>{e.nota}</Aviso>}
    </div>
  )
}

/** Exposición real a cada empresa: la directa más la que va dentro de un ETF. */
function LookThrough({ lt }: { lt: LookThroughEtf }) {
  if (!lt.disponible) {
    return <p className="text-sm text-slate-500">{lt.nota}</p>
  }
  // Solo las que aportan algo indirecto: la tabla de posiciones ya enseña el resto.
  const conIndirecta = lt.exposicion.filter((e) => e.indirecta_pct > 0)
  return (
    <>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <th className="pb-1 font-medium">Empresa</th>
            <th className="pb-1 text-right font-medium">Directa</th>
            <th className="pb-1 text-right font-medium">Vía ETF</th>
            <th className="pb-1 text-right font-medium">Total real</th>
            <th className="pb-1 pl-3 font-medium">Dentro de</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {conIndirecta.map((e) => {
            const duplicada = e.directa_pct > 0
            return (
              <tr key={e.symbol} className={duplicada ? 'bg-amber-50' : undefined}>
                <td className="py-1.5 font-medium text-slate-800">
                  {e.symbol}
                  {duplicada && (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                      DOBLE VÍA
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right tabular-nums text-slate-600">
                  {e.directa_pct > 0 ? `${fmtNumber(e.directa_pct, 1)} %` : '—'}
                </td>
                <td className="py-1.5 text-right tabular-nums text-slate-600">
                  {fmtNumber(e.indirecta_pct, 2)} %
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums text-slate-800">
                  {fmtNumber(e.total_pct, 2)} %
                </td>
                <td className="py-1.5 pl-3 text-slate-500">
                  {e.via.map((v) => v.etf).join(', ')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {Object.keys(lt.cobertura_por_etf_pct).length > 0 && (
        <p className="mt-3 text-[11px] text-slate-500">
          Composición leída:{' '}
          {Object.entries(lt.cobertura_por_etf_pct)
            .map(([etf, pct]) => `${etf} (${fmtNumber(pct, 0)} % del fondo)`)
            .join(', ')}
        </p>
      )}
      <Aviso>{lt.nota}</Aviso>
    </>
  )
}

function Caracteristicas({ c }: { c: CaracteristicasDeCartera }) {
  const conDato = c.caracteristicas.filter((x) => x.valor !== null)
  if (conDato.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Ninguna posición tiene fundamentales descargados. Abre sus fichas o ejecuta
        el barrido de mercado y esta tabla se rellena sola.
      </p>
    )
  }
  // ROE y crecimiento llegan como fracción (0,684) y nadie lee eso como un
  // 68 %. La volatilidad ya viene en puntos porcentuales y no se multiplica.
  const formatear = (campo: string, v: number) => {
    if (campo === 'market_cap') return fmtBig(v)
    if (campo === 'roe' || campo === 'revenue_growth_5y') return fmtPct(v, 1)
    if (campo === 'vol_anual_pct') return `${fmtNumber(v, 1)} %`
    return fmtNumber(v, 1)
  }

  return (
    <>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <th className="pb-1 font-medium">Característica</th>
            <th className="pb-1 text-right font-medium">Tu cartera</th>
            {c.con_referencia && (
              <>
                <th className="pb-1 text-right font-medium">Empresa típica</th>
                <th className="pb-1 pl-3 font-medium">Inclinación</th>
              </>
            )}
            <th className="pb-1 text-right font-medium">Cobertura</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {conDato.map((x) => (
            <tr key={x.campo}>
              <td className="py-1.5 text-slate-700">
                {x.etiqueta}
                <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">
                  {x.familia.replace(/_/g, ' ')}
                </span>
              </td>
              <td className="py-1.5 text-right font-medium tabular-nums text-slate-800">
                {formatear(x.campo, x.valor as number)}
              </td>
              {c.con_referencia && (
                <>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">
                    {x.referencia !== undefined ? formatear(x.campo, x.referencia) : '—'}
                  </td>
                  <td className="py-1.5 pl-3">
                    {x.inclinacion && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          x.inclinacion === 'hacia'
                            ? 'bg-sky-100 text-sky-800'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {x.inclinacion}
                      </span>
                    )}
                  </td>
                </>
              )}
              <td className="py-1.5 text-right tabular-nums text-slate-500">
                {fmtNumber(x.cobertura_pct, 0)} %
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Aviso>
        {c.nota}
        {c.con_referencia && ` Universo: ${c.universo_empresas} empresas escaneadas.`}
      </Aviso>
    </>
  )
}

/** Una crisis, con su cobertura pegada al número. */
function Crisis({ c }: { c: CrisisEstresada }) {
  if (!c.medible) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="text-sm font-medium text-slate-700">{c.nombre}</div>
        <div className="text-[11px] text-slate-400">
          {c.desde} → {c.hasta}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-600">{c.nota}</p>
      </div>
    )
  }
  // El titular solo se pinta como titular si cubre de verdad la cartera. Por
  // debajo de la mitad se apaga: un número parcial con tipografía de titular
  // se lee como completo.
  const fiable = c.titular_fiable
  const retorno = c.retorno_pct ?? 0
  return (
    <div
      className={`rounded-lg border p-3 ${
        fiable ? 'border-slate-200 bg-white' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-slate-700">{c.nombre}</div>
          <div className="text-[11px] text-slate-400">
            {c.desde} → {c.hasta}
          </div>
        </div>
        {!fiable && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
            COBERTURA PARCIAL
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Esta mezcla
          </div>
          <div
            className={`font-semibold tabular-nums ${
              fiable ? 'text-2xl' : 'text-lg opacity-60'
            } ${retorno < 0 ? 'text-red-700' : 'text-emerald-700'}`}
          >
            {retorno > 0 ? '+' : ''}
            {fmtNumber(retorno, 1)} %
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">S&P 500</div>
          <div className="text-lg tabular-nums text-slate-500">
            {fmtNumber(c.caida_sp500_pct, 1)} %
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Caída máxima
          </div>
          <div className="text-lg tabular-nums text-slate-500">
            {fmtNumber(c.max_drawdown_pct, 1)} %
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Cubre</div>
          <div
            className={`text-lg tabular-nums ${
              fiable ? 'text-slate-500' : 'font-semibold text-amber-800'
            }`}
          >
            {fmtNumber(c.cobertura_pct, 0)} %
          </div>
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-slate-600">{c.nota}</p>
      <p className="mt-1 text-[11px] text-slate-400">{c.contexto}</p>
    </div>
  )
}

export function CarteraPage() {
  const [datos, setDatos] = useState<RiesgoDeCartera | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  const cargar = useCallback((descargar: boolean) => {
    setCargando(true)
    setError(null)
    api
      .riesgoDeCartera(descargar)
      .then(setDatos, (e: Error) => setError(e.message))
      .finally(() => setCargando(false))
  }, [])

  // La primera carga no descarga: veinte años por posición no se piden sin que
  // nadie los haya pedido. El botón lo hace explícito.
  useEffect(() => {
    cargar(false)
  }, [cargar])

  const faltanHistoricos = Object.keys(datos?.sin_historico ?? {}).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">Cartera</h1>
          <p className="text-xs text-slate-500">
            Ocho análisis buenos de ocho empresas no son un análisis de la cartera:
            las preguntas cambian.
          </p>
        </div>
        <button
          type="button"
          onClick={() => cargar(true)}
          disabled={cargando}
          className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {cargando ? 'Descargando…' : 'Descargar histórico completo'}
        </button>
      </div>

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      {datos && !datos.disponible && (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          {datos.nota}
        </p>
      )}

      {datos?.disponible && (
        <>
          {faltanHistoricos > 0 && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
              <p className="text-sm text-sky-900">
                {faltanHistoricos} posición(es) sin histórico largo:{' '}
                {Object.keys(datos.sin_historico ?? {}).join(', ')}. El estrés de las
                crisis las cuenta como no cubiertas — pulsa «Descargar histórico
                completo» para incluirlas.
              </p>
            </div>
          )}

          {datos.concentracion && (
            <Seccion
              titulo="Concentración real"
              subtitulo="Diez posiciones que se mueven juntas son una apuesta repartida en diez recibos."
            >
              <Concentracion c={datos.concentracion} />
            </Seccion>
          )}

          {datos.correlacion && (
            <Seccion
              titulo="Correlación entre posiciones"
              subtitulo="Si suben y bajan a la vez, tener ocho no es tener ocho."
            >
              <Correlacion c={datos.correlacion} />
            </Seccion>
          )}

          {datos.exposicion && (
            <Seccion
              titulo="Exposición agregada"
              subtitulo="Dónde está el dinero cuando se suman todas las posiciones."
            >
              <div className="grid gap-6 md:grid-cols-2">
                <Exposicion e={datos.exposicion.sector} titulo="Por sector" />
                <Exposicion e={datos.exposicion.geografia} titulo="Por geografía" />
              </div>
              <Aviso>{datos.nota_geografia}</Aviso>
            </Seccion>
          )}

          {datos.look_through && (
            <Seccion
              titulo="Lo que llevas dentro de los ETFs"
              subtitulo="Tu exposición a una empresa es la directa más la que va dentro del fondo."
            >
              <LookThrough lt={datos.look_through} />
            </Seccion>
          )}

          {datos.caracteristicas && (
            <Seccion
              titulo="Características de factor"
              subtitulo="Hacia qué se inclina la cartera. Descriptivo, no estimado por regresión."
            >
              <Caracteristicas c={datos.caracteristicas} />
            </Seccion>
          )}

          {datos.estres && (
            <Seccion
              titulo="Esta mezcla en 2008, 2020 y 2022"
              subtitulo="Crisis reales, fechas públicas, pesos de hoy."
            >
              <div className="grid gap-3 md:grid-cols-3">
                {datos.estres.crisis.map((c) => (
                  <Crisis key={c.clave} c={c} />
                ))}
              </div>
              <Aviso>{datos.estres.aviso_general}</Aviso>
            </Seccion>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type {
  Familia,
  FilaMultifactor,
  MarketInfo,
  MultifactorResult,
  PercentilHistorico,
} from '../api/types'
import { fmtNumber, fmtPct } from '../lib/format'

const FAMILIAS: Familia[] = [
  'value',
  'quality',
  'momentum',
  'growth',
  'low_volatility',
  'size',
]

const ETIQUETA: Record<Familia, string> = {
  value: 'Valor',
  quality: 'Calidad',
  momentum: 'Momentum',
  growth: 'Crecimiento',
  low_volatility: 'Baja volatilidad',
  size: 'Tamaño',
}

/** Lo que hay que saber de cada factor ANTES de subirle el peso. La evidencia
 *  de los seis no es la misma, y un control deslizante idéntico para todos
 *  sugiere lo contrario. */
const ADVERTENCIA: Record<Familia, string> = {
  value:
    'Evidencia sólida y muy replicada. Se paga con rachas malas largas: 2010-2020 fue brutal para el value.',
  quality:
    'Evidencia sólida y la más estable de las seis. Se solapa bastante con baja volatilidad.',
  momentum:
    'Evidencia sólida. Su riesgo es concentrado: se desploma en los giros de mercado (momentum crashes).',
  growth:
    'Débil como factor de RETORNO. Crecer no es lo mismo que rendir, y pagar por crecimiento pasado tiende a restar. Lo que funciona en la literatura es rentabilidad + inversión, no ventas pasadas.',
  low_volatility:
    'Real pero discutida: buena parte se explica por calidad. Además aquí se solapa con el dimensionador, que YA penaliza la volatilidad al decidir el tamaño.',
  size: 'La más erosionada de las seis. Casi desaparece al ajustar por calidad, y en un universo de grandes cotizadas «pequeña» significa 30.000 millones: no es el factor académico.',
}

const METRICA: Record<string, string> = {
  roe: 'ROE',
  roic: 'ROIC',
  operating_margin: 'Margen operativo',
  net_margin: 'Margen neto',
  fcf_margin: 'Margen FCF',
  gross_margin: 'Margen bruto',
  debt_to_equity: 'Deuda / capital',
  current_ratio: 'Ratio corriente',
  interest_coverage: 'Cobertura de intereses',
  asset_turnover: 'Rotación de activos',
}

const PORCENTAJE = new Set([
  'roe',
  'roic',
  'operating_margin',
  'net_margin',
  'fcf_margin',
  'gross_margin',
])

function fmtMetrica(clave: string, valor: number | null | undefined) {
  if (valor === null || valor === undefined) return '—'
  // Ambas ramas por el mismo formateador local: mezclar `toFixed` con
  // `toLocaleString('es')` ponía «21.3 %» y «0,56» en columnas contiguas de la
  // misma tabla, con dos separadores decimales distintos.
  return PORCENTAJE.has(clave) ? fmtPct(valor) : fmtNumber(valor, 2)
}

/** Una celda de z-score con color. El cero es el centro, no un extremo. */
function ZCell({ z }: { z: number | null }) {
  if (z === null) {
    return <span className="text-slate-300">—</span>
  }
  const tono =
    z >= 1 ? 'text-emerald-700' : z >= 0.3 ? 'text-emerald-600' :
    z <= -1 ? 'text-red-700' : z <= -0.3 ? 'text-red-600' : 'text-slate-400'
  return (
    <span className={`tabular-nums ${tono}`}>
      {z > 0 ? '+' : ''}
      {z.toFixed(2)}
    </span>
  )
}

/** Barra del percentil histórico, con la marca de dónde cae hoy.
 *
 *  Se colorea por `percentil_favorable`, nunca por el percentil crudo: estar en
 *  el percentil 90 de deuda es la peor lectura posible, y pintarla de verde
 *  sería exactamente al revés. */
function BarraPercentil({ dato }: { dato: PercentilHistorico }) {
  if (!dato.disponible || dato.percentil === null || dato.percentil === undefined) {
    return <span className="text-[11px] text-slate-400">{dato.motivo}</span>
  }
  const fav = dato.percentil_favorable ?? 0.5
  const color = fav >= 0.8 ? 'bg-emerald-500' : fav <= 0.2 ? 'bg-red-500' : 'bg-slate-400'
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-24 rounded-full bg-slate-200">
        <div
          className={`absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-full ${color}`}
          style={{ left: `calc(${dato.percentil * 100}% - 2px)` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-slate-500">
        p{Math.round(dato.percentil * 100)}
      </span>
    </div>
  )
}

/** La tabla que separa «mejor que sus comparables hoy» de «normal en ellos».
 *
 *  Es la razón de ser de esta pantalla. Un ROE del 18 % puntúa bien contra el
 *  sector; que venga del 30 % y lleve tres años cayendo no lo ve ningún z-score
 *  transversal, porque compara hacia los lados y no hacia atrás. */
function HistoriaPropia({ fila }: { fila: FilaMultifactor }) {
  const h = fila.historia
  if (!h || h.medidas === 0) {
    return (
      <p className="text-xs text-slate-400">
        {h?.nota ?? 'Sin histórico anual suficiente para situar sus métricas.'}
      </p>
    )
  }
  const medibles = Object.entries(h.metricas).filter(([, d]) => d.disponible)
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-slate-700">
          Frente a su propia historia ({h.desde}–{h.hasta}, {h.ejercicios} ejercicios)
        </p>
        {(h.avisos ?? []).length === 0 ? (
          <p className="text-xs text-slate-500">{h.nota}</p>
        ) : (
          h.avisos!.map((aviso) => (
            <p key={aviso.tipo} className="text-xs leading-relaxed text-slate-600">
              <span
                className={
                  aviso.tipo === 'deterioro'
                    ? 'font-medium text-red-700'
                    : 'font-medium text-emerald-700'
                }
              >
                {aviso.metricas.map((m) => METRICA[m] ?? m).join(', ')}
              </span>
              : {aviso.advertencia}
            </p>
          ))
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead className="text-[10px] uppercase tracking-wide text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 text-left font-medium">Métrica</th>
              <th className="py-1.5 text-right font-medium">Hoy</th>
              <th className="py-1.5 text-right font-medium">Mediana</th>
              <th className="py-1.5 text-right font-medium">Rango</th>
              <th className="py-1.5 pl-4 text-left font-medium">En su historia</th>
            </tr>
          </thead>
          <tbody>
            {medibles.map(([clave, d]) => (
              <tr key={clave} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 text-slate-700">{METRICA[clave] ?? clave}</td>
                <td className="py-1.5 text-right tabular-nums text-slate-900">
                  {fmtMetrica(clave, d.actual)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-slate-500">
                  {fmtMetrica(clave, d.mediana)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-slate-400">
                  {fmtMetrica(clave, d.min)}–{fmtMetrica(clave, d.max)}
                </td>
                <td className="py-1.5 pl-4">
                  <BarraPercentil dato={d} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-400">
        El percentil compara a la empresa con sus propios ejercicios anteriores, no
        con el sector. El z-score de arriba dice quién va mejor hoy; esto dice si
        eso es normal en ella o un extremo del que se vuelve.
      </p>
    </div>
  )
}

export function MultifactorPage() {
  const [markets, setMarkets] = useState<MarketInfo[]>([])
  const [market, setMarket] = useState('us_sp500')
  const [pesos, setPesos] = useState<Record<Familia, number>>({
    value: 0.25,
    quality: 0.25,
    momentum: 0.25,
    growth: 0.1,
    low_volatility: 0.1,
    size: 0.05,
  })
  const [data, setData] = useState<MultifactorResult | null>(null)
  const [abierta, setAbierta] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.multifactorMeta().then(
      (m) => {
        // Se valida la forma en vez de confiar en ella: los pesos gobiernan
        // todo lo que pinta esta pantalla, y un `setPesos(undefined)` la deja
        // en blanco entera. Si el servidor no manda algo utilizable, se sigue
        // con los de partida, que ya están puestos.
        setMarkets(Array.isArray(m?.markets) ? m.markets : [])
        if (m?.pesos_por_defecto && FAMILIAS.every((f) => f in m.pesos_por_defecto)) {
          setPesos(m.pesos_por_defecto)
        }
      },
      () => setMarkets([]),
    )
  }, [])

  const correr = async () => {
    setBusy(true)
    setError(null)
    try {
      setData(await api.runMultifactor({ market, weights: pesos, con_historia: 20 }))
      setAbierta(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
      setData(null)
    } finally {
      setBusy(false)
    }
  }

  // El servidor hace el trabajo caro una vez y devuelve los z de cada familia.
  // Reordenar con pesos nuevos es aritmética sobre datos que ya están aquí, así
  // que los controles responden al instante en vez de pedir el mercado entero
  // a cada movimiento del ratón.
  const ranking = useMemo(() => {
    if (!data) return []
    const total = Object.values(pesos).reduce((a, b) => a + b, 0)
    if (total <= 0) return data.ranking
    return data.ranking
      .map((fila) => {
        let suma = 0
        let disponible = 0
        for (const f of FAMILIAS) {
          const z = fila.familias[f]
          if (z === null || !pesos[f]) continue
          suma += pesos[f] * z
          disponible += pesos[f]
        }
        return {
          ...fila,
          score: disponible > 0 ? suma / disponible : 0,
          cobertura: disponible / total,
        }
      })
      .sort((a, b) => b.score - a.score)
      .map((fila, i) => ({ ...fila, puesto: i + 1 }))
  }, [data, pesos])

  const desincronizado = useMemo(() => {
    if (!data) return false
    const total = Object.values(pesos).reduce((a, b) => a + b, 0) || 1
    return FAMILIAS.some(
      (f) => Math.abs((data.pesos[f] ?? 0) - pesos[f] / total) > 0.005,
    )
  }, [data, pesos])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-800">Screener multifactor</h1>
        <Link to="/screener" className="text-xs text-sky-700 hover:underline">
          ¿Buscas el screener por filtros? →
        </Link>
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        Seis exposiciones estándar, normalizadas <strong>dentro de cada sector</strong>,
        con los pesos en tus manos. Cada empresa del ranking trae además el percentil
        de sus métricas frente a su propia historia: el corte transversal dice quién
        va mejor hoy, la serie temporal dice si eso es normal en ella.
      </p>

      {/* --- Pesos --- */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-700">Pesos de los factores</h2>
          <button
            onClick={() =>
              setPesos({
                value: 0.25,
                quality: 0.25,
                momentum: 0.25,
                growth: 0.1,
                low_volatility: 0.1,
                size: 0.05,
              })
            }
            className="text-xs text-sky-700 hover:underline"
          >
            Restaurar los de partida
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FAMILIAS.map((f) => {
            const total = Object.values(pesos).reduce((a, b) => a + b, 0) || 1
            return (
              <div key={f}>
                <div className="flex items-baseline justify-between">
                  <label htmlFor={`peso-${f}`} className="text-sm text-slate-700">
                    {ETIQUETA[f]}
                  </label>
                  <span className="text-xs tabular-nums text-slate-500">
                    {Math.round((pesos[f] / total) * 100)} %
                  </span>
                </div>
                <input
                  id={`peso-${f}`}
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(pesos[f] * 100)}
                  onChange={(e) =>
                    setPesos({ ...pesos, [f]: Number(e.target.value) / 100 })
                  }
                  className="mt-1 w-full accent-slate-800"
                />
                <p className="mt-0.5 text-[11px] leading-tight text-slate-400">
                  {ADVERTENCIA[f]}
                </p>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            {markets.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            onClick={correr}
            disabled={busy}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Calculando…' : data ? 'Recalcular' : 'Ejecutar'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
          {data && desincronizado && (
            <span className="text-xs text-slate-500">
              Reordenado en vivo con los pesos nuevos. Los z-scores no cambian —
              solo su mezcla— así que no hace falta recalcular.
            </span>
          )}
        </div>
      </section>

      {data && (
        <>
          {/* --- Lo que el screener admite sobre sí mismo --- */}
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            {data.advertencia}
          </p>

          {data.correlacion_familias.solapamientos.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-slate-800">
                Estos factores se pisan entre sí
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {data.correlacion_familias.solapamientos.map((s) => (
                  <li key={s} className="tabular-nums">
                    · {s}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                {data.correlacion_familias.nota}
              </p>
            </section>
          )}

          {!data.completo && (
            <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              {data.nota_cobertura}
            </p>
          )}
          {data.aviso_sectores && (
            <p className="text-xs text-slate-500">{data.aviso_sectores}</p>
          )}

          {/* --- El ranking --- */}
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Empresa</th>
                    <th className="px-3 py-2 text-left font-medium">Sector</th>
                    <th className="px-3 py-2 text-right font-medium">Nota</th>
                    {FAMILIAS.map((f) => (
                      <th key={f} className="px-2 py-2 text-right font-medium">
                        {ETIQUETA[f].split(' ')[0]}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-medium">Cob.</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.slice(0, 40).map((fila) => (
                    <FilaTabla
                      key={fila.symbol}
                      fila={fila}
                      abierta={abierta === fila.symbol}
                      onToggle={() =>
                        setAbierta(abierta === fila.symbol ? null : fila.symbol)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="text-[11px] leading-relaxed text-slate-400">
            {data.nota} {data.nota_coste} Evaluadas {data.evaluadas} empresas en{' '}
            {Object.keys(data.sectores).length} sectores de {data.market_name}.
          </p>
        </>
      )}
    </div>
  )
}

function FilaTabla({
  fila,
  abierta,
  onToggle,
}: {
  fila: FilaMultifactor
  abierta: boolean
  onToggle: () => void
}) {
  // El aviso más útil de la fila: el z-score sectorial la premia mientras sus
  // propias métricas están en la peor parte de su rango.
  const deteriorando = fila.historia?.deteriorandose?.length ?? 0
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
      >
        <td className="px-3 py-2 tabular-nums text-slate-400">{fila.puesto}</td>
        <td className="px-3 py-2">
          <Link
            to={`/ticker/${fila.symbol}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-slate-800 hover:text-sky-700"
          >
            {fila.symbol}
          </Link>
          <span className="ml-2 text-xs text-slate-400">{fila.name}</span>
          {deteriorando > 0 && (
            <span
              className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800"
              title="Métricas en la peor parte de su propio rango histórico"
            >
              {deteriorando} en mínimos propios
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-slate-500">{fila.sector}</td>
        <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-900">
          {fila.score > 0 ? '+' : ''}
          {fila.score.toFixed(2)}
        </td>
        {FAMILIAS.map((f) => (
          <td key={f} className="px-2 py-2 text-right">
            <ZCell z={fila.familias[f]} />
          </td>
        ))}
        <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-400">
          {Math.round(fila.cobertura * 100)} %
        </td>
      </tr>
      {abierta && (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={4 + FAMILIAS.length + 1} className="px-4 py-3">
            <HistoriaPropia fila={fila} />
          </td>
        </tr>
      )}
    </>
  )
}

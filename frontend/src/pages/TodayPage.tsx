import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type {
  DailySignal,
  Conviction,
  Decision,
  DecisionAction,
  MarketInfo,
  TodayResponse,
} from '../api/types'
import { fmtChangePct, fmtNumber, relativeTime } from '../lib/format'

const FAMILY_LABELS: Record<string, string> = {
  value: 'Valor',
  quality: 'Calidad',
  momentum: 'Momentum',
  sentiment: 'Sentimiento',
}

type View = 'ideas' | 'comprar' | 'vigilar' | 'cartera' | 'todas'

/** El compuesto vive de facto en [-2, 2]; se mapea a 0-100 % para la barra. */
function scoreToPct(score: number): number {
  return Math.min(Math.max((score + 2) / 4, 0), 1) * 100
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

// La acción es lo primero que se lee, así que el color hace el trabajo: verde
// actúa, ámbar espera, rojo sal. Nada de verde para "mantener": mantener no es
// una oportunidad, es no hacer nada.
const ACTION_STYLES: Record<DecisionAction, string> = {
  comprar: 'bg-emerald-600 text-white',
  vigilar: 'bg-amber-100 text-amber-800',
  mantener: 'bg-slate-100 text-slate-600',
  reducir: 'bg-orange-100 text-orange-800',
  vender: 'bg-red-600 text-white',
  evitar: 'bg-slate-100 text-slate-400',
  ninguna: 'bg-slate-50 text-slate-400',
  sin_datos: 'bg-slate-50 text-slate-400',
}

function ActionChip({ decision }: { decision: Decision }) {
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        ACTION_STYLES[decision.action]
      }`}
    >
      {decision.label}
    </span>
  )
}

/** El plan completo: por qué, a qué precio, y cuándo salir. */
function DecisionPlan({ decision }: { decision: Decision }) {
  const { levels } = decision
  return (
    <div className="space-y-3">
      <ul className="space-y-1 text-xs leading-snug text-slate-600">
        {decision.reasons.map((r, i) => (
          <li key={i}>· {r}</li>
        ))}
      </ul>

      {levels && (
        // Sobre una posición abierta no hay zona de compra ni peso que sugerir:
        // esos campos llegan nulos y no se pintan. Enseñar «zona de compra» a
        // algo que la app te está diciendo que vendas sería contradecirse.
        <div className="grid max-w-xl grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-white p-3 sm:grid-cols-4">
          {levels.entrada_desde !== null && levels.entrada_hasta !== null && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">
                Zona de compra
              </div>
              <div className="text-sm tabular-nums text-slate-800">
                {fmtNumber(levels.entrada_desde, 2)}–{fmtNumber(levels.entrada_hasta, 2)}
              </div>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Stop
            </div>
            <div className="text-sm tabular-nums text-red-600">
              {fmtNumber(levels.stop, 2)}{' '}
              <span className="text-xs text-slate-400">
                {levels.stop_pct >= 0 ? '+' : ''}
                {levels.stop_pct} %
              </span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Objetivo
            </div>
            <div className="text-sm tabular-nums text-emerald-700">
              {fmtNumber(levels.objetivo, 2)}{' '}
              <span className="text-xs text-slate-400">
                {levels.objetivo_pct >= 0 ? '+' : ''}
                {levels.objetivo_pct} %
              </span>
            </div>
          </div>
          {levels.peso_sugerido_pct !== null && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">
                Peso sugerido
              </div>
              <div className="text-sm tabular-nums text-slate-800">
                {levels.peso_sugerido_pct} %
                <span className="block text-[10px] text-slate-400">
                  para arriesgar 1 %
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Un stop y un objetivo dicen dónde SALDRÍAS, no qué sueles ganar: casi
          la mitad de las operaciones no llegan a ninguno de los dos y vencen
          por plazo en un punto intermedio. Estos tres números salen del
          histórico simulado, así que describen lo que pasó. */}
      {decision.escenarios && (
        <div className="rounded-lg bg-slate-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Qué pasó con operaciones como esta ({decision.escenarios.n} simuladas)
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-3">
            {(
              [
                ['Bajista', decision.escenarios.bajista, 'text-red-600'],
                ['Base', decision.escenarios.base, 'text-slate-900'],
                ['Alcista', decision.escenarios.alcista, 'text-emerald-700'],
              ] as const
            ).map(([label, valor, tono]) => (
              <div key={label}>
                <div className="text-[10px] text-slate-400">{label}</div>
                <div className={`text-sm font-medium tabular-nums ${tono}`}>
                  {valor >= 0 ? '+' : ''}
                  {valor.toFixed(1)} %
                </div>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-slate-400">
            {decision.escenarios.nota}
          </p>
        </div>
      )}

      {decision.triggers.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Cuándo actuar
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
            {decision.triggers.map((t, i) => (
              <li key={i}>→ {t}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Un sistema probado y perdedor no puede avisar con la misma letra
          pequeña gris que uno sin probar: es la información más valiosa que
          la app puede darte y va en rojo, no de pasada. */}
      {decision.confidence === 'refutada' ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-snug text-red-700">
          <strong>Estas reglas se probaron contra histórico y no funcionaron:</strong>{' '}
          aplicarlas en el periodo medido habría perdido dinero, o habría ganado
          menos que comprar a ciegas. La operación de arriba es lo que dictan las
          reglas, no una recomendación. Revisa el detalle en{' '}
          <Link to="/senales" className="font-medium underline">
            Señales
          </Link>
          .
        </p>
      ) : (
        <p className="text-[11px] leading-snug text-slate-400">
          {decision.confidence === 'calibrada'
            ? 'Reglas validadas contra el histórico del backtest: en el periodo ' +
              'medido tuvieron esperanza positiva y superaron a comprar a ciegas. ' +
              'Haber funcionado antes no garantiza que funcionen ahora.'
            : 'Reglas mecánicas todavía sin validar contra histórico: ejecuta el ' +
              'backtest de reglas en Señales para saber si han funcionado. Que sean ' +
              'razonables no significa que acierten.'}
        </p>
      )}
    </div>
  )
}

/** Fila de resumen: el estado del día en cifras grandes.
 *
 *  Es lo que los paneles de trading ponen arriba del todo, y funciona porque
 *  responde de un vistazo a "¿tengo que hacer algo hoy?". Lo que no lleva es
 *  un medidor de "riesgo: BAJO" ni una "puntuación de salud 87/100": esos
 *  números quedan muy bien y no significan nada — son un promedio de cosas
 *  que no se pueden promediar, presentado con una precisión que no existe.
 *  Aquí cada cifra es un recuento de algo que se puede ir a contar a mano. */
function SummaryStrip({
  data,
  acciones,
  onPick,
}: {
  data: TodayResponse
  acciones: { comprar: number; vigilar: number; cartera: number; vender: number }
  onPick: (v: View) => void
}) {
  const ideas = data.shortlist?.ideas.length ?? 0
  const cobertura = data.requested ? (data.scored / data.requested) * 100 : 0
  const celdas: {
    label: string
    valor: string
    tono: string
    sub?: string
    vista?: View
  }[] = [
    {
      label: 'Ideas de compra',
      valor: String(ideas),
      tono: 'text-emerald-700',
      sub: `de ${acciones.comprar} que califican`,
      vista: 'ideas',
    },
    {
      label: 'Para vender',
      valor: String(acciones.vender),
      tono: acciones.vender > 0 ? 'text-red-600' : 'text-slate-500',
      sub: acciones.vender > 0 ? 'en tu cartera' : 'nada urgente',
      vista: 'cartera',
    },
    {
      label: 'En vigilancia',
      valor: String(acciones.vigilar),
      tono: 'text-amber-800',
      sub: 'esperando tendencia',
      vista: 'vigilar',
    },
    {
      label: 'En cartera',
      valor: String(acciones.cartera),
      tono: 'text-slate-900',
      sub: 'posiciones abiertas',
      vista: 'cartera',
    },
    {
      label: 'Cobertura',
      valor: `${Math.round(cobertura)} %`,
      tono: data.complete ? 'text-slate-900' : 'text-sky-700',
      sub: `${data.scored} de ${data.requested}`,
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {celdas.map((c) => {
        const Tag = c.vista ? 'button' : 'div'
        return (
          <Tag
            key={c.label}
            {...(c.vista
              ? { onClick: () => onPick(c.vista as View), type: 'button' as const }
              : {})}
            className={`rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left ${
              c.vista ? 'transition-colors hover:border-slate-300' : ''
            }`}
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              {c.label}
            </div>
            <div className={`mt-0.5 text-2xl font-semibold tabular-nums ${c.tono}`}>
              {c.valor}
            </div>
            {c.sub && (
              <div className="text-[10px] leading-tight text-slate-400">{c.sub}</div>
            )}
          </Tag>
        )
      })}
    </div>
  )
}

/** Una idea de la lista corta, con su puesto y su porqué.
 *
 *  Se separa de la fila normal a propósito: una fila de tabla invita a
 *  comparar 98 cosas, y una tarjeta invita a leer una. La pregunta que
 *  responde es "¿por qué esta y no otra?", no "¿quién califica?". */
function IdeaCard({
  signal,
  onOpen,
}: {
  signal: DailySignal & { conviction: Conviction }
  onOpen: () => void
}) {
  const { conviction: c, decision, price } = signal
  const niveles = decision.levels
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
            {c.puesto}
          </span>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold text-slate-900">
                {signal.symbol}
              </span>
              <span className="text-sm text-slate-500">{signal.context.name}</span>
            </div>
            <div className="text-[11px] text-slate-400">
              {signal.context.sector_name}
            </div>
          </div>
        </div>
        {price && (
          <div className="text-right">
            <div className="text-base tabular-nums text-slate-900">
              {fmtNumber(price.last, 2)}
            </div>
            <div
              className={`text-xs tabular-nums ${
                (price.change_pct ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'
              }`}
            >
              {fmtChangePct(price.change_pct)}
            </div>
          </div>
        )}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.resumen}</p>

      {/* Los tres números que hacen falta para ejecutar. Sin ellos esto sería
          otra lista de nombres, que es justo lo que sobra. */}
      {niveles && (
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Comprar entre
            </div>
            <div className="text-sm tabular-nums text-slate-900">
              {fmtNumber(niveles.entrada_desde, 2)}–{fmtNumber(niveles.entrada_hasta, 2)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Vender si baja a
            </div>
            <div className="text-sm tabular-nums text-red-600">
              {fmtNumber(niveles.stop, 2)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Cuánto de tu cartera
            </div>
            <div className="text-sm tabular-nums text-slate-900">
              {niveles.peso_sugerido_pct} %
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={onOpen}
          className="text-xs font-medium text-sky-700 hover:underline"
        >
          Ver el análisis completo →
        </button>
        <span className="text-[11px] text-slate-400">
          Acuerdo entre factores: {Math.round(c.acuerdo * 100)} %
        </span>
      </div>
    </li>
  )
}

/** Las que no hay que comprar. Va junto a las ideas a propósito: saber qué
 *  evitar es la mitad del trabajo y normalmente la que nadie enseña. */
function AvoidList({
  signals,
}: {
  signals: (DailySignal & { conviction: Conviction })[]
}) {
  if (signals.length === 0) return null
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">
        Lo que NO comprar ahora
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Las peor situadas frente a sus comparables de sector. No significa que
        vayan a caer: significa que hay mejores sitios donde poner el dinero.
      </p>
      <ul className="mt-3 space-y-2">
        {signals.map((s) => (
          <li key={s.symbol} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium text-slate-800">{s.symbol}</span>
            <span className="text-slate-500">{s.context.name}</span>
            <span className="text-xs text-slate-400">
              · {s.context.sector_name} · {s.conviction.resumen}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
      <span className="ml-auto pr-[7.5rem] text-right">Puntuación</span>
      <span className="w-20 pr-6 text-right">Acción</span>
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
          <span className="w-20 text-right">
            <ActionChip decision={signal.decision} />
          </span>
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
          <DecisionPlan decision={signal.decision} />

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
  const [view, setView] = useState<View>('ideas')
  const [autoRondas, setAutoRondas] = useState(0)
  const [sector, setSector] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  // Completar la cobertura a mano era pulsar el mismo botón tres o cuatro
  // veces para llegar a lo que la app ya sabe que falta. Ahora encadena las
  // pasadas sola, pero con tope: cada una gasta cuota de APIs gratuitas y
  // agotarla en silencio dejaría el resto del día sin datos.
  const MAX_PASADAS_AUTO = 4

  const load = (which: string, refresh = false, autoPasada = 0) => {
    setBusy(true)
    setError(null)
    api.today(which, refresh).then(
      (d) => {
        setData(d)
        if (!d.complete && autoPasada < MAX_PASADAS_AUTO) {
          setAutoRondas(autoPasada + 1)
          load(which, true, autoPasada + 1)
          return
        }
        setAutoRondas(0)
        setBusy(false)
      },
      (e) => {
        setError(e instanceof Error ? e.message : 'Error')
        setAutoRondas(0)
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
    let base = data.signals
    // Las vistas son acciones, no etiquetas: la pregunta que traes es qué
    // comprar y qué vender, no quién puntúa alto.
    if (view === 'comprar') base = base.filter((s) => s.decision.action === 'comprar')
    else if (view === 'vigilar') base = base.filter((s) => s.decision.action === 'vigilar')
    else if (view === 'cartera') {
      base = base.filter((s) => s.decision.owned)
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

  const acciones = useMemo(() => {
    const s = data?.signals ?? []
    return {
      comprar: s.filter((x) => x.decision.action === 'comprar').length,
      vigilar: s.filter((x) => x.decision.action === 'vigilar').length,
      cartera: s.filter((x) => x.decision.owned).length,
      vender: s.filter((x) => x.decision.action === 'vender').length,
    }
  }, [data])

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
          {/* Antes explicaba de dónde salen los datos, que es lo último que
              hace falta al abrir. Lo que se quiere saber al llegar es cómo
              está el día: cuántas ideas hay y si toca hacer algo. */}
          <p className="mt-0.5 max-w-3xl text-sm leading-snug text-slate-500">
            {data
              ? [
                  `${data.shortlist?.ideas.length ?? 0} ${
                    (data.shortlist?.ideas.length ?? 0) === 1 ? 'idea' : 'ideas'
                  } de compra`,
                  acciones.vender > 0 ? `${acciones.vender} para vender` : null,
                  acciones.cartera > 0 ? `${acciones.cartera} en cartera` : null,
                  `${data.scored} empresas puntuadas`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Empresas puntuadas contra sus comparables de sector. Sin elegir nada.'}
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

      {/* Un mercado sin estados financieros no puede presentar su puntuación
          con la misma cara que uno de cuatro factores. El aviso vivía en la
          descripción del mercado, que dejó de mostrarse al resumir el día en
          la cabecera: aquí es donde tiene que estar. */}
      {data?.solo_momentum && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3">
          <div className="text-xs font-semibold text-amber-900">
            Aquí la puntuación es momentum y nada más
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
            {data.market_name} no tiene estados financieros, así que no hay factor
            de valor ni de calidad: lo único medible es si el precio viene subiendo.
            Una idea sostenida por un solo factor es una apuesta a ese factor, no al
            activo — y comprar algo <em>porque ha subido</em> es exactamente el
            razonamiento que las otras tres familias existen para contrastar. Los
            stops son mucho más anchos (hasta 60 %) porque la volatilidad lo exige,
            y por eso el peso sugerido de cartera sale mucho más pequeño.
          </p>
        </div>
      )}

      {data?.signals && (
        <SummaryStrip data={data} acciones={acciones} onPick={setView} />
      )}

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
                    ['ideas', `Mejores ideas (${data.shortlist?.ideas.length ?? 0})`],
                    ['comprar', `Todas las que califican (${acciones.comprar})`],
                    ['vigilar', `Vigilar (${acciones.vigilar})`],
                    ['cartera', `Mi cartera (${acciones.cartera})`],
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
                  {autoRondas > 0
                    ? `Completando sola (pasada ${autoRondas} de ${MAX_PASADAS_AUTO}). Las APIs gratuitas limitan cuántos fundamentales se descargan de una vez; lo descargado queda en caché 24 h, así que ninguna pasada repite trabajo.`
                    : 'Las APIs gratuitas limitan cuántos fundamentales se descargan de una vez. Lo descargado queda en caché 24 h, así que cada pasada avanza y ninguna repite trabajo.'}
                </p>
              </div>
              <button
                onClick={() => load(market, true)}
                disabled={busy}
                className="shrink-0 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
              >
                {busy ? `Descargando… ${autoRondas || ''}` : 'Seguir completando'}
              </button>
            </div>
          )}

          {view === 'ideas' && data.shortlist ? (
            <div className="space-y-4">
              <p className="text-xs leading-relaxed text-slate-500">
                {data.shortlist.nota}
              </p>
              {data.shortlist.ideas.length > 0 && (
                <ul className="space-y-3">
                  {data.shortlist.ideas.map((s) => (
                    <IdeaCard
                      key={s.symbol}
                      signal={s}
                      onOpen={() => {
                        setView('comprar')
                        setQuery(s.symbol)
                      }}
                    />
                  ))}
                </ul>
              )}
              <AvoidList signals={data.shortlist.evitar} />
            </div>
          ) : (
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
                ) : view === 'comprar' && sector === null ? (
                  // Es la vista de entrada y «cero» es un resultado con
                  // significado, no un hueco: hoy ninguna empresa cumple las
                  // dos condiciones a la vez. Decirlo evita que parezca que la
                  // app no cargó, y evita forzar una compra que no toca.
                  <>
                    <p className="text-slate-600">
                      Hoy no hay ninguna compra en {data.market_name}.
                    </p>
                    <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed">
                      Ninguna empresa cumple a la vez las dos condiciones:
                      puntuar por encima de {data.thresholds.favorable.toFixed(2)}{' '}
                      frente a sus comparables <em>y</em> cotizar sobre su media
                      de 200 sesiones. No actuar también es una decisión.
                    </p>
                    {acciones.vigilar > 0 && (
                      <button
                        onClick={() => setView('vigilar')}
                        className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        Ver las {acciones.vigilar} en vigilancia →
                      </button>
                    )}
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
          )}


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

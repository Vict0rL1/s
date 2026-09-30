import type { Sourced } from '../api/types'
import { fmtDateTime, relativeTime } from '../lib/format'

const FRESHNESS_LABEL: Record<string, string> = {
  live: 'en vivo',
  delayed: 'retrasado ~15 min',
  prev_close: 'cierre anterior',
}

// Principio de la app: toda cifra muestra su fuente y su fecha. Este badge
// acompaña a cada bloque de datos; si viene de caché, lo dice.
export function SourceBadge({
  data,
  freshness,
}: {
  data: Sourced
  freshness?: string
}) {
  // Dato viejo: todas las fuentes fallaron y se sirve la última copia. Se
  // pinta distinto de una caché normal, y sin la etiqueta de frescura del
  // proveedor — antes una cotización rescatada de hace 20 minutos salía
  // rotulada «en vivo», porque ese era el `freshness` con que se descargó.
  if (data.estado === 'viejo') {
    const minutos = Math.round((data.antiguedad_segundos ?? 0) / 60)
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
        title={data.aviso ?? 'Todas las fuentes fallaron: se muestra la última copia guardada.'}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        DATO VIEJO · {data.source} · hace {minutos} min
      </span>
    )
  }

  const parts: string[] = [data.source]
  if (freshness && FRESHNESS_LABEL[freshness]) parts.push(FRESHNESS_LABEL[freshness])
  if (data.cached) parts.push(`caché · ${relativeTime(data.fetched_at)}`)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500"
      title={`Fuente: ${data.source} · dato del ${fmtDateTime(data.as_of)}${
        data.cached ? ` · descargado ${fmtDateTime(data.fetched_at)}` : ''
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          data.cached ? 'bg-amber-400' : freshness === 'live' ? 'bg-emerald-500' : 'bg-sky-400'
        }`}
      />
      {parts.join(' · ')}
    </span>
  )
}

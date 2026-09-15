import { useState } from 'react'

/** Tonos para el monograma, elegidos por el propio tícker.
 *
 *  Determinista a propósito: que AAPL sea siempre del mismo color lo convierte
 *  en algo reconocible de un vistazo en una tabla, que es justo para lo que
 *  sirve un logo. Un color aleatorio en cada render sería solo ruido.
 *
 *  Solo tonos 100/800 por familia: el tema oscuro invierte 50, 100, 800 y 900
 *  pero NO el 200 ni el 700, así que cualquier otro par pinta claro sobre claro
 *  en oscuro. Está documentado en index.css. */
const TONOS = [
  'bg-sky-100 text-sky-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-800',
  'bg-red-100 text-red-800',
  'bg-slate-100 text-slate-800',
]

function tonoDe(symbol: string): string {
  let suma = 0
  for (let i = 0; i < symbol.length; i++) suma = (suma + symbol.charCodeAt(i)) % 997
  return TONOS[suma % TONOS.length]
}

const TAMAÑOS = {
  sm: { caja: 'h-5 w-5', texto: 'text-[9px]', radio: 'rounded' },
  md: { caja: 'h-8 w-8', texto: 'text-[11px]', radio: 'rounded-md' },
  lg: { caja: 'h-12 w-12', texto: 'text-sm', radio: 'rounded-lg' },
}

/**
 * El logo de una empresa, servido por TU backend.
 *
 * El `src` apunta a localhost, nunca a una CDN: el backend lo descarga una vez
 * y lo guarda, así que tu navegador no le cuenta a un tercero qué valores
 * miras. Ver `backend/app/analysis/logos.py`.
 *
 * Cuando no hay logo —que es lo normal fuera de las grandes— se pinta un
 * monograma con las iniciales. Dejar un hueco en blanco haría que una tabla
 * pareciese rota en vez de simplemente no tener la imagen.
 */
export function CompanyLogo({
  symbol,
  size = 'md',
  className = '',
}: {
  symbol: string
  size?: keyof typeof TAMAÑOS
  className?: string
}) {
  const [falló, setFalló] = useState(false)
  const t = TAMAÑOS[size]
  const limpio = (symbol || '').trim().toUpperCase()
  const iniciales = limpio.slice(0, 2) || '?'

  if (falló || !limpio) {
    return (
      <span
        aria-hidden="true"
        title={limpio}
        className={`inline-flex shrink-0 items-center justify-center font-semibold tabular-nums ${t.caja} ${t.texto} ${t.radio} ${tonoDe(limpio)} ${className}`}
      >
        {iniciales}
      </span>
    )
  }

  return (
    <img
      src={`/api/stocks/${encodeURIComponent(limpio)}/logo`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setFalló(true)}
      className={`shrink-0 bg-white object-contain ${t.caja} ${t.radio} ${className}`}
    />
  )
}

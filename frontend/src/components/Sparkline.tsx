/**
 * Gráficos diminutos en SVG, sin librería.
 *
 * Todo lo que se dibuja aquí cabe en unos cientos de píxeles y no necesita ejes,
 * leyendas ni tooltips: la forma ES el mensaje. Meter una librería de charts
 * para esto añadiría cientos de KB al bundle y un montón de configuración para
 * apagar lo que no hace falta.
 */

/** Una serie en miniatura: la forma del año en una celda de tabla.
 *
 *  Sin ejes a propósito. No dice CUÁNTO, dice de dónde viene: un +4 % que llega
 *  desde un +30 % y otro que llega desde un −20 % se leen igual en la columna de
 *  P&L y no son lo mismo. */
export function Sparkline({
  valores,
  width = 72,
  height = 22,
  className = '',
}: {
  valores: number[] | null | undefined
  width?: number
  height?: number
  className?: string
}) {
  if (!valores || valores.length < 2) {
    // Un hueco del mismo tamaño: sin esto la columna baila entre filas con y
    // sin histórico, y la tabla parece rota en vez de incompleta.
    return <span style={{ width, height }} className={`inline-block ${className}`} />
  }

  const min = Math.min(...valores)
  const max = Math.max(...valores)
  const span = max - min || 1
  const dx = width / (valores.length - 1)
  // 1px de margen arriba y abajo: sin él, el trazo se recorta justo en el
  // máximo y el mínimo, que son los dos puntos que importan.
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2)
  const d = valores.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * dx).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

  const sube = valores[valores.length - 1] >= valores[0]
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`inline-block align-middle ${className}`}
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
        className={sube ? 'stroke-emerald-500' : 'stroke-red-500'}
      />
    </svg>
  )
}

/** El recorrido de la cartera dentro de una crisis, con su suelo marcado.
 *
 *  Un −45 % que llega en línea recta y otro que baja un 60 %, rebota y acaba en
 *  −45 % son experiencias distintas, y la segunda es la que hace vender abajo.
 *  El destino lo da el número de al lado; esto da el camino. */
export function CurvaDeCrisis({
  puntos,
  width = 300,
  height = 64,
}: {
  puntos: { fecha: string | null; valor: number }[]
  width?: number
  height?: number
}) {
  if (!puntos || puntos.length < 2) return null

  const valores = puntos.map((p) => p.valor)
  const min = Math.min(...valores, 100)
  const max = Math.max(...valores, 100)
  const span = max - min || 1
  const dx = width / (puntos.length - 1)
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4)
  const linea = puntos
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * dx).toFixed(1)},${y(p.valor).toFixed(1)}`)
    .join(' ')

  const iSuelo = valores.indexOf(Math.min(...valores))
  const suelo = puntos[iSuelo]
  const cae = valores[valores.length - 1] < 100

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-2 block"
      role="img"
      aria-label={`Recorrido: suelo en ${suelo.valor.toFixed(0)} sobre 100`}
    >
      {/* La línea del 100 es la referencia: por debajo, se pierde dinero. */}
      <line
        x1="0"
        x2={width}
        y1={y(100)}
        y2={y(100)}
        strokeWidth="1"
        strokeDasharray="3 3"
        className="stroke-slate-300"
      />
      <path
        d={linea}
        fill="none"
        strokeWidth="1.6"
        strokeLinejoin="round"
        className={cae ? 'stroke-red-500' : 'stroke-emerald-500'}
      />
      {/* El suelo, marcado: es el punto en el que se abandona.
          Anillo y no punto sólido: pintado del mismo color que la línea se
          volvía invisible justo en las crisis que caen —que son en las que
          alguien mira dónde está el fondo—. El relleno usa el tono 50, que el
          tema invierte, así que coincide con el fondo de la tarjeta en claro y
          en oscuro.
          Y si el mínimo ES el primer punto, no hay suelo que señalar: la cartera
          nunca bajó de donde empezó. Marcarlo dejaba medio anillo cortado contra
          el borde, que se lee como un fallo de dibujo. */}
      {iSuelo > 0 && (
        <circle
          cx={iSuelo * dx}
          cy={y(suelo.valor)}
          r="3.2"
          strokeWidth="1.6"
          className={`fill-slate-50 ${cae ? 'stroke-red-500' : 'stroke-emerald-500'}`}
        />
      )}
    </svg>
  )
}

/** La distribución de resultados: dónde está la masa y de qué tamaño son las colas.
 *
 *  Los percentiles describen tres puntos y esconden el resto. Si la media sale
 *  de dos operaciones enormes mientras el grueso pierde, eso solo se ve aquí. */
export function Histograma({
  barras,
  height = 90,
}: {
  barras: { desde: number; hasta: number; n: number }[]
  height?: number
}) {
  if (!barras || barras.length === 0) return null
  const max = Math.max(...barras.map((b) => b.n)) || 1

  return (
    <div>
      <div className="flex items-end gap-px" style={{ height }}>
        {barras.map((b) => (
          <div
            key={b.desde}
            className="group relative flex-1"
            title={`${b.desde} % a ${b.hasta} %: ${b.n} operación(es)`}
          >
            <div
              // Las que pierden en rojo: el eje del 0 % está en la frontera de
              // una barra a propósito, así que el corte es exacto y no visual.
              className={`w-full rounded-t-sm ${
                b.hasta <= 0 ? 'bg-red-400' : 'bg-emerald-400'
              }`}
              style={{ height: `${(b.n / max) * height}px` }}
            />
          </div>
        ))}
      </div>
      {/* El 0 va donde CAE, no en el centro. Con un rango asimétrico (−40 a
          +50) centrarlo lo pone a seis puntos de su sitio, y una etiqueta de eje
          mal colocada desmiente al propio dibujo: el corte de color marca el
          cero exacto y la etiqueta decía otra cosa. */}
      <div className="relative mt-1 h-4 text-[10px] tabular-nums text-slate-400">
        <span className="absolute left-0">{barras[0].desde} %</span>
        {(() => {
          const min = barras[0].desde
          const max = barras[barras.length - 1].hasta
          if (min >= 0 || max <= 0) return null
          const frac = (0 - min) / (max - min)
          return (
            <span
              className="absolute -translate-x-1/2"
              style={{ left: `${frac * 100}%` }}
            >
              0 %
            </span>
          )
        })()}
        <span className="absolute right-0">{barras[barras.length - 1].hasta} %</span>
      </div>
    </div>
  )
}

/** La curva de valor de la cartera contra lo invertido.
 *
 *  Dos líneas y no una: una curva de valor sola no dice si vas ganando. La
 *  distancia entre ellas ES el P&L, y los escalones de la línea de coste son
 *  las veces que compraste o vendiste.
 *
 *  Los cierres se marcan porque hacen BAJAR la línea de valor sin que eso sea
 *  una pérdida: es dinero que salió del modelo. Sin la marca, cada venta se lee
 *  como un desplome. */
export function CurvaDeCartera({
  puntos,
  cierres = [],
  height = 180,
}: {
  puntos: { fecha: string; valor: number; invertido: number; abiertas: number }[]
  cierres?: string[]
  height?: number
}) {
  if (!puntos || puntos.length < 2) return null

  const W = 600
  const todos = puntos.flatMap((p) => [p.valor, p.invertido]).filter((v) => v > 0)
  const min = Math.min(...todos)
  const max = Math.max(...todos)
  const span = max - min || 1
  const dx = W / (puntos.length - 1)
  // 8px de margen: sin él el trazo se corta en el máximo y el mínimo, que son
  // los dos puntos por los que se mira el gráfico.
  const y = (v: number) => height - 8 - ((v - min) / span) * (height - 16)
  const trazo = (campo: 'valor' | 'invertido') =>
    puntos
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * dx).toFixed(1)},${y(p[campo]).toFixed(1)}`)
      .join(' ')

  const ultimo = puntos[puntos.length - 1]
  const gana = ultimo.valor >= ultimo.invertido
  const indiceDe = (f: string) => puntos.findIndex((p) => p.fecha >= f)

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Valor de la cartera frente a lo invertido"
    >
      {/* Las ventas, marcadas: la caída de ese día no es una pérdida. */}
      {cierres.map((f) => {
        const i = indiceDe(f)
        if (i < 0) return null
        return (
          <line
            key={f}
            x1={i * dx}
            x2={i * dx}
            y1="0"
            y2={height}
            strokeWidth="1"
            strokeDasharray="2 3"
            className="stroke-slate-400"
          />
        )
      })}
      {/* Lo invertido va detrás y más fino: es la referencia, no el dato. */}
      <path
        d={trazo('invertido')}
        fill="none"
        strokeWidth="1.2"
        strokeDasharray="4 3"
        className="stroke-slate-400"
      />
      <path
        d={trazo('valor')}
        fill="none"
        strokeWidth="2"
        strokeLinejoin="round"
        className={gana ? 'stroke-emerald-500' : 'stroke-red-500'}
      />
    </svg>
  )
}

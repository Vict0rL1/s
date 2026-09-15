import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type {
  AnalisisResponse,
  Comparacion,
  ConCita,
  CosteEstimado,
  EarningsDisponibles,
  EarningsHistorial,
  Extraccion,
  FilingRef,
  SerieGuidance,
  WatchlistItem,
} from '../api/types'
import { fmtNumber } from '../lib/format'

/** Enlace al documento en la SEC. Cada dato de esta pantalla sale de uno, y sin
 *  el enlace el análisis sería una opinión anónima sobre una empresa. */
function EnlaceSEC({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-sky-700 hover:underline"
    >
      {children} ↗
    </a>
  )
}

/** La cita literal y si se encontró en el documento.
 *
 *  Una cita que no aparece en la fuente no respalda nada, y esconderla dejaría
 *  un resultado más limpio y menos veraz. Por eso se enseña marcada en rojo en
 *  vez de desaparecer. */
function Cita({ item }: { item: ConCita }) {
  const verificada = item.cita_verificada !== false
  return (
    <blockquote
      className={`mt-1 border-l-2 pl-2 text-[11px] leading-relaxed ${
        verificada
          ? 'border-slate-300 text-slate-500'
          : 'border-red-400 bg-red-50 py-1 text-red-800'
      }`}
    >
      «{item.texto_literal}»
      {!verificada && (
        <span className="mt-0.5 block font-medium">
          Esta cita NO se encontró en el documento. El dato que sostiene no está
          respaldado: compruébalo en la fuente antes de usarlo.
        </span>
      )}
    </blockquote>
  )
}

function rango(bajo: number | null, alto: number | null, unidad: string | null) {
  if (bajo === null && alto === null) return 'sin cifra'
  const u = unidad ? ` ${unidad}` : ''
  if (bajo !== null && alto !== null && bajo !== alto)
    return `${fmtNumber(bajo, 2)}–${fmtNumber(alto, 2)}${u}`
  return `${fmtNumber(bajo ?? alto, 2)}${u}`
}

const FLECHA: Record<string, string> = {
  sube: '↑',
  baja: '↓',
  se_mantiene: '=',
  nueva: '＋',
  retirada: '−',
}

const TONO: Record<string, string> = {
  sube: 'text-emerald-700',
  baja: 'text-red-700',
  se_mantiene: 'text-slate-500',
  nueva: 'text-sky-700',
  retirada: 'text-amber-700',
}

function FichaTrimestre({ e }: { e: Extraccion }) {
  const v = e.verificacion
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          {e.form_type} · {e.filed_at}
        </h3>
        <EnlaceSEC url={e.source_url}>Documento en la SEC</EnlaceSEC>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{e.datos.resumen}</p>

      {v && (
        <p
          className={`mt-2 text-[11px] ${
            v.fallidas ? 'font-medium text-red-700' : 'text-slate-400'
          }`}
        >
          Citas verificadas contra el documento: {v.verificadas}/{v.citas}
          {v.fallidas > 0 && ` · ${v.fallidas} no se encontraron`}
        </p>
      )}

      {e.datos.guidance.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Guidance
          </h4>
          <ul className="mt-2 space-y-2">
            {e.datos.guidance.map((g, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-slate-800">{g.metrica}</span>
                <span className="text-slate-400"> · {g.periodo} · </span>
                <span className="tabular-nums text-slate-900">
                  {rango(g.valor_bajo, g.valor_alto, g.unidad)}
                </span>
                <Cita item={g} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-xs text-slate-400">
          Este documento no da ninguna previsión explícita. No todas las empresas
          publican guidance, y no hacerlo no es un dato ausente: es una decisión
          suya.
        </p>
      )}

      {e.datos.riesgos.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Riesgos mencionados
          </h4>
          <ul className="mt-2 space-y-2">
            {e.datos.riesgos.map((r, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-slate-800">{r.tema}</span>
                <span className="text-slate-500"> — {r.descripcion}</span>
                <Cita item={r} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {e.datos.temas.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Temas de la dirección
          </h4>
          <ul className="mt-2 space-y-2">
            {e.datos.temas.map((t, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-slate-800">{t.tema}</span>
                <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                  {t.prominencia}
                </span>
                <Cita item={t} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function FichaComparacion({ c }: { c: Comparacion }) {
  const d = c.datos
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          Qué cambió desde {c.contra.filed_at}
        </h3>
        <EnlaceSEC url={c.contra.url}>Trimestre anterior</EnlaceSEC>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        {d.resumen_del_cambio}
      </p>

      {d.variaciones_calculadas.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Variación del guidance
          </h4>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Calculada por el código a partir de las dos cifras extraídas, no por
            el modelo.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-slate-400">
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 text-left font-medium">Métrica</th>
                  <th className="py-1.5 text-left font-medium">Periodo</th>
                  <th className="py-1.5 text-right font-medium">Antes</th>
                  <th className="py-1.5 text-right font-medium">Ahora</th>
                  <th className="py-1.5 text-right font-medium">Variación</th>
                </tr>
              </thead>
              <tbody>
                {d.variaciones_calculadas.map((v, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 text-slate-800">{v.metrica}</td>
                    <td className="py-1.5 text-xs text-slate-500">{v.periodo}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-500">
                      {rango(v.antes_bajo, v.antes_alto, null)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-900">
                      {rango(v.ahora_bajo, v.ahora_alto, v.unidad)}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        TONO[v.direccion ?? 'se_mantiene']
                      }`}
                    >
                      {v.variacion_pct === null ? (
                        <span
                          className="text-xs text-slate-400"
                          title={v.motivo_sin_variacion}
                        >
                          sin cifra
                        </span>
                      ) : (
                        <>
                          {FLECHA[v.direccion ?? 'se_mantiene']}{' '}
                          {v.variacion_pct > 0 ? '+' : ''}
                          {v.variacion_pct} %
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {d.cambios_de_guidance.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Cambios de previsión descritos
          </h4>
          <ul className="mt-2 space-y-1 text-sm">
            {d.cambios_de_guidance.map((g, i) => (
              <li key={i}>
                <span className={TONO[g.direccion]}>{FLECHA[g.direccion]}</span>{' '}
                <span className="font-medium text-slate-800">{g.metrica}</span>
                <span className="text-slate-400"> · {g.periodo}: </span>
                <span className="text-slate-600">
                  {g.antes ?? '—'} → {g.ahora ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ListaTemas
          titulo="Temas que APARECEN"
          items={d.cambios_de_tema.filter((t) => t.estado === 'aparece')}
          tono="text-emerald-700"
          vacio="Ningún tema nuevo respecto al trimestre anterior."
        />
        <ListaTemas
          titulo="Temas que DESAPARECEN"
          items={d.cambios_de_tema.filter((t) => t.estado === 'desaparece')}
          tono="text-amber-700"
          vacio="No dejó de hablarse de nada que estuviera antes."
        />
      </div>

      {(d.riesgos_nuevos.length > 0 || d.riesgos_que_desaparecen.length > 0) && (
        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          {d.riesgos_nuevos.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Riesgos nuevos
              </h4>
              <ul className="mt-1 text-slate-600">
                {d.riesgos_nuevos.map((r) => (
                  <li key={r}>· {r}</li>
                ))}
              </ul>
            </div>
          )}
          {d.riesgos_que_desaparecen.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Riesgos que ya no se mencionan
              </h4>
              <ul className="mt-1 text-slate-600">
                {d.riesgos_que_desaparecen.map((r) => (
                  <li key={r}>· {r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-slate-400">{c.nota}</p>
    </section>
  )
}

function ListaTemas({
  titulo,
  items,
  tono,
  vacio,
}: {
  titulo: string
  items: Comparacion['datos']['cambios_de_tema']
  tono: string
  vacio: string
}) {
  return (
    <div>
      <h4 className={`text-xs font-semibold uppercase tracking-wide ${tono}`}>
        {titulo}
      </h4>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400">{vacio}</p>
      ) : (
        <ul className="mt-1 space-y-2 text-sm">
          {items.map((t) => (
            <li key={t.tema}>
              <span className="text-slate-800">{t.tema}</span>
              {(t.texto_literal_nuevo ?? t.texto_literal_anterior) && (
                <blockquote className="mt-0.5 border-l-2 border-slate-300 pl-2 text-[11px] text-slate-500">
                  «{t.texto_literal_nuevo ?? t.texto_literal_anterior}»
                </blockquote>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** El guidance de cada métrica trimestre a trimestre.
 *
 *  Es el motivo de que el esquema sea fijo: con campos que cambian cada vez,
 *  esta tabla no se puede construir y lo que queda son informes sueltos. */
function SerieEnElTiempo({ series }: { series: SerieGuidance[] }) {
  const conVarios = series.filter((s) => s.puntos.length > 1)
  if (conVarios.length === 0) return null
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">
        El guidance a lo largo del tiempo
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Cada trimestre tiene exactamente los mismos campos, que es lo que permite
        leerlos como una serie en vez de como análisis sueltos.
      </p>
      <div className="mt-3 space-y-4">
        {conVarios.map((s) => (
          <div key={`${s.metrica}|${s.periodo}`}>
            <div className="text-xs font-medium text-slate-700">
              {s.metrica} <span className="text-slate-400">· {s.periodo}</span>
            </div>
            <ul className="mt-1 space-y-0.5 text-sm">
              {s.puntos.map((p, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <span className="w-24 text-xs tabular-nums text-slate-400">
                    {p.filed_at}
                  </span>
                  <span className="tabular-nums text-slate-900">
                    {rango(p.valor_bajo, p.valor_alto, p.unidad)}
                  </span>
                  {p.cita_verificada === false && (
                    <span className="text-[10px] text-red-700">cita sin verificar</span>
                  )}
                  <EnlaceSEC url={p.source_url}>
                    <span className="text-[10px]">{p.form_type}</span>
                  </EnlaceSEC>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

export function EarningsPage() {
  const [symbol, setSymbol] = useState('')
  const [entrada, setEntrada] = useState('')
  const [seguidas, setSeguidas] = useState<string[]>([])
  const [disponibles, setDisponibles] = useState<EarningsDisponibles | null>(null)
  const [historial, setHistorial] = useState<EarningsHistorial | null>(null)
  const [coste, setCoste] = useState<CosteEstimado | null>(null)
  const [resultado, setResultado] = useState<AnalisisResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // «Para cada empresa seguida»: las de la watchlist salen como atajos.
    api.watchlist().then(
      (w) => setSeguidas(w.items.map((i: WatchlistItem) => i.symbol)),
      () => setSeguidas([]),
    )
  }, [])

  const cargar = useCallback(async (s: string) => {
    setBusy('cargando')
    setError(null)
    setCoste(null)
    setResultado(null)
    try {
      const [d, h] = await Promise.all([
        api.earningsDisponibles(s),
        api.earningsHistorial(s),
      ])
      setDisponibles(d)
      setHistorial(h)
      setSymbol(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
      setDisponibles(null)
      setHistorial(null)
    } finally {
      setBusy(null)
    }
  }, [])

  const verCoste = async (f: FilingRef) => {
    setBusy(`coste-${f.accession_no}`)
    setError(null)
    try {
      setCoste(await api.earningsCoste(symbol, f.accession_no))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(null)
    }
  }

  const analizar = async (accession: string) => {
    setBusy('analizando')
    setError(null)
    try {
      const r = await api.analizarEarnings(symbol, {
        accession_no: accession,
        comparar: true,
      })
      setResultado(r)
      setCoste(null)
      setHistorial(await api.earningsHistorial(symbol))
      setDisponibles(await api.earningsDisponibles(symbol))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(null)
    }
  }

  const comparacion = resultado?.comparacion
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">
        Reportes trimestrales
      </h1>
      <p className="text-xs leading-relaxed text-slate-500">
        Extrae guidance, riesgos y temas del 10-Q/10-K y los compara con el
        trimestre anterior. <strong>Son hechos citados del documento, no
        recomendaciones</strong>: el esquema de salida no tiene ningún campo donde
        quepa una. Cada dato lleva la frase que lo respalda, y esa frase se busca
        en el original.
      </p>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const s = entrada.trim().toUpperCase()
            if (s) cargar(s)
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
            disabled={busy !== null}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === 'cargando' ? 'Cargando…' : 'Ver reportes'}
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
                  cargar(s)
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

      {disponibles && (
        <>
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            {disponibles.limitacion_transcripciones}
          </p>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-700">
              Reportes de {disponibles.symbol}
            </h2>
            <ul className="mt-2 divide-y divide-slate-100">
              {disponibles.filings.map((f) => (
                <li
                  key={f.accession_no}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                >
                  <span className="w-14 font-medium text-slate-800">{f.type}</span>
                  <span className="w-24 tabular-nums text-slate-500">{f.filed_at}</span>
                  <EnlaceSEC url={f.url}>
                    <span className="text-xs">SEC</span>
                  </EnlaceSEC>
                  {f.analizado ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
                      analizado
                    </span>
                  ) : (
                    <button
                      onClick={() => verCoste(f)}
                      disabled={busy !== null}
                      className="text-xs text-sky-700 hover:underline disabled:opacity-50"
                    >
                      {busy === `coste-${f.accession_no}`
                        ? 'Calculando…'
                        : 'Ver qué costaría'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* El LLM no se llama solo: primero el coste, luego el botón. */}
      {coste && (
        <section className="rounded-xl border border-sky-200 bg-sky-50 p-4">
          <h3 className="text-sm font-semibold text-sky-900">
            Antes de gastar: {coste.filing.type} de {coste.filing.filed_at}
          </h3>
          <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-sky-700">
                Tokens de entrada
              </dt>
              <dd className="tabular-nums text-sky-950">
                {coste.coste.tokens_entrada?.toLocaleString('es') ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-sky-700">
                Coste estimado
              </dt>
              <dd className="tabular-nums text-sky-950">
                {coste.coste.usd_estimado !== null
                  ? `${coste.coste.usd_estimado.toFixed(3)} $`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-sky-700">
                Secciones
              </dt>
              <dd className="text-xs text-sky-950">
                {Object.values(coste.secciones)
                  .map((s) => s.etiqueta)
                  .join(', ') || 'ninguna'}
              </dd>
            </div>
          </dl>
          {coste.secciones_ausentes.length > 0 && (
            <p className="mt-2 text-xs text-sky-800">
              No se localizaron: {coste.secciones_ausentes.join(', ')}. Se analiza
              lo que hay, y lo que falta queda dicho.
            </p>
          )}
          <p className="mt-2 text-[11px] text-sky-800">{coste.coste.nota}</p>
          <button
            onClick={() => analizar(coste.filing.accession_no)}
            disabled={busy !== null || !coste.presupuesto.cabe}
            className="mt-3 rounded-lg bg-sky-800 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === 'analizando' ? 'Analizando…' : 'Analizar este reporte'}
          </button>
        </section>
      )}

      {resultado && (
        <>
          <FichaTrimestre e={resultado.extraccion} />
          {comparacion &&
            (comparacion.disponible ? (
              <FichaComparacion c={comparacion} />
            ) : (
              <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                {comparacion.nota}
              </p>
            ))}
          <p className="text-[11px] leading-relaxed text-slate-400">
            {resultado.disclaimer}
          </p>
        </>
      )}

      {historial && historial.trimestres > 0 && (
        <SerieEnElTiempo series={historial.serie_guidance} />
      )}
    </div>
  )
}

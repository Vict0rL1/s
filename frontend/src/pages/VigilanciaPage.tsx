import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type {
  DecisionRegistrada,
  DecisionesResponse,
  DisparadorVigilado,
  MetricasVigilables,
  SinTesisResponse,
  ThesisRecord,
  VigilanciaResponse,
  VigilanciaTesis,
} from '../api/types'
import { fmtNumber, relativeTime } from '../lib/format'

const ACCIONES = ['comprar', 'reforzar', 'mantener', 'reducir', 'vender', 'descartar']

const TONO_ACCION: Record<string, string> = {
  comprar: 'bg-emerald-100 text-emerald-800',
  reforzar: 'bg-emerald-100 text-emerald-800',
  mantener: 'bg-slate-100 text-slate-700',
  reducir: 'bg-amber-100 text-amber-800',
  vender: 'bg-red-100 text-red-800',
  descartar: 'bg-slate-100 text-slate-600',
}

/** Un punto de invalidación con su veredicto.
 *
 *  Tres estados, y el tercero importa tanto como los otros: cruzado, no
 *  cruzado, y NO SE PUDO MEDIR. Pintar el tercero como el segundo convertiría
 *  un fallo de datos en tranquilidad. */
function Disparador({ d }: { d: DisparadorVigilado }) {
  const estado = !d.medible ? 'sin_medir' : d.salta ? 'salta' : 'ok'
  const borde =
    estado === 'salta'
      ? 'border-amber-300 bg-amber-50'
      : estado === 'sin_medir'
        ? 'border-slate-300 bg-slate-50'
        : 'border-slate-200'
  return (
    <li className={`rounded-lg border p-3 ${borde}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-slate-800">{d.descripcion}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            // Tonos 100/800, no 200/900: el tema oscuro invierte 50, 100, 800
            // y 900, pero NO el 200 — así que `bg-amber-200 text-amber-900`
            // pinta texto claro sobre fondo claro y la insignia sale como un
            // rectángulo amarillo sin letras. Ver el comentario en index.css.
            estado === 'salta'
              ? 'bg-amber-100 text-amber-800'
              : estado === 'sin_medir'
                ? 'bg-slate-200 text-slate-600'
                : 'bg-emerald-100 text-emerald-800'
          }`}
        >
          {estado === 'salta'
            ? 'CRUZADO'
            : estado === 'sin_medir'
              ? 'sin medir'
              : 'no cruzado'}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        {d.detalle ?? d.motivo}
      </p>

      {d.serie && d.serie.length > 1 && (
        <p className="mt-1 text-[11px] tabular-nums text-slate-500">
          Últimos ejercicios: {d.serie.map((v) => fmtNumber(v, 3)).join(' → ')}
          {d.tendencia && (
            <span
              className={
                d.tendencia === 'bajando' ? ' text-red-700' : ' text-emerald-700'
              }
            >
              {' '}
              ({d.tendencia})
            </span>
          )}
        </p>
      )}

      {d.coincidencias && d.coincidencias.length > 0 && (
        <ul className="mt-2 space-y-1">
          {d.coincidencias.map((c) => (
            <li key={c.url} className="text-xs">
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="text-sky-700 hover:underline"
              >
                {c.headline} ↗
              </a>
              <span className="ml-1 text-[10px] text-slate-400">
                ({c.palabras.join(', ')})
              </span>
            </li>
          ))}
        </ul>
      )}

      {d.aviso && (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-800">{d.aviso}</p>
      )}
    </li>
  )
}

function TarjetaTesis({
  t,
  onBorrar,
  onAñadir,
}: {
  t: VigilanciaTesis
  onBorrar: (id: number) => void
  onAñadir: (thesisId: number) => void
}) {
  const v = t.vigilancia
  return (
    <section
      className={`rounded-xl border bg-white p-4 ${
        v.saltan ? 'border-amber-300' : 'border-slate-200'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium text-slate-800">{t.symbol}</span>
          <span className="ml-2 text-sm text-slate-600">{t.title}</span>
        </div>
        <button
          onClick={() => onAñadir(t.thesis_id)}
          className="text-xs text-sky-700 hover:underline"
        >
          + punto de invalidación
        </button>
      </div>

      {t.invalidation_criteria && (
        <p className="mt-2 border-l-2 border-slate-200 pl-2 text-xs italic leading-relaxed text-slate-500">
          «{t.invalidation_criteria}»
        </p>
      )}

      {v.total > 0 ? (
        <ul className="mt-3 space-y-2">
          {v.disparadores.map((d) => (
            <div key={d.id} className="relative">
              <Disparador d={d} />
              <button
                onClick={() => onBorrar(d.id)}
                className="absolute right-2 top-9 text-[10px] text-slate-400 hover:text-red-600"
                title="Quitar este punto"
              >
                quitar
              </button>
            </div>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{v.nota}</p>
    </section>
  )
}

function FormularioDisparador({
  thesisId,
  metricas,
  onHecho,
  onCancelar,
}: {
  thesisId: number
  metricas: MetricasVigilables | null
  onHecho: () => void
  onCancelar: () => void
}) {
  const [kind, setKind] = useState<'metrica' | 'crecimiento' | 'noticia'>('metrica')
  const [descripcion, setDescripcion] = useState('')
  const [metrica, setMetrica] = useState('operating_margin')
  const [op, setOp] = useState('lt')
  const [umbral, setUmbral] = useState('18')
  const [palabras, setPalabras] = useState('')
  const [error, setError] = useState<string | null>(null)

  const opciones =
    kind === 'crecimiento' ? (metricas?.crecimientos ?? []) : (metricas?.metricas ?? [])

  const enviar = async () => {
    setError(null)
    try {
      const config =
        kind === 'noticia'
          ? { palabras: palabras.split(',').map((p) => p.trim()).filter(Boolean) }
          : { metrica, op, umbral: Number(umbral) / 100 }
      await api.addTrigger(thesisId, { kind, descripcion, config })
      onHecho()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    }
  }

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
      <h3 className="text-sm font-semibold text-sky-900">
        Qué tendría que pasar para cambiar de opinión
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-sky-800">
        Escríbelo ahora, que es cuando piensas con calma. Dentro de ocho meses,
        con la empresa subiendo, la tesis se habrá convertido en identidad y este
        umbral será lo único que te haga mirar.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {(['metrica', 'crecimiento', 'noticia'] as const).map((k) => (
          <button
            key={k}
            onClick={() => {
              setKind(k)
              setMetrica(k === 'crecimiento' ? 'revenue_cagr' : 'operating_margin')
            }}
            className={`rounded-lg px-3 py-1 text-xs capitalize ${
              kind === k
                ? 'bg-sky-800 text-white'
                : 'border border-sky-300 text-sky-800'
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <input
        value={descripcion}
        onChange={(e) => setDescripcion(e.target.value)}
        placeholder="Por qué esto invalidaría la tesis"
        className="mt-3 w-full rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
      />

      {kind === 'noticia' ? (
        <>
          <input
            value={palabras}
            onChange={(e) => setPalabras(e.target.value)}
            placeholder="palabras separadas por coma: recall, investigación, demanda"
            className="mt-2 w-full rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
            Esto busca palabras en titulares, no entiende. Dará falsos positivos y
            se perderá lo que venga dicho de otra forma. Es una red de arrastre
            gruesa, no vigilancia — los umbrales de métrica sí son sólidos.
          </p>
        </>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={metrica}
            onChange={(e) => setMetrica(e.target.value)}
            className="rounded-lg border border-sky-300 bg-white px-2 py-1.5 text-sm"
          >
            {opciones.map((m) => (
              <option key={m.clave} value={m.clave}>
                {m.etiqueta}
              </option>
            ))}
          </select>
          <select
            value={op}
            onChange={(e) => setOp(e.target.value)}
            className="rounded-lg border border-sky-300 bg-white px-2 py-1.5 text-sm"
          >
            {(metricas?.operadores ?? []).map((o) => (
              <option key={o.clave} value={o.clave}>
                {o.etiqueta}
              </option>
            ))}
          </select>
          <input
            type="number"
            step={0.1}
            value={umbral}
            onChange={(e) => setUmbral(e.target.value)}
            className="w-20 rounded-lg border border-sky-300 bg-white px-2 py-1.5 text-sm tabular-nums"
          />
          <span className="text-sm text-sky-800">%</span>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={enviar}
          disabled={!descripcion.trim()}
          className="rounded-lg bg-sky-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Guardar
        </button>
        <button onClick={onCancelar} className="text-xs text-sky-800 hover:underline">
          Cancelar
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  )
}

function Decision({ d }: { d: DecisionRegistrada }) {
  const ctx = d.contexto
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${
            TONO_ACCION[d.accion] ?? 'bg-slate-100 text-slate-700'
          }`}
        >
          {d.accion}
        </span>
        <span className="font-medium text-slate-800">{d.symbol}</span>
        <span className="text-xs text-slate-400">
          {relativeTime(d.created_at)} · hace {d.days_elapsed} días
        </span>
        {d.price_at_decision !== null && (
          <span className="ml-auto text-xs tabular-nums text-slate-500">
            {fmtNumber(d.price_at_decision, 2)}
            {d.precio_actual !== null && (
              <>
                {' → '}
                {fmtNumber(d.precio_actual, 2)}{' '}
                {d.cambio_pct !== null && (
                  <span
                    className={d.cambio_pct >= 0 ? 'text-emerald-700' : 'text-red-700'}
                  >
                    ({d.cambio_pct > 0 ? '+' : ''}
                    {d.cambio_pct} %)
                  </span>
                )}
              </>
            )}
          </span>
        )}
      </div>

      <p className="mt-2 border-l-2 border-slate-300 pl-2 text-sm leading-relaxed text-slate-700">
        {d.razonamiento}
      </p>

      {/* Lo que la app enseñaba al decidir, no lo que recuerdas que sabías. */}
      {ctx && (ctx.disparadores_saltando.length > 0 || !d.thesis_id) && (
        <div className="mt-2 space-y-1">
          {ctx.disparadores_saltando.map((x, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-amber-800">
              Al decidir ya estaba cruzado: «{x.descripcion}»
            </p>
          ))}
          {!d.thesis_id && (
            <p className="text-[11px] text-slate-400">
              Sin tesis enlazada: esto no se podrá revisar contra nada.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export function VigilanciaPage() {
  const [vig, setVig] = useState<VigilanciaResponse | null>(null)
  const [dec, setDec] = useState<DecisionesResponse | null>(null)
  const [sin, setSin] = useState<SinTesisResponse | null>(null)
  const [tesis, setTesis] = useState<ThesisRecord[]>([])
  const [metricas, setMetricas] = useState<MetricasVigilables | null>(null)
  const [añadiendoA, setAñadiendoA] = useState<number | null>(null)
  const [form, setForm] = useState({ symbol: '', accion: 'comprar', razonamiento: '', thesis_id: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cargar = useCallback(() => {
    api.vigilancia().then(setVig, (e) => setError(e.message))
    api.decisiones().then(setDec, () => setDec(null))
    api.sinTesis().then(setSin, () => setSin(null))
    api.theses().then((d) => setTesis(d.theses), () => setTesis([]))
  }, [])

  useEffect(() => {
    cargar()
    api.metricasVigilables().then(setMetricas, () => setMetricas(null))
  }, [cargar])

  const registrar = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.registrarDecision({
        symbol: form.symbol.trim().toUpperCase(),
        accion: form.accion,
        razonamiento: form.razonamiento,
        thesis_id: form.thesis_id ? Number(form.thesis_id) : null,
      })
      setForm({ symbol: '', accion: 'comprar', razonamiento: '', thesis_id: '' })
      cargar()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">Vigilancia de tesis</h1>
      <p className="text-xs leading-relaxed text-slate-500">
        Escribir «qué me haría cambiar de opinión» es la mitad fácil. La difícil es
        acordarse de mirarlo dentro de ocho meses. Esta pantalla hace esa mitad.
      </p>

      {vig && vig.total_saltan > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900">
          {vig.nota}
        </p>
      )}
      {vig && vig.aviso_sin_disparadores && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {vig.aviso_sin_disparadores}
        </p>
      )}
      {sin && (sin.posiciones_sin_tesis.length > 0 || sin.watchlist_sin_tesis.length > 0) && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          {sin.nota}
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {añadiendoA !== null && (
        <FormularioDisparador
          thesisId={añadiendoA}
          metricas={metricas}
          onHecho={() => {
            setAñadiendoA(null)
            cargar()
          }}
          onCancelar={() => setAñadiendoA(null)}
        />
      )}

      {vig?.tesis.map((t) => (
        <TarjetaTesis
          key={t.thesis_id}
          t={t}
          onAñadir={setAñadiendoA}
          onBorrar={async (id) => {
            await api.deleteTrigger(id)
            cargar()
          }}
        />
      ))}

      {vig && vig.tesis.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          Todavía no hay ninguna tesis escrita. Se crean al añadir una posición o
          algo a la watchlist, o desde la pestaña Tesis.
        </p>
      )}

      {/* --- Registro de decisiones --- */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Registrar una decisión</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Con el razonamiento de ahora. Dentro de seis meses no vas a recordar lo
          que sabías: vas a recordar lo que pasó, y la memoria reescribe el pasado
          para que encaje.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })}
            placeholder="AAPL"
            className="w-28 rounded-lg border border-slate-300 px-3 py-1.5 text-sm uppercase focus:border-sky-500 focus:outline-none"
          />
          <select
            value={form.accion}
            onChange={(e) => setForm({ ...form, accion: e.target.value })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm capitalize"
          >
            {ACCIONES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            value={form.thesis_id}
            onChange={(e) => setForm({ ...form, thesis_id: e.target.value })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">Sin tesis enlazada</option>
            {tesis.map((t) => (
              <option key={t.id} value={t.id}>
                {t.symbol} — {t.title}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={form.razonamiento}
          onChange={(e) => setForm({ ...form, razonamiento: e.target.value })}
          rows={3}
          placeholder="Por qué lo haces. Esto es lo que vas a releer dentro de un año."
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
        />
        <button
          onClick={registrar}
          disabled={busy || form.razonamiento.trim().length < 10 || !form.symbol.trim()}
          className="mt-2 rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Guardando…' : 'Registrar'}
        </button>
      </section>

      {dec && dec.decisiones.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-800">
            Decisiones pasadas, con el razonamiento de entonces
          </h2>
          {dec.coherencia.avisos && dec.coherencia.avisos.length > 0 && (
            <ul className="mt-2 space-y-1">
              {dec.coherencia.avisos.map((a) => (
                <li key={a} className="text-xs leading-relaxed text-amber-800">
                  {a}
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-3 space-y-2">
            {dec.decisiones.map((d) => (
              <Decision key={d.id} d={d} />
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">{dec.nota}</p>
        </section>
      )}
    </div>
  )
}

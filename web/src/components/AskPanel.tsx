// El asistente, en pantalla.
//
// ===========================================================================
// LO QUE ESTA INTERFAZ TIENE QUE DEJAR CLARO
// ===========================================================================
// Un recuadro donde se escribe y sale texto SE LEE como un chatbot, y un chatbot invita
// a creerse lo que dice. Aquí pasa lo contrario: el asistente no redacta ni un número,
// solo elige qué consulta correr, y el número sale de la base.
//
// Esa diferencia no se nota si no se enseña, así que se enseña: cada respuesta lleva
// debajo DE DÓNDE sale, y arriba se dice, sin adornos, que no hay ningún modelo de
// lenguaje detrás. Prometer menos de lo que se hace es la única forma de que lo que se
// dice valga algo.

import { useState } from 'react';

interface Respuesta {
  texto: string;
  filas?: { etiqueta: string; valor: string }[];
  fuente: string;
  intencion: { herramienta: string; argumentos: string[] };
  /** Quién eligió la consulta: el agente, un modelo de lenguaje, o las reglas. */
  via?: 'agente' | 'modelo' | 'determinista';
  nota?: string;
  plan?: string;
  /** Las consultas que se encadenaron, cuando fue más de una. */
  pasos?: { herramienta: string; argumentos: string[]; respuesta: { texto: string; filas?: { etiqueta: string; valor: string }[]; fuente: string } }[];
}

const EJEMPLOS = [
  'Alcaraz',
  'cara a cara Alcaraz contra Sinner',
  'quién gana Sinner contra Djokovic en tierra',
  'top 10 ATP',
  'estado de los datos',
  'qué precisión tiene el modelo',
  'compara a Alcaraz y Sinner',
];

export default function AskPanel() {
  const [q, setQ] = useState('');
  const [hilo, setHilo] = useState<{ pregunta: string; r: Respuesta }[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function preguntar(texto: string) {
    const pregunta = texto.trim();
    if (!pregunta || cargando) return;
    setCargando(true);
    setError(null);
    try {
      // Misma ruta relativa que el resto de la app: el proxy de Vite en desarrollo y
      // el servidor estático en producción la resuelven igual, sin configurar nada.
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pregunta }),
      });
      if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
      const r = (await res.json()) as Respuesta;
      // Lo más nuevo arriba: con el hilo creciendo hacia abajo hay que perseguirlo con
      // el scroll cada vez, y lo que se acaba de preguntar es lo que se quiere leer.
      setHilo((h) => [{ pregunta, r }, ...h].slice(0, 12));
      setQ('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <div className="px-4 py-3">
        <h2 className="text-[16px] font-semibold text-[#e8eaed]">Preguntar a los datos</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-[#7b828d]">
          No hay ningún modelo de lenguaje detrás y por eso puedes fiarte: esto{' '}
          <strong className="text-[#9aa1ac]">no redacta números</strong>, solo decide qué consulta
          hacer, y el resultado sale de la misma base que enseña la app. Cada respuesta dice de
          dónde viene.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void preguntar(q);
        }}
        className="flex gap-2 border-t border-white/[0.07] px-4 py-3"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="cara a cara Alcaraz contra Sinner"
          aria-label="Pregunta"
          className="min-w-0 flex-1 rounded-lg border border-white/[0.09] bg-black/20 px-3 py-2 text-[15px] text-[#e8eaed] outline-none placeholder:text-[#5c636e] focus:border-white/25"
        />
        <button
          type="submit"
          disabled={cargando || !q.trim()}
          className="shrink-0 rounded-lg border border-white/[0.12] px-3 py-2 text-[14px] font-medium text-[#c3c9d1] transition hover:bg-white/[0.05] disabled:opacity-40"
        >
          {cargando ? '…' : 'Preguntar'}
        </button>
      </form>

      {hilo.length === 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {EJEMPLOS.map((e) => (
            <button
              key={e}
              onClick={() => void preguntar(e)}
              className="rounded-full border border-white/[0.09] px-3 py-1 text-[13px] text-[#9aa1ac] transition hover:bg-white/[0.05]"
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="border-t border-white/[0.07] px-4 py-3 text-[14px] text-rose-300">
          No he podido preguntar: {error}
        </p>
      )}

      {hilo.map((x, i) => (
        <article key={i} className="border-t border-white/[0.07] px-4 py-3">
          <p className="text-[13px] text-[#7b828d]">{x.pregunta}</p>
          <p className="mt-1 text-[15px] leading-relaxed text-[#e8eaed]">{x.r.texto}</p>
          {/* Cuando se encadenaron varias consultas, se enseñan TODAS con su
              procedencia. Resumir cuatro consultas en un párrafo escondería que el Elo
              y el cara a cara pueden estar en desacuerdo, que es justo lo interesante. */}
          {x.r.pasos && x.r.pasos.length > 1 && (
            <div className="mt-2 space-y-3">
              {x.r.pasos.map((p, k) => (
                <div key={k} className="border-l-2 border-white/[0.09] pl-3">
                  <p className="text-[14px] text-[#c3c9d1]">{p.respuesta.texto}</p>
                  {p.respuesta.filas && p.respuesta.filas.length > 0 && (
                    <table className="mt-1 w-full border-collapse text-[13px]">
                      <tbody>
                        {p.respuesta.filas.slice(0, 6).map((f, j) => (
                          <tr key={j}>
                            <td className="py-0.5 pr-4 text-[#7b828d]">{f.etiqueta}</td>
                            <td className="py-0.5 text-right text-[#9aa1ac]">{f.valor}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="mt-1 text-[11px] text-[#5c636e]">de: {p.respuesta.fuente}</p>
                </div>
              ))}
            </div>
          )}

          {(!x.r.pasos || x.r.pasos.length <= 1) && x.r.filas && x.r.filas.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse text-[14px]">
                <tbody>
                  {x.r.filas.map((f, j) => (
                    <tr key={j} className="border-t border-white/[0.05] first:border-t-0">
                      <td className="py-1.5 pr-4 text-[#9aa1ac]">{f.etiqueta}</td>
                      <td className="py-1.5 text-right text-[#c3c9d1]">{f.valor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* La procedencia, siempre. Es lo que separa «te lo digo yo» de «míralo tú». */}
          {(!x.r.pasos || x.r.pasos.length <= 1) && (
            <p className="mt-2 text-[12px] text-[#5c636e]">de: {x.r.fuente}</p>
          )}
          {/* Quién decidió la consulta. Se dice porque cambia lo que se puede esperar de
              la siguiente pregunta, y esconderlo sería vender un determinismo que no se
              está usando. */}
          <p className="mt-1 text-[11px] text-[#5c636e]">
            {x.r.via === 'agente'
              ? `agente · ${x.r.plan ?? 'varias consultas'}`
              : x.r.via === 'modelo'
                ? 'la consulta la eligió un modelo de lenguaje; los datos, no'
                : 'consulta elegida por reglas, sin modelo de lenguaje'}
            {x.r.nota ? ` · ${x.r.nota}` : ''}
          </p>
        </article>
      ))}
    </section>
  );
}

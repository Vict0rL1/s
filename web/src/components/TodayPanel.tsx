// Qué se juega HOY, en los cinco deportes a la vez.
//
// ===========================================================================
// POR QUÉ VIVE FUERA DE LAS PESTAÑAS
// ===========================================================================
// La app se organiza por deporte y eso es correcto: los modelos son distintos, los
// mercados son distintos, y mezclarlos en una lista haría ilegibles los cinco. Pero
// «¿qué hay hoy?» es una pregunta que no respeta esa división y es la primera que se
// hace cualquiera al abrir la app. Contestarla costaba cinco clics y acordarse de lo que
// decía cada pestaña.
//
// Va arriba del todo, encima del contenido de la pestaña, y SE PLIEGA. Plegado se
// recuerda entre visitas: quien ya sabe lo que hay hoy no quiere volver a verlo cada vez
// que cambia de deporte, y una cabecera que no se puede quitar acaba siendo un peaje.

import { useEffect, useState } from 'react';

interface Partido {
  deporte: string;
  cuando: string;
  partido: string;
  favorito: string | null;
  probabilidad: number | null;
  precioReal: boolean;
  empezado: boolean;
}

const EMOJI: Record<string, string> = {
  'Fútbol': '⚽',
  'Baloncesto': '🏀',
  'Béisbol': '⚾',
  'NFL': '🏈',
  'Tenis': '🎾',
};

interface Resultado {
  deporte: string;
  cuando: string;
  partido: string;
  favorito: string;
  probabilidad: number;
  ganador: string;
  acerto: boolean;
}

const CLAVE = 'predictor.today.open';
const CLAVE_VISTA = 'predictor.today.view';

export default function TodayPanel() {
  const [datos, setDatos] = useState<{ partidos: Partido[]; nota: string | null } | null>(null);
  const [res, setRes] = useState<{ resultados: Resultado[]; aciertos: number; total: number; tasa: number | null } | null>(null);
  const [vista, setVista] = useState<'hoy' | 'resultados'>(() => {
    try {
      return localStorage.getItem(CLAVE_VISTA) === 'resultados' ? 'resultados' : 'hoy';
    } catch {
      return 'hoy';
    }
  });
  const [abierto, setAbierto] = useState(() => {
    // localStorage puede fallar (ventana privada, datos bloqueados) y un panel que no
    // abre por eso sería un fallo tonto. Ante la duda, abierto.
    try {
      return localStorage.getItem(CLAVE) !== '0';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    let vivo = true;
    fetch('/api/today')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => vivo && setDatos(j))
      .catch(() => vivo && setDatos({ partidos: [], nota: null }));
    // Las dos vistas se piden a la vez y no al cambiar de pestaña: son dos consultas
    // baratas a la base y pedirlas al alternar metería una espera en un gesto que tiene
    // que ser instantáneo.
    fetch('/api/recent-results')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => vivo && setRes(j))
      .catch(() => vivo && setRes({ resultados: [], aciertos: 0, total: 0, tasa: null }));
    return () => {
      vivo = false;
    };
  }, []);

  function cambiarVista(v: 'hoy' | 'resultados') {
    setVista(v);
    try {
      localStorage.setItem(CLAVE_VISTA, v);
    } catch {
      // No poder recordarlo no impide aplicarlo ahora.
    }
  }

  function alternar() {
    const v = !abierto;
    setAbierto(v);
    try {
      localStorage.setItem(CLAVE, v ? '1' : '0');
    } catch {
      // No poder recordar la preferencia no puede impedir aplicarla ahora.
    }
  }

  // Se esconde solo si NO hay nada que enseñar en NINGUNA de las dos vistas. Con cero
  // partidos hoy pero resultados de ayer, el panel sigue teniendo algo que decir — y es
  // justo el día en que más apetece mirar si acertó.
  const hayHoy = (datos?.partidos.length ?? 0) > 0;
  const hayRes = (res?.resultados.length ?? 0) > 0;
  if (!hayHoy && !hayRes) return null;
  const activa: 'hoy' | 'resultados' = vista === 'resultados' && hayRes ? 'resultados' : hayHoy ? 'hoy' : 'resultados';

  const porJugar = datos?.partidos.filter((p) => !p.empezado) ?? [];
  const conPrecio = datos?.partidos.filter((p) => p.precioReal).length ?? 0;

  return (
    <section className="mb-5 overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <button
        onClick={alternar}
        aria-expanded={abierto}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-white/[0.03]"
      >
        <span className="min-w-0">
          <span className="text-[15px] font-semibold text-[#e8eaed]">
            {activa === 'hoy' ? 'Hoy' : 'Cómo le fue al modelo'}
          </span>{' '}
          <span className="text-[13px] text-[#7b828d]">
            {activa === 'hoy' ? (
              <>
                {datos?.partidos.length} partido{datos?.partidos.length === 1 ? '' : 's'} en los
                cinco deportes
                {porJugar.length < (datos?.partidos.length ?? 0) && ` · ${porJugar.length} por jugar`}
                {conPrecio > 0 && ` · ${conPrecio} con cuotas reales`}
              </>
            ) : (
              <>
                {res?.aciertos} de {res?.total} en los últimos 7 días
                {res?.tasa != null && ` · ${(res.tasa * 100).toFixed(0)} %`}
              </>
            )}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-[#7b828d]">{abierto ? '▲' : '▼'}</span>
      </button>

      {abierto && (
        <div className="border-t border-white/[0.07]">
          {/* El interruptor solo aparece si hay las dos cosas. Con una sola, un botón
              que lleva a una lista vacía es una promesa incumplida. */}
          {hayHoy && hayRes && (
            <div className="flex gap-1 border-b border-white/[0.05] px-3 py-2">
              {(['hoy', 'resultados'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => cambiarVista(v)}
                  className={`rounded-full px-3 py-1 text-[13px] transition ${
                    activa === v
                      ? 'bg-white/[0.08] text-[#e8eaed]'
                      : 'text-[#9aa1ac] hover:bg-white/[0.04]'
                  }`}
                >
                  {v === 'hoy' ? 'Qué hay hoy' : '¿Acertó?'}
                </button>
              ))}
            </div>
          )}

          <div className="max-h-[22rem] overflow-y-auto">
            <table className="w-full border-collapse text-[14px]">
              <tbody>
                {activa === 'hoy'
                  ? (datos?.partidos ?? []).map((p, i) => (
                      <tr
                        key={i}
                        className="border-t border-white/[0.05] first:border-t-0"
                        // Un partido empezado no se esconde —sigue siendo lo de hoy— pero
                        // se atenúa: verlo igual que uno por jugar invita a apostarlo.
                        style={p.empezado ? { opacity: 0.45 } : undefined}
                      >
                        <td className="whitespace-nowrap py-2 pl-4 pr-2 text-[#9aa1ac]">
                          {new Date(p.cuando).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="py-2 pr-2"><span title={p.deporte}>{EMOJI[p.deporte] ?? '•'}</span></td>
                        <td className="py-2 pr-3 text-[#c3c9d1]">{p.partido}</td>
                        <td className="whitespace-nowrap py-2 pr-4 text-right">
                          {p.favorito && p.probabilidad != null ? (
                            <>
                              <span className="text-[#e8eaed]">{p.favorito}</span>{' '}
                              <span className="font-semibold text-[#e8eaed]">
                                {(p.probabilidad * 100).toFixed(0)}%
                              </span>
                            </>
                          ) : (
                            <span className="text-[#5c636e]">sin predicción</span>
                          )}
                        </td>
                      </tr>
                    ))
                  : (res?.resultados ?? []).map((r, i) => (
                      <tr key={i} className="border-t border-white/[0.05] first:border-t-0">
                        <td className="whitespace-nowrap py-2 pl-4 pr-2 text-[#9aa1ac]">
                          {new Date(r.cuando).toLocaleDateString('es', { day: 'numeric', month: 'short' })}
                        </td>
                        <td className="py-2 pr-2"><span title={r.deporte}>{EMOJI[r.deporte] ?? '•'}</span></td>
                        <td className="py-2 pr-3 text-[#c3c9d1]">{r.partido}</td>
                        <td className="whitespace-nowrap py-2 pr-2 text-right text-[#9aa1ac]">
                          dijo {r.favorito} {(r.probabilidad * 100).toFixed(0)}%
                        </td>
                        {/* El resultado, y el acierto al lado. Enseñar solo el ✓/✗ sin
                            quién ganó lo volvería incomprobable, que es lo contrario de
                            para lo que existe esta vista. */}
                        <td className="whitespace-nowrap py-2 pr-4 text-right">
                          <span className="text-[#9aa1ac]">ganó {r.ganador}</span>{' '}
                          <span style={{ color: r.acerto ? '#4ea672' : '#c46262' }}>
                            {r.acerto ? '✓' : '✗'}
                          </span>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {activa === 'hoy' && datos?.nota && (
            <p className="border-t border-white/[0.05] px-4 py-2 text-[12px] text-[#7b828d]">
              {datos.nota}
            </p>
          )}
          {activa === 'resultados' && (
            <p className="border-t border-white/[0.05] px-4 py-2 text-[12px] text-[#7b828d]">
              Partido a partido, para que lo puedas comprobar con tu propia memoria. El
              porcentaje que sirve para juzgar al modelo es el del historial de cada
              pestaña, medido sobre miles de partidos y no sobre estos {res?.total}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

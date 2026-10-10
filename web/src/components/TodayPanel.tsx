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
import RecentResults, { DeporteIcono, lineaResumen, useHistorial } from './RecentResults';
import { deporteInicial, panelAbierto } from '../lib/hoy';
import { localeDe, useI18n } from '../i18n';
import { pct as pctF } from '../lib/formato';

interface Partido {
  deporte: string;
  cuando: string;
  partido: string;
  favorito: string | null;
  probabilidad: number | null;
  precioReal: boolean;
  empezado: boolean;
}

const CLAVE = 'predictor.today.open';
const CLAVE_VISTA = 'predictor.today.view';

const CLAVE_ALTO = 'predictor.hoy.alto';

/**
 * El alto con el que se pintó la última vez. Sin recuerdo (primera visita), el habitual: plegado,
 * la cabecera (46 px); desplegado, cabecera, pestañas y la lista a su alto máximo de 22 rem, que es
 * lo que ocupa en cuanto hay más de ocho partidos.
 */
function altoRecordado(abierto: boolean): number {
  const porDefecto = abierto ? 46 + 41 + 352 : 46;
  try {
    const n = Number(localStorage.getItem(CLAVE_ALTO));
    return Number.isFinite(n) && n > 0 && n < 1200 ? n : porDefecto;
  } catch {
    return porDefecto;
  }
}

/** Guarda el alto real (también al plegar y desplegar), para reservarlo la próxima vez. */
function medir(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  const guardar = () => {
    try {
      localStorage.setItem(CLAVE_ALTO, String(Math.round(el.getBoundingClientRect().height)));
    } catch {
      // Sin almacenamiento, la próxima vez se reserva solo la cabecera.
    }
  };
  guardar();
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(guardar);
  ro.observe(el);
  return () => ro.disconnect();
}

export default function TodayPanel({ pestana = null }: { pestana?: string | null }) {
  const [datos, setDatos] = useState<{ partidos: Partido[]; nota: string | null } | null>(null);
  // Los resultados recientes (registro en vivo + reconstruidos), con su ventana.
  const historial = useHistorial();
  const { t, idioma } = useI18n();
  const [vista, setVista] = useState<'hoy' | 'resultados'>(() => {
    try {
      return localStorage.getItem(CLAVE_VISTA) === 'resultados' ? 'resultados' : 'hoy';
    } catch {
      return 'hoy';
    }
  });
  // La preferencia guardada ('1' / '0'), o null si nunca se tocó: entonces decide la vista
  // (panelAbierto). localStorage puede fallar (ventana privada, datos bloqueados): sin él,
  // como si no hubiera preferencia.
  const [guardado, setGuardado] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CLAVE);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let vivo = true;
    fetch('/api/today')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => vivo && setDatos(j))
      .catch(() => vivo && setDatos({ partidos: [], nota: null }));
    // Los resultados se piden a la vez (useHistorial), no al cambiar de vista: alternar
    // tiene que ser instantáneo.
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

  function alternar(abiertoAhora: boolean) {
    const v = !abiertoAhora;
    setGuardado(v ? '1' : '0');
    try {
      localStorage.setItem(CLAVE, v ? '1' : '0');
    } catch {
      // No poder recordar la preferencia no puede impedir aplicarla ahora.
    }
  }

  // Se esconde solo si NO hay nada que enseñar en NINGUNA de las dos vistas. Los
  // resultados siempre tienen algo que decir una vez cargados: o los partidos, o por qué
  // faltan (el archivo sin actualizar). Esconderlos con la lista vacía era justo lo que
  // hacía parecer que el historial de la semana no existía.
  const hayHoy = (datos?.partidos.length ?? 0) > 0;
  const hayRes = historial.h != null;
  // Mientras carga, el hueco que ocupó la última vez (Fase 7.8): aparecer de la nada empujaba
  // la página entera hacia abajo, que es el desplazamiento que más mide Lighthouse.
  if (datos == null) return <div aria-hidden className="mb-5" style={{ height: altoRecordado(panelAbierto(guardado, vista)) }} />;
  if (!hayHoy && !hayRes) return null;
  const activa: 'hoy' | 'resultados' = vista === 'resultados' && hayRes ? 'resultados' : hayHoy ? 'hoy' : 'resultados';
  const abierto = panelAbierto(guardado, activa);

  const porJugar = datos?.partidos.filter((p) => !p.empezado) ?? [];
  const conPrecio = datos?.partidos.filter((p) => p.precioReal).length ?? 0;

  return (
    <section ref={medir} className="mb-5 overflow-hidden rounded-xl border border-(--line) bg-(--tint)">
      <button
        onClick={() => alternar(abierto)}
        aria-expanded={abierto}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-(--tint)"
      >
        <span className="min-w-0">
          <span className="text-[15px] font-semibold text-(--ink-strong)">
            {activa === 'hoy' ? t('hoy.titulo') : t('hoy.comoFue')}
          </span>{' '}
          <span className="text-[13px] text-(--ink-muted)">
            {activa === 'hoy' ? (
              <>
                {t(datos?.partidos.length === 1 ? 'hoy.partidos1' : 'hoy.partidosN', { n: datos?.partidos.length ?? 0 })}
                {porJugar.length < (datos?.partidos.length ?? 0) && t('hoy.porJugar', { n: porJugar.length })}
                {conPrecio > 0 && t('hoy.conCuotas', { n: conPrecio })}
              </>
            ) : (
              // Sin «esperaba», un 53 % no dice nada: puede ser justo lo que tocaba.
              <>{lineaResumen(historial.h, t)}</>
            )}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-(--ink-muted)">{abierto ? '▲' : '▼'}</span>
      </button>

      {abierto && (
        <div className="border-t border-(--line)">
          {/* El interruptor solo aparece si hay las dos cosas. Con una sola, un botón
              que lleva a una lista vacía es una promesa incumplida. */}
          {hayHoy && hayRes && (
            <div className="flex gap-1 border-b border-(--line) px-3 py-2">
              {(['hoy', 'resultados'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => cambiarVista(v)}
                  className={`rounded-full px-3 py-1 text-[13px] transition ${
                    activa === v
                      ? 'bg-(--raised-2) text-(--ink-strong)'
                      : 'text-(--ink-soft) hover:bg-(--raised)'
                  }`}
                >
                  {v === 'hoy' ? t('hoy.queHay') : t('hoy.acerto')}
                </button>
              ))}
            </div>
          )}

          {activa === 'resultados' ? (
            <RecentResults estado={historial} deporteInicial={deporteInicial(pestana)} />
          ) : (
            <>
              <div className="max-h-[22rem] overflow-y-auto">
                <table className="w-full border-collapse text-[14px]">
                  <tbody>
                    {(datos?.partidos ?? []).map((p, i) => (
                      <tr
                        key={i}
                        className="border-t border-(--line) first:border-t-0"
                        // Un partido empezado no se esconde —sigue siendo lo de hoy— pero
                        // se atenúa: verlo igual que uno por jugar invita a apostarlo. Con la
                        // tinta tenue y no con `opacity` (G6: al 45 % quedaba en 2,1:1).
                        data-empezado={p.empezado || undefined}
                      >
                        <td className={`whitespace-nowrap py-2 pl-4 pr-2 ${p.empezado ? 'text-(--ink-faint)' : 'text-(--ink-soft)'}`}>
                          {new Date(p.cuando).toLocaleTimeString(localeDe(idioma), { hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="py-2 pr-2"><span title={p.deporte} className="inline-flex"><DeporteIcono nombre={p.deporte} size={24} tile /></span></td>
                        <td className={`py-2 pr-3 ${p.empezado ? 'text-(--ink-faint)' : 'text-(--ink-body)'}`}>{p.partido}</td>
                        {/* El favorito puede partirse en dos líneas y el porcentaje no: a 390 px
                            la fila entera sin cortes era más ancha que la caja (G8). */}
                        <td className="py-2 pr-4 text-right">
                          {p.favorito && p.probabilidad != null ? (
                            <>
                              <span className={p.empezado ? 'text-(--ink-muted)' : 'text-(--ink-strong)'}>{p.favorito}</span>{' '}
                              <span className={`whitespace-nowrap font-semibold ${p.empezado ? 'text-(--ink-muted)' : 'text-(--ink-strong)'}`}>
                                {pctF(p.probabilidad, 0)}
                              </span>
                            </>
                          ) : (
                            <span className="text-(--ink-faint)">{t('hoy.sinPrediccion')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {datos?.nota && (
                <p className="border-t border-(--line) px-4 py-2 text-[12px] text-(--ink-muted)">
                  {datos.nota}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

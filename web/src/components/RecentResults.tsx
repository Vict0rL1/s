// «¿Acertó?»: los partidos de los últimos días, qué dijo el modelo y qué pasó.
//
// Dos orígenes, siempre distinguibles: lo que la app registró ANTES del partido («en
// vivo», la prueba de verdad) y lo reconstruido con el modelo del backtest para todos los
// demás partidos jugados del archivo, con solo los datos anteriores a cada uno. Sin lo
// segundo la vista enseñaba 19 partidos sueltos; con lo segundo sin marcar, mezclaría
// una prueba con otra. Por eso: los dos, cada uno con su etiqueta y su recuento.
//
// Y todos los días de la ventana, también los vacíos. Un día sin partidos casi nunca es
// «no hubo partidos»: es un archivo de resultados sin actualizar, y abajo se dice cuál y
// con qué comando se arregla.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ID_DE_NOMBRE } from '../lib/hoy';
import { STATUS } from '../lib/theme';
import { DeporteIcono, Verdict } from './icons';

export { DeporteIcono };
import { TeamCrest } from './ui';
import { conNodos, localeDe, useI18n, type Clave, type Traducir } from '../i18n';
import { num as numF } from '../lib/formato';

/** El servidor manda el nombre del deporte en español: se pasa al catálogo si se conoce. */

const deporteMostrado = (t: Traducir, nombre: string) => (ID_DE_NOMBRE[nombre] ? t(`deporte.${ID_DE_NOMBRE[nombre]}` as Clave) : nombre);

type Origen = 'en vivo' | 'reconstruida';

interface Resultado {
  deporte: string;
  liga: string | null;
  dia: string;
  cuando: string | null;
  partido: string;
  casa: string;
  fuera: string;
  casaId: string | null;
  fueraId: string | null;
  favorito: string;
  probabilidad: number;
  ganador: string;
  acerto: boolean;
  origen: Origen;
}

export interface Resumen {
  total: number;
  aciertos: number;
  tasa: number | null;
  esperado: number | null;
  tasaEsperada: number | null;
  rangoNormal: [number, number] | null;
}

interface Archivo {
  deporte: string;
  hasta: string | null;
  sinResultado: number;
  comando: string;
  reconstruye: boolean;
}

export interface Historial {
  ventanas: number[];
  dias: number;
  resultados: Resultado[];
  resumen: Resumen;
  porOrigen: Record<Origen, Resumen>;
  porDeporte: Record<string, Resumen>;
  porDia: (Resumen & { dia: string })[];
  archivo: Archivo[];
  sinHistoria: number;
}


const CLAVE_VENTANA = 'predictor.results.window';

/** 'YYYY-MM-DD' → fecha LOCAL (new Date('2026-10-05') sería medianoche UTC). */
const fechaDe = (dia: string) => new Date(Number(dia.slice(0, 4)), Number(dia.slice(5, 7)) - 1, Number(dia.slice(8, 10)));
const pctTxt = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)} %`);

function veredicto(t: Traducir, r: Resumen): { texto: string; color: string } | null {
  if (!r.rangoNormal || r.esperado == null) return null;
  const [lo, hi] = r.rangoNormal;
  if (r.aciertos < lo) return { texto: t('acerto.debajo'), color: STATUS.critical };
  if (r.aciertos > hi) return { texto: t('acerto.encima'), color: STATUS.good };
  return { texto: t('acerto.dentro'), color: 'var(--ink-soft)' };
}

/** Lo que va en la cabecera plegable del panel. */
export function lineaResumen(h: Historial | null, t: Traducir): string {
  if (!h) return t('acerto.cargando');
  const r = h.resumen;
  if (r.total === 0) return t('acerto.sinResultados', { dias: h.dias });
  return t('acerto.linea', { a: r.aciertos, n: r.total, dias: h.dias, pct: pctTxt(r.tasa) }) + (r.tasaEsperada != null ? t('acerto.esperaba', { pct: pctTxt(r.tasaEsperada) }) : '');
}

export function useHistorial(): { h: Historial | null; cargando: boolean; error: boolean; dias: number; setDias: (d: number) => void } {
  const [dias, setDiasState] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(CLAVE_VENTANA));
      return [7, 14, 30].includes(v) ? v : 7;
    } catch {
      return 7;
    }
  });
  const [h, setH] = useState<Historial | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let vivo = true;
    setCargando(true);
    fetch(`/api/recent-results?dias=${dias}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: Historial) => {
        if (!vivo) return;
        setH(j);
        setError(false);
      })
      .catch(() => vivo && setError(true))
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
  }, [dias]);
  const setDias = (d: number) => {
    setDiasState(d);
    try {
      localStorage.setItem(CLAVE_VENTANA, String(d));
    } catch {
      // No poder recordarlo no impide aplicarlo ahora.
    }
  };
  return { h, cargando, error, dias, setDias };
}

function Chip({ activo, onClick, children, title }: { activo: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={activo}
      className={`whitespace-nowrap rounded-full px-3 py-1 text-[13px] ring-1 transition ${
        activo ? 'bg-(--raised-2) text-(--ink-strong) ring-(--line-strong)' : 'text-(--ink-soft) ring-(--line) hover:bg-(--raised)'
      }`}
    >
      {children}
    </button>
  );
}

/** Barra apilada por día: verde los aciertos, rojo los fallos; altura según partidos. */
function FranjaDias({ porDia, max, diaSel, onDia }: { porDia: Historial['porDia']; max: number; diaSel: string | null; onDia: (d: string | null) => void }) {
  const dias = [...porDia].reverse(); // del más antiguo al de hoy, de izquierda a derecha
  const { t, idioma } = useI18n();
  const loc = localeDe(idioma);
  // Hoy está a la derecha. Si no cabe todo (30 días en un móvil), se arranca enseñando
  // el final: lo reciente es lo que se viene a mirar.
  const caja = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (caja.current) caja.current.scrollLeft = caja.current.scrollWidth;
  }, [porDia.length]);
  return (
    <div ref={caja} className="overflow-x-auto px-3 pb-1" tabIndex={0}>
      <div className="flex items-end gap-1" role="list" aria-label={t('acerto.porDia')}>
        {dias.map((d) => {
          const f = fechaDe(d.dia);
          const alto = d.total === 0 ? 0 : Math.max(8, Math.round((d.total / Math.max(max, 1)) * 56));
          const okAlto = d.total === 0 ? 0 : Math.round((d.aciertos / d.total) * alto);
          const sel = diaSel === d.dia;
          return (
            // El elemento de la lista es el contenedor y el botón va dentro: un botón no puede ser
            // un «listitem» (axe, Fase 7.9).
            <div key={d.dia} role="listitem" className="flex min-w-[1.75rem] flex-1">
            <button
              onClick={() => onDia(sel ? null : d.dia)}
              disabled={d.total === 0}
              title={d.total === 0 ? t('acerto.diaSin', { dia: f.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'short' }) }) : t('acerto.diaAcertados', { a: d.aciertos, n: d.total })}
              className={`flex w-full flex-col items-center gap-1 rounded-md py-1 transition ${sel ? 'bg-(--raised-2)' : d.total ? 'hover:bg-(--raised)' : 'cursor-default'}`}
            >
              <span className="whitespace-nowrap text-[10.5px] tabular-nums text-(--ink-soft)">{d.total ? `${d.aciertos}/${d.total}` : '—'}</span>
              <span className="flex h-14 w-3.5 flex-col justify-end overflow-hidden rounded-sm bg-(--raised)">
                <span style={{ height: alto - okAlto, background: STATUS.critical, opacity: 0.75 }} />
                <span style={{ height: okAlto, background: STATUS.good }} />
              </span>
              <span className="text-[11px] leading-tight text-(--ink-muted)">
                {f.toLocaleDateString(loc, { weekday: 'narrow' })}
                <br />
                <span className={sel ? 'text-(--ink-strong)' : ''}>{f.getDate()}</span>
              </span>
            </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Fila({ r }: { r: Resultado }) {
  // En la NFL y la NHL se escribe «visitante @ local»; en los demás, el local primero.
  const lados = [
    { nombre: r.casa, id: r.casaId },
    { nombre: r.fuera, id: r.fueraId },
  ];
  if (r.deporte === 'NFL' || r.deporte === 'NHL') lados.reverse();
  const empate = r.ganador === 'Empate';
  const { t, idioma } = useI18n();
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span title={deporteMostrado(t, r.deporte)} className="mt-0.5">
        <DeporteIcono nombre={r.deporte} size={30} tile />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1">
          {lados.map((l, i) => {
            const gano = l.nombre === r.ganador;
            return (
              <div key={i} className="flex min-w-0 items-center gap-2">
                <TeamCrest league={r.liga ?? ''} name={l.nombre} code={l.id} size={24} />
                <span className={`min-w-0 break-words text-[14px] leading-snug ${gano ? 'font-medium text-(--ink-strong)' : 'text-(--ink-soft)'}`}>{l.nombre}</span>
                {(r.deporte === 'NFL' || r.deporte === 'NHL') && i === 0 && <span className="-ml-1 text-[12px] text-(--ink-faint)">@</span>}
                {gano && <span className="shrink-0 rounded bg-(--raised) px-1.5 py-px text-[10.5px] uppercase tracking-wide text-(--ink-soft)">{t('acerto.gano')}</span>}
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-(--ink-soft)">
          <span>
            {conNodos(t('acerto.dijo'), {
              favorito: <span className="text-(--ink-body)">{r.favorito}</span>,
              pct: <span className="font-semibold tabular-nums text-(--ink-strong)">{Math.round(r.probabilidad * 100)} %</span>,
            })}
          </span>
          {empate && <span className="text-(--ink-body)">{t('acerto.empate')}</span>}
          {r.origen === 'reconstruida' && (
            <span
              className="rounded px-1.5 py-px text-[11px] text-(--ink-soft) ring-1 ring-(--line)"
              title={t('acerto.reconstruidaNota')}
            >
              {t('acerto.reconstruida')}
            </span>
          )}
          {r.origen === 'en vivo' && (
            <span className="rounded px-1.5 py-px text-[11px]" style={{ color: STATUS.good, background: 'rgba(25,158,112,0.1)' }}>
              {t('acerto.enVivo')}
              {r.cuando ? ` · ${new Date(r.cuando).toLocaleTimeString(localeDe(idioma), { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
          )}
        </div>
      </div>
      {/* El veredicto lleva palabra y símbolo, nunca solo color. */}
      <span className="mt-0.5 shrink-0">
        <Verdict ok={r.acerto} />
      </span>
    </li>
  );
}

export default function RecentResults({ estado, deporteInicial = null }: { estado: ReturnType<typeof useHistorial>; deporteInicial?: string | null }) {
  const { h, cargando, error, dias, setDias } = estado;
  // Nace filtrado al deporte de la pestaña (D3): en la del fútbol, lo del fútbol. «Todos», a un clic.
  const [deporte, setDeporte] = useState<string | null>(deporteInicial);
  useEffect(() => setDeporte(deporteInicial), [deporteInicial]);
  const [origen, setOrigen] = useState<Origen | null>(null);
  const [diaSel, setDiaSel] = useState<string | null>(null);
  const { t, idioma } = useI18n();
  const loc = localeDe(idioma);

  // Cambiar de ventana deja sin sentido un día elegido fuera de ella.
  useEffect(() => setDiaSel(null), [dias]);

  const filtrados = useMemo(
    () =>
      (h?.resultados ?? []).filter(
        (r) => (!deporte || r.deporte === deporte) && (!origen || r.origen === origen) && (!diaSel || r.dia === diaSel),
      ),
    [h, deporte, origen, diaSel],
  );
  const porDia = useMemo(() => {
    const m = new Map<string, Resultado[]>();
    for (const r of filtrados) m.set(r.dia, [...(m.get(r.dia) ?? []), r]);
    return [...m.entries()];
  }, [filtrados]);

  if (error && !h) return <p className="px-4 py-3 text-[13px] text-(--ink-soft)">{t('acerto.errorLeer')}</p>;
  if (!h) return <p className="px-4 py-3 text-[13px] text-(--ink-soft)">{t('acerto.calculando', { dias })}</p>;

  const r = h.resumen;
  const v = veredicto(t, r);
  const maxDia = Math.max(...h.porDia.map((d) => d.total), 1);
  // Primero lo seguro (partidos que la app vio jugarse y siguen sin resultado), después
  // los archivos que llevan días sin datos nuevos (que fuera de temporada es normal).
  const avisos = h.archivo
    .filter((a) => a.sinResultado > 0 || !a.hasta || Date.now() - fechaDe(a.hasta).getTime() > 2 * 86_400_000)
    .sort((a, b) => b.sinResultado - a.sinResultado);

  return (
    <div className={cargando ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      {/* Ventana */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
        <span className="mr-1 text-[12px] uppercase tracking-wide text-(--ink-muted)">{t('acerto.periodo')}</span>
        {h.ventanas.map((d) => (
          <Chip key={d} activo={dias === d} onClick={() => setDias(d)}>
            {t('acerto.dias', { n: d })}
          </Chip>
        ))}
        {cargando && <span className="text-[12px] text-(--ink-muted)">{t('acerto.actualizando')}</span>}
      </div>

      {/* Resumen */}
      <div className="mx-4 mt-3 grid grid-cols-1 gap-3 rounded-lg bg-(--tint) p-3 ring-1 ring-(--line) sm:grid-cols-[auto_1fr]">
        <div className="flex items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0 sm:pr-4">
          <span className="text-[28px] font-semibold leading-none tabular-nums text-(--ink-strong)">{pctTxt(r.tasa)}</span>
          <span className="text-[13px] text-(--ink-soft)">
            {t('acerto.acertados', { a: r.aciertos, n: r.total })}
          </span>
        </div>
        <div className="text-[13px] leading-relaxed text-(--ink-soft)">
          {r.total === 0 ? (
            <>{t('acerto.ninguno', { dias: h.dias })}</>
          ) : (
            conNodos(
              t('acerto.explica', {
                unos: numF((r.esperado ?? 0), 1),
                lo: r.rangoNormal?.[0] ?? '—',
                hi: r.rangoNormal?.[1] ?? '—',
                n: r.total,
                a: r.aciertos,
              }),
              {
                esperado: <span className="text-(--ink-strong)">{pctTxt(r.tasaEsperada)}</span>,
                veredicto: <span style={{ color: v?.color }}>{v?.texto}</span>,
              },
            )
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip activo={origen === null} onClick={() => setOrigen(null)}>
              {t('acerto.todos', { n: r.total })}
            </Chip>
            <Chip
              activo={origen === 'en vivo'}
              onClick={() => setOrigen(origen === 'en vivo' ? null : 'en vivo')}
              title={t('acerto.enVivoNota')}
            >
              {t('acerto.enVivoChip', { a: h.porOrigen['en vivo'].aciertos, n: h.porOrigen['en vivo'].total })}
            </Chip>
            <Chip
              activo={origen === 'reconstruida'}
              onClick={() => setOrigen(origen === 'reconstruida' ? null : 'reconstruida')}
              title={t('acerto.reconstruidosNota')}
            >
              {t('acerto.reconstruidosChip', { a: h.porOrigen.reconstruida.aciertos, n: h.porOrigen.reconstruida.total })}
            </Chip>
          </div>
        </div>
      </div>

      {/* Por día */}
      <div className="mt-3">
        <FranjaDias porDia={h.porDia} max={maxDia} diaSel={diaSel} onDia={setDiaSel} />
      </div>

      {/* Por deporte */}
      {Object.keys(h.porDeporte).length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto px-4 pb-1 pt-2">
          <Chip activo={deporte === null} onClick={() => setDeporte(null)}>
            {t('acerto.todosDeportes')}
          </Chip>
          {Object.entries(h.porDeporte).map(([d, s]) => (
            <Chip key={d} activo={deporte === d} onClick={() => setDeporte(deporte === d ? null : d)}>
              <DeporteIcono nombre={d} size={15} /> {s.aciertos}/{s.total} · {pctTxt(s.tasa)}
            </Chip>
          ))}
        </div>
      )}

      {/* La lista, por día */}
      <div className="mt-2 max-h-[26rem] overflow-y-auto border-t border-(--line)">
        {porDia.length === 0 && (
          <p className="px-4 py-4 text-[13px] text-(--ink-muted)">{h.resultados.length ? t('acerto.ningunoFiltro') : t('acerto.sinResueltos')}</p>
        )}
        {porDia.map(([dia, xs]) => {
          const ok = xs.filter((x) => x.acerto).length;
          return (
            <section key={dia} className="seccion-dia">
              <h4 className="sticky top-0 z-10 flex items-baseline justify-between border-b border-(--line) bg-(--surface-card)/95 px-4 py-1.5 text-[12.5px] backdrop-blur">
                <span className="font-medium capitalize text-(--ink-body)">
                  {fechaDe(dia).toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'short' })}
                </span>
                <span className="tabular-nums text-(--ink-soft)">
                  {t('acerto.deN', { a: ok, n: xs.length })}
                </span>
              </h4>
              <ul className="divide-y divide-(--line)">
                {xs.map((x, i) => (
                  <Fila key={`${x.partido}|${i}`} r={x} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {/* Por qué faltan días */}
      {avisos.length > 0 && (
        <div className="border-t border-(--line) px-4 py-3">
          <p className="mb-1 text-[12px] uppercase tracking-wide text-(--ink-muted)">{t('acerto.faltan')}</p>
          <p className="mb-2 text-[12.5px] text-(--ink-soft)">
            {conNodos(t('acerto.diaVacio'), { comando: <code className="rounded bg-(--raised-2) px-1.5 py-px text-[12px] text-(--ink-strong)">npm run update-results</code> })}
          </p>
          <ul className="space-y-1.5 text-[12.5px] text-(--ink-soft)">
            {avisos.map((a) => (
              <li key={a.deporte} className="flex flex-wrap items-baseline gap-x-2">
                <span>
                  <DeporteIcono nombre={a.deporte} size={15} /> {deporteMostrado(t, a.deporte)}:{' '}
                  {a.hasta ? t('acerto.guardadosHasta', { fecha: fechaDe(a.hasta).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' }) }) : t('acerto.sinGuardados')}
                  {a.sinResultado > 0 && <span style={{ color: STATUS.warning }}>{t('acerto.esperan', { n: a.sinResultado })}</span>}
                  {!a.reconstruye && t('acerto.noReconstruye')}
                </span>
                <code className="rounded bg-(--raised) px-1.5 py-px text-[12px] text-(--ink-body)">{a.comando}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="border-t border-(--line) px-4 py-2.5 text-[12px] leading-relaxed text-(--ink-muted)">
        {conNodos(t('acerto.pie', { sinHistoria: h.sinHistoria > 0 ? t('acerto.sinHistoria', { n: h.sinHistoria }) : '' }), {
          enVivo: <strong className="font-medium text-(--ink-soft)">{t('acerto.enVivoMayus')}</strong>,
          reconstruidos: <strong className="font-medium text-(--ink-soft)">{t('acerto.reconstruidos')}</strong>,
        })}
      </p>
    </div>
  );
}

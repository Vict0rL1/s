// ⭐ Destacados: los partidos que vienen, de todos los deportes, ordenados por cuánto
// fiarse de la predicción y por la probabilidad del favorito. Para elegir qué partidos
// analizar o meter, con una selección propia que calcula qué pasa si se juntan.
//
// Lo que se enseña al lado de cada probabilidad es lo que hace falta para no engañarse:
//   · el nivel de confianza de la capa trust/ (y por qué),
//   · cuánto acertó el modelo en el backtest cuando dio una probabilidad parecida,
//   · la cuota real contra la cuota justa (1/p): sin eso, «más probable» se confunde con
//     «mejor apuesta», y un 85 % pagado a 1,10 pierde dinero.


import { useEffect, useMemo, useState } from 'react';
import { SPORT_THEMES, type SportId } from '../../lib/theme';
import { DeporteIcono, StarIcon } from '../icons';
import { type Pick, type Respuesta, type Orden, RANGO, pct, clave, CLAVE_SEL, CLAVE_HORAS, leer, guardar } from './tipos';
import { useFiltrosQuery } from '../../lib/rutas';
import { Chip, Tarjeta } from './Tarjeta';
import { Seleccion } from './Seleccion';
import { Mercado } from './Mercado';
import { useSeguimiento } from '../seguimiento';
import FiltrosMovil from './FiltrosMovil';
import { conNodos, useI18n, type Clave } from '../../i18n';
import { deporteDe } from '../../lib/bets';

export default function TopPicks() {
  const { t } = useI18n();
  // Los filtros viven en la URL (Fase 5.2): el enlace copiado abre la misma lista.
  const [q, setQ] = useFiltrosQuery();
  const horas = Number(q.get('horas')) || leer(CLAVE_HORAS, 48);
  const orden = (q.get('orden') as Orden | null) ?? 'confianza';
  const deportes = (q.get('deportes')?.split(',').filter(Boolean) ?? []) as SportId[];
  const minP = Number(q.get('min')) || 0;
  const soloAlta = q.get('alta') === '1';
  const soloCuota = q.get('cuota') === '1';
  const setOrden = (o: Orden) => setQ({ orden: o === 'confianza' ? null : o });
  const setDeportes = (d: SportId[]) => setQ({ deportes: d.length ? d.join(',') : null });
  const setMinP = (m: number) => setQ({ min: m ? String(m) : null });
  const setSoloAlta = (b: boolean) => setQ({ alta: b ? '1' : null });
  const setSoloCuota = (b: boolean) => setQ({ cuota: b ? '1' : null });
  const { seguidos } = useSeguimiento();
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [sel, setSel] = useState<string[]>(() => leer<string[]>(CLAVE_SEL, []));

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    fetch(`/api/top-picks?horas=${horas}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: Respuesta) => {
        if (!vivo) return;
        setDatos(j);
        setError(false);
      })
      .catch(() => vivo && setError(true))
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
  }, [horas]);

  const setHoras = (h: number) => {
    guardar(CLAVE_HORAS, h);
    setQ({ horas: String(h) });
  };
  const alternar = (p: Pick) => {
    const k = clave(p);
    const nueva = sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k];
    setSel(nueva);
    guardar(CLAVE_SEL, nueva);
  };

  const lista = useMemo(() => {
    const xs = (datos?.partidos ?? []).filter(
      (p) =>
        (deportes.length === 0 || deportes.includes(p.sport)) &&
        p.probabilidad >= minP &&
        (!soloAlta || p.confianza?.nivel === 'ALTA') &&
        (!soloCuota || p.cuota != null),
    );
    const r = (p: Pick) => (p.confianza ? RANGO[p.confianza.nivel] : 3);
    const cmp: Record<Orden, (a: Pick, b: Pick) => number> = {
      confianza: (a, b) => r(a) - r(b) || b.probabilidad - a.probabilidad,
      probabilidad: (a, b) => b.probabilidad - a.probabilidad,
      ventaja: (a, b) => (b.ventaja ?? -9) - (a.ventaja ?? -9) || b.probabilidad - a.probabilidad,
      hora: (a, b) => a.cuando.localeCompare(b.cuando),
    };
    return [...xs].sort(cmp[orden]);
  }, [datos, deportes, minP, soloAlta, soloCuota, orden]);

  const presentes = useMemo(() => [...new Set((datos?.partidos ?? []).map((p) => p.sport))], [datos]);
  const elegidos = (datos?.partidos ?? []).filter((p) => sel.includes(clave(p)));
  const vaciar = () => {
    setSel([]);
    guardar(CLAVE_SEL, []);
  };

  // Cuántos filtros se apartan de lo normal: el chip-resumen del móvil los cuenta.
  const activos = [horas !== 48, orden !== 'confianza', deportes.length > 0, minP > 0, soloAlta, soloCuota].filter(Boolean).length;
  // Seguimiento (Fase 5.14): lo que se sigue sale primero, en su propia sección.
  const esSeguido = (p: Pick) => seguidos.some((x) => x.sport === p.sport && ((x.kind === 'partido' && x.ref_id === p.matchKey) || ((x.kind === 'equipo' || x.kind === 'jugador') && (x.ref_id === p.casaId || x.ref_id === p.fueraId))));
  const listaSeguida = lista.filter(esSeguido);
  const listaResto = lista.filter((p) => !esSeguido(p));
  const controles = (
      <div className="space-y-2.5 rounded-xl border border-(--line) bg-(--tint) p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] uppercase tracking-wide text-(--ink-muted)">{t('tp.proximas')}</span>
          {(datos?.horizontes ?? [24, 48, 168]).map((h) => (
            <Chip key={h} activo={horas === h} onClick={() => setHoras(h)}>
              {h === 168 ? t('tp.dias7') : t('tp.horas', { h })}
            </Chip>
          ))}
          <span className="ml-2 mr-1 text-[12px] uppercase tracking-wide text-(--ink-muted)">{t('tp.ordenar')}</span>
          {(
            [
              ['confianza', 'tp.orden.confianza'],
              ['probabilidad', 'tp.orden.probabilidad'],
              ['ventaja', 'tp.orden.ventaja'],
              ['hora', 'tp.orden.hora'],
            ] as [Orden, Clave][]
          ).map(([o, k]) => (
            <Chip key={o} activo={orden === o} onClick={() => setOrden(o)}>
              {t(k)}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {presentes.map((s) => (
            <Chip key={s} activo={deportes.includes(s)} onClick={() => setDeportes(deportes.includes(s) ? deportes.filter((x) => x !== s) : [...deportes, s])}>
              <DeporteIcono nombre={s} size={15} />
              {SPORT_THEMES[s] ? deporteDe(t, s) : s}
            </Chip>
          ))}
          <span className="mx-1 h-4 w-px bg-(--raised-2)" aria-hidden />
          {[0, 0.6, 0.7, 0.8].map((m) => (
            <Chip key={m} activo={minP === m} onClick={() => setMinP(m)}>
              {m === 0 ? t('tp.cualquiera') : `≥ ${m * 100} %`}
            </Chip>
          ))}
          <Chip activo={soloAlta} onClick={() => setSoloAlta(!soloAlta)}>
            {t('tp.soloAlta')}
          </Chip>
          <Chip activo={soloCuota} onClick={() => setSoloCuota(!soloCuota)}>
            {t('tp.soloCuota')}
          </Chip>
        </div>
      </div>
  );

  return (
    <div>
      <header className="mb-4 flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ color: 'var(--seleccion)', backgroundColor: 'rgba(245,181,68,0.12)' }}>
          <StarIcon size={22} />
        </span>
        <div>
          <h2 className="text-[20px] font-semibold leading-tight text-(--ink-strong)">{t('nav.destacados')}</h2>
          <p className="text-[13.5px] leading-snug text-(--ink-soft)">
            {t('tp.lema')}
          </p>
        </div>
      </header>

      {/* Controles: a la vista desde 1024 px; debajo, en una hoja (Fase 5.8). */}
      <div className="mb-4 hidden lg:block">{controles}</div>
      <FiltrosMovil activos={activos}>{controles}</FiltrosMovil>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className={cargando ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {error && !datos && <p className="text-[14px] text-(--ink-soft)">{t('tp.errorLista')}</p>}
          {!datos && !error && <p className="text-[14px] text-(--ink-soft)">{t('form.cargandoPartidos')}</p>}
          {datos && lista.length === 0 && (
            <div className="rounded-xl border border-(--line) bg-(--tint) p-5 text-[14px] leading-relaxed text-(--ink-soft)">
              {datos.partidos.length === 0 ? (
                <>
                  {t('tp.sinPartidos', { ventana: horas === 168 ? t('tp.dias7') : t('tp.horas', { h: horas }) })}
                  {datos.sinPrediccion > 0 && t('tp.sinPrediccion', { n: datos.sinPrediccion })}
                  {datos.demo > 0 && t('tp.demo', { n: datos.demo })}
                </>
              ) : (
                t('tp.ningunFiltro')
              )}
            </div>
          )}
          {seguidos.length > 0 && datos && (
            <section className="mb-4" aria-label={t('tp.seguimiento')}>
              <h3 className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-(--ink-strong)">{t('tp.seguimiento')} <span className="text-[13px] font-normal text-(--ink-muted)">· {listaSeguida.length}</span></h3>
              {listaSeguida.length === 0 ? (
                <p className="text-[13px] text-(--ink-muted)">{t('tp.noJuega', { lista: `${seguidos.map((x) => x.label).slice(0, 4).join(', ')}${seguidos.length > 4 ? '…' : ''}` })}</p>
              ) : (
                <div className="grid gap-3 xl:grid-cols-2">
                  {listaSeguida.map((p, i) => (
                    <Tarjeta key={clave(p)} p={p} puesto={i + 1} elegido={sel.includes(clave(p))} onElegir={() => alternar(p)} />
                  ))}
                </div>
              )}
            </section>
          )}
          <div className="grid gap-3 xl:grid-cols-2">
            {listaResto.map((p, i) => (
              <Tarjeta key={clave(p)} p={p} puesto={listaSeguida.length + i + 1} elegido={sel.includes(clave(p))} onElegir={() => alternar(p)} />
            ))}
          </div>
          {datos && (datos.sinPrediccion > 0 || datos.demo > 0) && lista.length > 0 && (
            <p className="mt-3 text-[12px] text-(--ink-muted)">
              {datos.sinPrediccion > 0 && t('tp.sinPrediccionPie', { n: datos.sinPrediccion })}
              {datos.demo > 0 && t('tp.demoPie', { n: datos.demo })}
            </p>
          )}
        </div>

        <aside id="mi-seleccion" className="scroll-mt-24 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-xl border border-(--line) bg-(--tint) p-4">
            <h3 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-(--ink-strong)">
              <span style={{ color: 'var(--seleccion)' }}>
                <StarIcon size={17} filled />
              </span>
              {t('tp.miSeleccion')}
              {elegidos.length > 0 && <span className="text-[13px] font-normal text-(--ink-muted)">· {elegidos.length}</span>}
            </h3>
            <Seleccion elegidos={elegidos} quitar={alternar} vaciar={vaciar} />
          </div>
          <div className="mt-3 rounded-xl border border-(--line) p-4 text-[12px] leading-relaxed text-(--ink-muted)">
            <p className="mb-1.5 font-medium text-(--ink-soft)">{t('tp.comoLeer')}</p>
            <p>
              {conNodos(t('tp.explica'), {
                confianza: <strong className="font-medium text-(--ink-soft)">{t('tp.confianza')}</strong>,
                probabilidad: <strong className="font-medium text-(--ink-soft)">{t('tp.probabilidad')}</strong>,
                acierto: <strong className="font-medium text-(--ink-soft)">{t('tp.aciertoHistorico')}</strong>,
                justa: <strong className="font-medium text-(--ink-soft)">{t('tp.justa')}</strong>,
              })}
            </p>
          </div>
          <Mercado />
        </aside>
      </div>

      {/* En el móvil el panel queda debajo de toda la lista: una barra fija con el
          resumen, y un toque lleva hasta él. */}
      {elegidos.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-(--line) bg-(--surface-card)/95 px-4 pb-3 pt-3 backdrop-blur lg:hidden">
          <a href="#mi-seleccion" className="flex items-center justify-between gap-3 text-[14px]">
            <span className="flex items-center gap-2 text-(--ink-strong)">
              <span style={{ color: 'var(--seleccion)' }}>
                <StarIcon size={17} filled />
              </span>
              {t('tp.enMiSeleccion', { n: elegidos.length })}
            </span>
            <span className="text-(--ink-soft)">
              {conNodos(t('tp.acertarTodos'), {
                p: <span className="font-semibold text-(--ink-strong)">{pct(elegidos.reduce((a, p) => a * p.probabilidad, 1))}</span>,
              })}
            </span>
          </a>
        </div>
      )}
    </div>
  );
}


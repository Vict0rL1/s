// Piezas compartidas de la interfaz: slate. Partido de ui/index.tsx en la Fase 5 (ningún import cambia: index.tsx reexporta).
import { useState } from 'react';
import type { SlateRow } from '../../lib/slate';
import { conNodos, localeDe, useI18n, type Traducir } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';
import { motivoVacio } from '../../lib/vacio';
/**
 * LA TABLA DE PARTIDOS: qué se juega y qué dice el modelo, haya precios o no.
 * ===========================================================================
 * `PicksPanel` es una tabla de MERCADOS ordenada por discrepancia con el precio, y se
 * retira entera cuando no hay ninguna discrepancia que enseñar. En la NFL eso pasa
 * siempre que las casas no han publicado línea, porque es el único deporte que no se
 * inventa cuotas: la pestaña se quedaba sin vista de conjunto y parecía que faltaba algo.
 *
 * Esta contesta otra pregunta, y una que no depende de las cuotas: «¿qué hay y a quién
 * ve favorito el modelo?». Por eso las dos columnas de mercado son opcionales por
 * diseño. Cuando no hay precio dicen «—», que es una respuesta; una tabla que no aparece
 * no lo es.
 *
 * Va DEBAJO del panel de discrepancias y ENCIMA de las tarjetas: resume lo que las
 * tarjetas detallan, y quien quiera el desglose de un partido lo abre ahí.
 */
/**
 * Hace cuánto se pidieron los precios, en palabras, o null si nunca.
 *
 * ===========================================================================
 * UNA LISTA CONGELADA TIENE QUE VERSE CONGELADA
 * ===========================================================================
 * Cuando el refresco automático se para —plan agotado, freno de ritmo, la app cerrada—
 * la tabla sigue ahí con las mismas cuotas y el mismo aspecto de estar al día. No hay
 * nada en la pantalla que distinga un precio de hace diez minutos de uno de hace dos
 * días, y esa es justo la diferencia que decide si una cuota sirve para algo.
 *
 * El umbral son SEIS HORAS y no una: con el plan gratuito un ciclo cabe cada pocos días,
 * así que marcar en ámbar a la hora teñiría de aviso el funcionamiento normal, y un
 * aviso permanente se deja de leer.
 */
function edadPrecios(t: Traducir, iso: string | null | undefined): { texto: string; viejo: boolean } | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60_000);
  const dias = Math.round(min / 1440);
  const texto =
    min < 60
      ? t('estado.haceMin', { n: min })
      : min < 1440
        ? t('estado.haceH', { n: Math.round(min / 60) })
        : t(dias === 1 ? 'tabla.haceDias1' : 'tabla.haceDiasN', { n: dias });
  return { texto, viejo: ms > 6 * 3600_000 };
}

export function SlateTable({
  rows,
  demoOdds = false,
  maxRows = 12,
  refrescadas,
  bands,
}: {
  rows: SlateRow[];
  /** Los precios existen pero se los ha inventado la app: la columna no dice nada. */
  demoOdds?: boolean;
  maxRows?: number;
  /** Cuándo se pidieron por última vez las cuotas de este deporte. */
  refrescadas?: string | null;
  /** Acierto medido por umbral de confianza, para que el filtro no prometa de más. */
  bands?: { desde: number; n: number; acierto: number }[] | null;
}) {
  const [open, setOpen] = useState(true);
  const [todas, setTodas] = useState(false);
  // ===========================================================================
  // EL FILTRO DE CONFIANZA
  // ===========================================================================
  // «Enséñame solo los partidos claros» es una petición razonable y tiene una respuesta
  // buena: el modelo acierta el 65 % de TODO, y el 87 % de aquello en lo que dice 80 % o
  // más. No es un modelo mejor, es el mismo modelo sobre menos partidos — y lo que se
  // paga es cobertura: ese 87 % vive en el 13 % de los partidos.
  //
  // Por eso el umbral SIEMPRE va acompañado del acierto medido y del número de partidos
  // sobre el que se midió. Un filtro que solo enseña la lista insinúa que filtrar por 80
  // garantiza acertar el 80, y eso solo es cierto si el modelo está calibrado ahí —
  // cosa que aquí está medida, y por eso se puede decir.
  // «Todos» es CERO, no 0,5. La primera versión arrancaba en 0,5 creyendo que el
  // favorito siempre pasa de la mitad, y eso solo es cierto con dos resultados. En el
  // fútbol hay empate: el favorito suele rondar el 40 %, así que la vista por defecto
  // escondía cinco de cada seis partidos con «todos» marcado. Medido en pantalla:
  // cabecera «6 partidos», tabla con 1 fila.
  const [umbral, setUmbral] = useState(0);
  const { t, idioma } = useI18n();
  if (rows.length === 0) return null;

  // La banda EXACTA del umbral, no «la más alta por debajo». Béisbol no tiene banda del
  // 80 %: su modelo casi nunca llega ahí y no hay partidos para medirlo. Con la búsqueda
  // anterior, «80 %+» en béisbol habría enseñado el acierto del 70 %+ como si fuera el
  // suyo — un número medido sobre otros partidos, puesto bajo un filtro que no lo es.
  const banda = bands?.find((b) => Math.abs(b.desde - umbral) < 1e-9) ?? null;
  const orden = [...rows]
    .filter((r) => r.pickProb >= umbral)
    .sort((a, b) => a.when.localeCompare(b.when));
  const vistas = todas ? orden : orden.slice(0, maxRows);
  const pct = (p: number) => `${pctF(p, 1)}`;
  // Un mercado inventado por la app NO es un mercado. Se trata igual que no tener
  // ninguno en vez de enseñar un número que solo puede confundir.
  const hayMercado = !demoOdds && orden.some((r) => r.marketProb != null);
  const edad = edadPrecios(t, refrescadas);
  const loc = localeDe(idioma);

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-(--line) bg-(--tint)">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-(--tint)"
      >
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold text-(--ink-strong)">{t('tabla.titulo')}</span>
          <span className="block text-[13px] text-(--ink-muted)">
            {rows.length === 1 ? t('tabla.unPartido') : t('tabla.nPartidos', { n: rows.length })}
            {t('tabla.favorito')}
            {hayMercado ? t('tabla.yMercado') : ''}
            {/* La edad de los precios, solo cuando hay precios de verdad que fechar. */}
            {hayMercado && edad && (
              <>
                {' · '}
                <span style={edad.viejo ? { color: 'var(--status-warning)' } : undefined}>
                  {t('tabla.precios', { edad: edad.texto })}
                  {edad.viejo ? t('tabla.yaNoValgan') : ''}
                </span>
              </>
            )}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-(--ink-muted)">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-(--line)">
          {/* El scroll horizontal vive en la tabla, nunca en la página: una fila ancha no
              puede empujar el resto de la pantalla de lado en un móvil. */}
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[520px] border-collapse text-[14px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-(--ink-muted)">
                  <th className="px-4 py-2 font-medium">{t('tabla.cuando')}</th>
                  <th className="px-4 py-2 font-medium">{t('tabla.partido')}</th>
                  <th className="px-4 py-2 font-medium">{t('tabla.favoritoModelo')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('tabla.mercado')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('tabla.cuota')}</th>
                </tr>
              </thead>
              <tbody>
                {vistas.map((r) => {
                  const dif = r.marketProb != null ? r.pickProb - r.marketProb : null;
                  return (
                    <tr key={r.id} className="border-t border-(--line)">
                      <td className="whitespace-nowrap px-4 py-2.5 text-(--ink-soft)">
                        {new Date(r.when).toLocaleString(loc, {
                          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                      <td className="px-4 py-2.5 text-(--ink-body)">{r.match}</td>
                      <td className="px-4 py-2.5">
                        <span className="text-(--ink-strong)">{r.pick}</span>{' '}
                        <span className="font-semibold text-(--ink-strong)">{pct(r.pickProb)}</span>
                        {r.drawProb != null && (
                          <span className="block text-[12px] text-(--ink-muted)">
                            {t('tabla.empate', { p: pct(r.drawProb) })}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-(--ink-soft)">
                        {r.marketProb == null ? (
                          <span className="text-(--ink-faint)">—</span>
                        ) : (
                          <>
                            {pct(r.marketProb)}
                            {dif != null && Math.abs(dif) >= 0.04 && (
                              <span className="block text-[12px] text-(--ink-muted)">
                                {dif > 0 ? '+' : ''}
                                {numF(dif * 100, 1)} pp
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-(--ink-soft)">
                        {r.odds == null ? <span className="text-(--ink-faint)">—</span> : numF(r.odds, 2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* El control del umbral, con lo que cuesta y lo que da, los dos medidos. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-(--line) px-4 py-2.5">
            <span className="text-[13px] text-(--ink-muted)">{t('tabla.soloClaros')}</span>
            {[0, 0.6, 0.7, 0.8].map((u) => (
              <button
                key={u}
                onClick={() => setUmbral(u)}
                className={`rounded-full px-2.5 py-1 text-[13px] transition ${
                  umbral === u ? 'bg-(--raised-2) text-(--ink-strong)' : 'text-(--ink-soft) hover:bg-(--raised)'
                }`}
              >
                {u === 0 ? t('tabla.todos') : `${pctF(u, 0)}+`}
              </button>
            ))}
            {umbral > 0 && (
              <span className="text-[13px] text-(--ink-muted)">
                {/* Con la lista vacía no hay «estos» de los que acertar un porcentaje.
                    Decir «acierta el 87 % de estos» sobre cero partidos es una frase
                    sin referente, y de las que se leen como si prometieran algo. */}
                {orden.length === 0 ? t('tabla.ninguno', { n: rows.length }) : t('tabla.deN', { a: orden.length, n: rows.length })}
                {banda
                  ? t(orden.length === 0 ? 'tabla.cuandoLosHay' : 'tabla.aciertaEstos', { p: numF(banda.acierto * 100, 0), n: banda.n.toLocaleString(loc) })
                  : bands?.length
                    ? t('tabla.casiNunca')
                    : t('tabla.sinBanda')}
              </span>
            )}
          </div>

          {orden.length > maxRows && (
            <button
              onClick={() => setTodas(!todas)}
              className="w-full border-t border-(--line) px-4 py-2.5 text-[13px] text-(--ink-soft) transition hover:bg-(--tint)"
            >
              {todas ? t('tabla.soloProximos') : t('tabla.verTodos', { n: orden.length })}
            </button>
          )}

          {/* Por qué las dos últimas columnas están vacías. Sin esta línea, un guion en
              todas las filas se lee como que la app no ha cargado algo. */}
          {!hayMercado && (
            <p className="border-t border-(--line) px-4 py-2.5 text-[13px] leading-relaxed text-(--ink-muted)">
              {t('tabla.sinMercado')} {demoOdds ? t('tabla.sinMercadoDemo') : t('tabla.sinMercadoReal')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * POR QUÉ ESTA PESTAÑA ESTÁ VACÍA, CUANDO LO ESTÁ A PROPÓSITO
 * ===========================================================================
 * Con `DEMO_FIXTURES=off` la app deja de inventarse partidos, que es lo que se le ha
 * pedido. Pero una pestaña vacía se parece muchísimo a una pestaña rota: no hay forma de
 * distinguir «no hay nada que enseñar» de «no ha cargado» mirándola.
 *
 * Un vacío deliberado tiene que decir que es deliberado, y decir qué falta para que deje
 * de estarlo. Esto es lo que separa apagar la demostración —una decisión— de que la app
 * parezca averiada.
 */
export function VacioPorqueNoHayCuotas({
  reason,
  detail,
  hasKey,
  demoFixtures,
}: {
  reason: string | null | undefined;
  detail?: string | null;
  /** null mientras no se sabe (el estado de las cuotas no ha llegado o falló). */
  hasKey: boolean | null;
  demoFixtures: boolean;
}) {
  // Con la demostración encendida, un vacío significa otra cosa (no hay datos del
  // deporte) y lo explica `EmptySlate`. Esta nota es solo para el vacío deliberado.
  const { t } = useI18n();
  if (demoFixtures) return null;

  return (
    <div className="mb-6 rounded-xl border border-(--line) bg-(--tint) px-4 py-4 text-[14px] leading-relaxed text-(--ink-soft)">
      <p className="mb-2 text-[15px] font-semibold text-(--ink-strong)">
        {t('vacio.titulo')}
      </p>
      <p>
        {conNodos(t('vacio.aProposito'), { aProposito: <strong className="text-(--ink-body)">{t('vacio.aPropositoPalabra')}</strong> })}{' '}
        {t(motivoVacio(reason, hasKey))}
      </p>
      {detail && (
        <p className="mt-2 text-[13px] opacity-70">
          <span className="font-mono">{detail}</span>
        </p>
      )}
      <p className="mt-3 text-[13px] text-(--ink-muted)">
        {conNodos(t('vacio.siguenAhi'), { comando: <code>npm run demo -- --on</code> })}
      </p>
    </div>
  );
}

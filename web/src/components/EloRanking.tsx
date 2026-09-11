/**
 * La clasificación por Elo, compartida por los cinco deportes.
 *
 * ===========================================================================
 * UN COMPONENTE Y NO CINCO TABLAS
 * ===========================================================================
 * Cuatro de las cinco pestañas ya tenían su propia tabla, casi idénticas y con
 * diferencias que no eran decisiones sino accidentes: una decía «equipos por Elo» y otra
 * «equipos ordenados por Elo», una enseñaba la diferencia de goles y otra no. Añadir la
 * quinta copia habría sido el momento de dejar de copiar.
 *
 * ===========================================================================
 * QUÉ HACE QUE ESTO SIRVA PARA ANALIZAR Y NO SOLO PARA MIRAR
 * ===========================================================================
 * Tres cosas que la tabla anterior no tenía:
 *
 *   1. LA PROBABILIDAD. Un 1650 no se puede interpretar; un «68 % contra un rival medio»
 *      sí, y es exactamente lo mismo — el Elo existe para producir ese número. Es la
 *      columna que convierte la tabla en una herramienta.
 *
 *   2. LA BARRA. El orden se ve en cualquier lista ordenada; lo que no se ve son los
 *      HUECOS. Dos equipos separados por 200 puntos y dieciocho apelotonados en 40 es
 *      una liga completamente distinta de una repartida por igual, y las dos producen la
 *      misma lista de nombres.
 *
 *   3. LA FIABILIDAD. Un Elo sobre 4 partidos y otro sobre 400 se imprimen igual. El que
 *      tiene pocos se marca, porque tratarlos igual es el error que hace que alguien
 *      analice a un equipo del que el modelo no sabe nada.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { spreadOf, winProbability } from '../lib/elo';

export interface EloRow {
  id: string;
  name: string;
  elo: number;
  /** Partidos que respaldan el número. Pocos = poco fiable, y se dice. */
  matches?: number | null;
  /** Columnas propias del deporte: goles a favor, superficie, lo que sea. */
  extra?: { label: string; value: string; title?: string }[];
  /** Escudo, bandera o lo que identifique visualmente. */
  badge?: ReactNode;
  /** Nota corta a la derecha del nombre (por ejemplo «último partido hace 3 años»). */
  note?: string;
  onOpen?: () => void;
}

/**
 * Por debajo de esto, un Elo es ruido con decimales.
 *
 * No es un número mágico: es el punto en el que un rating deja de estar dominado por su
 * valor inicial. Se marca, no se oculta — esconder filas sería peor, porque el equipo
 * desaparecería sin explicación.
 */
const FEW_MATCHES = 10;

export default function EloRanking({
  title,
  subtitle,
  rows,
  extraHeaders = [],
  defaultOpen = true,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  rows: EloRow[];
  extraHeaders?: string[];
  /**
   * ABIERTA por defecto, y esto cambió por un motivo.
   *
   * Antes el valor por omisión era `false`, con un comentario que decía «plegada donde va
   * al final de una página larga; abierta cuando es lo que el usuario vino a ver». La
   * segunda mitad de esa frase nunca se cableó: ninguna de las cinco pestañas pasaba
   * `defaultOpen`, así que la tabla estaba SIEMPRE plegada, al final de una página de
   * ocho tarjetas de partido. Para verla había que bajar hasta el fondo y saber que ese
   * título gris era un botón.
   *
   * Esta tabla es lo que se pidió para «visualizar y entender qué equipos o jugadores
   * tienen mejor Elo». Una función que hay que descubrir no está entregada, así que ahora
   * se abre sola y quien no la quiera la cierra — y su decisión se recuerda, por pestaña.
   */
  defaultOpen?: boolean;
  footer?: ReactNode;
}) {
  // La clave lleva el título porque cada deporte tiene la suya: cerrar la de la NFL no
  // tiene por qué cerrar la del tenis.
  const openKey = `elo-open:${title}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(openKey);
      return saved === null ? defaultOpen : saved === '1';
    } catch {
      // Ventana privada o almacenamiento bloqueado: se abre, que es el valor por defecto.
      return defaultOpen;
    }
  });
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(openKey, next ? '1' : '0');
    } catch {
      // Solo afecta a si se abre plegada la próxima vez.
    }
  };
  const [query, setQuery] = useState('');

  const spread = useMemo(() => spreadOf(rows.map((r) => r.elo)), [rows]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // El filtro NO reordena ni renumera: el puesto que se enseña es el de la tabla
    // entera. Buscar «Villarreal» y ver «#1» sería una respuesta falsa a la única
    // pregunta que tiene esta tabla.
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  }, [rows, query]);

  if (rows.length === 0) return null;

  const rank = new Map(rows.map((r, i) => [r.id, i + 1]));

  return (
    <section className="mt-8 rounded-xl border border-white/[0.07] bg-[#14161b] p-4">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="text-[14px] uppercase tracking-wide text-[#7b828d]">{title}</span>
          <br />
          <span className="text-[16px] text-[#d5d9df]">
            {rows.length} por Elo
            {spread && (
              <span className="ml-2 text-[14px] text-[#7b828d]">
                · {Math.round(spread.worst)}–{Math.round(spread.best)}
              </span>
            )}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-[14px] text-[#5c636c]">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="mt-3 border-t border-white/[0.07] pt-3">
          {subtitle && (
            <div className="mb-3 text-[13px] leading-relaxed text-[#7b828d]">{subtitle}</div>
          )}

          {/* La forma de la competición, que no se ve en la lista de nombres. */}
          {spread && (
            <p className="mb-3 text-[13px] leading-relaxed text-[#9aa1ac]">
              El primero le ganaría al último{' '}
              <strong className="font-semibold text-[#e8eaed]">
                {(spread.topBeatsBottom * 100).toFixed(0)} %
              </strong>{' '}
              de las veces.{' '}
              <span className="text-[#7b828d]">
                Cerca del 50 % significa igualdad; por encima del 90 %, un abismo entre
                arriba y abajo. La columna «vs. medio» es cada uno contra un rival de{' '}
                {Math.round(spread.median)} Elo, la mediana de esta lista.
              </span>
            </p>
          )}

          {rows.length > 12 && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar…"
              className="mb-3 w-full max-w-xs rounded-lg bg-white/[0.05] px-3 py-1.5 text-[14px] text-[#e8eaed] ring-1 ring-inset ring-white/[0.08] placeholder:text-[#5c636c] focus:outline-none focus:ring-white/[0.2]"
            />
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-[14px] tabular-nums">
              <thead className="text-[#7b828d]">
                <tr>
                  <th className="py-1 pr-2 font-normal">#</th>
                  <th className="py-1 pr-2 font-normal">Nombre</th>
                  <th className="py-1 pr-2 font-normal">Elo</th>
                  <th className="py-1 pr-3 font-normal" title="Probabilidad de ganar a un rival con el Elo mediano de esta lista">
                    vs. medio
                  </th>
                  {extraHeaders.map((h) => (
                    <th key={h} className="py-1 pr-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-[#d5d9df]">
                {shown.map((r) => {
                  const p = spread ? winProbability(r.elo - spread.median) : 0.5;
                  // La barra se ancla al rango de ESTA lista, no a un cero absoluto: un
                  // Elo de 1500 y otro de 1900 con la barra desde cero se ven casi
                  // iguales, que es justo lo contrario de lo que hay que ver.
                  const span = spread ? Math.max(1, spread.best - spread.worst) : 1;
                  const width = spread ? ((r.elo - spread.worst) / span) * 100 : 50;
                  const few = r.matches != null && r.matches < FEW_MATCHES;
                  return (
                    <tr key={r.id} className="border-t border-white/[0.07]">
                      <td className="py-1 pr-2 text-[#7b828d]">{rank.get(r.id)}</td>
                      <td className="py-1 pr-2">
                        <span className="flex min-w-0 items-center gap-2">
                          {r.badge}
                          {r.onOpen ? (
                            <button
                              onClick={r.onOpen}
                              className="truncate text-[#c3c9d1] hover:underline"
                            >
                              {r.name}
                            </button>
                          ) : (
                            <span className="truncate text-[#c3c9d1]">{r.name}</span>
                          )}
                          {few && (
                            <span
                              className="shrink-0 text-[12px] text-amber-400/80"
                              title={`Solo ${r.matches} partidos: este Elo todavía no significa gran cosa`}
                            >
                              ◦{r.matches}
                            </span>
                          )}
                          {r.note && (
                            <span className="shrink-0 text-[12px] text-[#7b828d]">{r.note}</span>
                          )}
                        </span>
                      </td>
                      <td className="py-1 pr-2">
                        <span className="flex items-center gap-2">
                          <span className="w-10 shrink-0">{Math.round(r.elo)}</span>
                          {/* aria-hidden: la barra repite el número de al lado, así que
                              para un lector de pantalla solo sería ruido. */}
                          <span
                            aria-hidden
                            className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-white/[0.07] sm:block"
                          >
                            <span
                              className="block h-full rounded-full bg-[#7aa2f7]"
                              style={{ width: `${Math.max(2, width)}%` }}
                            />
                          </span>
                        </span>
                      </td>
                      <td className="py-1 pr-3 text-[#9aa1ac]">{(p * 100).toFixed(0)} %</td>
                      {(r.extra ?? []).map((x, i) => (
                        <td key={i} className="py-1 pr-2" title={x.title}>
                          {x.value}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {shown.length === 0 && (
            <p className="mt-2 text-[13px] text-[#7b828d]">Nada coincide con «{query}».</p>
          )}

          {footer && <div className="mt-3 text-[13px] leading-relaxed text-[#7b828d]">{footer}</div>}
        </div>
      )}
    </section>
  );
}

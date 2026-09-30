/**
 * La clasificación por Elo del circuito, con superficie.
 *
 * ===========================================================================
 * LO QUE EL TENIS TIENE Y LOS DEPORTES DE EQUIPO NO
 * ===========================================================================
 * Cuatro Elo por jugador: general, dura, tierra y hierba. Eso convierte la tabla en algo
 * que las de equipo no pueden ser — un sitio donde comparar al MISMO jugador consigo
 * mismo. Alcaraz es el segundo en general y el primero en tierra; Sinner al revés. Esa
 * es la pregunta que el selector de superficie contesta, y por eso reordena de verdad en
 * vez de solo añadir una columna.
 *
 * ===========================================================================
 * DOS FILTROS QUE NO SON COSMÉTICOS
 * ===========================================================================
 * El Elo de un jugador se queda CONGELADO en su último partido. Sin filtro de actividad
 * la lista sale así:
 *
 *     4. Roger Federer   2091   último partido: junio de 2021
 *     8. Rafael Nadal    2020   último partido: noviembre de 2024
 *
 * Los dos números son correctos y la lista es inútil: preguntada «¿quién es mejor
 * ahora?» contesta con dos retirados. No es un dato erróneo — responde a otra pregunta,
 * «quién llegó más alto» — y mezclar las dos sin decirlo es cómo alguien acaba analizando
 * una superficie con un jugador que no la pisa desde hace cuatro años. Se puede pedir la
 * lista histórica; hay que pedirla.
 *
 * Y el mínimo de partidos: con tres, un Elo es ruido con decimales.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type EloRankPlayer, type EloRankingResponse } from '../lib/api';
import EloRanking from './EloRanking';
import { Flag } from './ui';

type Surface = 'overall' | 'hard' | 'clay' | 'grass';

const SURFACE_LABEL: Record<Surface, string> = {
  overall: 'General',
  hard: 'Dura',
  clay: 'Tierra',
  grass: 'Hierba',
};

const eloOn = (p: EloRankPlayer, s: Surface): number =>
  s === 'hard' ? p.hard : s === 'clay' ? p.clay : s === 'grass' ? p.grass : p.elo;

/** En qué superficie es mejor este jugador, respecto de su propio nivel general. */
function bestSurface(p: EloRankPlayer): { key: Surface; edge: number } {
  const opts: Surface[] = ['hard', 'clay', 'grass'];
  let best = opts[0];
  for (const s of opts) if (eloOn(p, s) > eloOn(p, best)) best = s;
  return { key: best, edge: eloOn(p, best) - p.elo };
}

function chip(active: boolean): string {
  return `shrink-0 rounded-full px-3 py-1 text-[14px] font-medium ring-1 ring-inset transition ${
    active
      ? 'bg-white/[0.12] text-[#e8eaed] ring-white/[0.18]'
      : 'text-[#9aa1ac] ring-white/[0.08] hover:bg-white/[0.05] hover:text-[#e8eaed]'
  }`;
}

export default function TennisEloPanel({
  tour,
  onOpenPlayer,
}: {
  tour: string;
  onOpenPlayer?: (tour: string, id: number) => void;
}) {
  const [data, setData] = useState<EloRankingResponse | null>(null);
  const [surface, setSurface] = useState<Surface>('overall');
  const [onlyActive, setOnlyActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .power(tour, { limit: 60, activeDays: onlyActive ? 730 : 0 })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [tour, onlyActive]);

  useEffect(load, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    // Reordenar de verdad por la superficie elegida. Enseñar las cuatro columnas pero
    // dejar el orden del general convertiría «¿quién es mejor en tierra?» en un
    // ejercicio de leer una columna desordenada.
    return [...data.players]
      .sort((a, b) => eloOn(b, surface) - eloOn(a, surface))
      .map((p) => {
        const best = bestSurface(p);
        const years = p.daysSince != null ? p.daysSince / 365 : null;
        return {
          id: String(p.id),
          name: p.name,
          elo: eloOn(p, surface),
          matches: p.matches,
          // El mismo hueco que los cuatro deportes de equipo llenan con el escudo. En una
          // lista de 50 nombres la bandera hace un trabajo que el nombre no hace: agrupa.
          // «Los tres españoles del top 20» se ve de un barrido y no leyendo cincuenta
          // apellidos.
          badge: <Flag country={p.country} />,
          // Solo se avisa a partir de año y medio: en tenis, tres meses sin jugar en
          // pretemporada o por una lesión corta es normal y marcarlo sería ruido.
          note:
            years != null && years >= 1.5
              ? `sin jugar hace ${years.toFixed(0)} años`
              : undefined,
          onOpen: onOpenPlayer ? () => onOpenPlayer(tour, p.id) : undefined,
          extra: [
            {
              label: 'Mejor sup.',
              value: `${SURFACE_LABEL[best.key]} ${best.edge >= 0 ? '+' : ''}${Math.round(best.edge)}`,
              title:
                'Su mejor superficie y cuánto sube respecto de su propio Elo general. ' +
                'Positivo grande = especialista.',
            },
            { label: 'Dura', value: String(Math.round(p.hard)) },
            { label: 'Tierra', value: String(Math.round(p.clay)) },
            { label: 'Hierba', value: String(Math.round(p.grass)) },
            {
              label: 'Oficial',
              value: p.officialRank != null ? `#${p.officialRank}` : '—',
              title:
                p.officialRankDate != null
                  ? `Ranking oficial del ${p.officialRankDate.slice(0, 4)}-${p.officialRankDate.slice(4, 6)}-${p.officialRankDate.slice(6, 8)}`
                  : 'Sin ranking oficial guardado',
            },
          ],
        };
      });
  }, [data, surface, tour, onOpenPlayer]);

  if (error) {
    return (
      <section className="mt-8 rounded-xl border border-white/[0.07] bg-[#14161b] p-4 text-[13px] text-[#7b828d]">
        No se pudo cargar la clasificación por Elo: {error}
      </section>
    );
  }
  if (!data) return null;

  const hidden = data.rated - data.players.length;

  return (
    <EloRanking
      title={`Clasificación por Elo · ${tour.toUpperCase()}`}
      rows={rows}
      extraHeaders={['Mejor sup.', 'Dura', 'Tierra', 'Hierba', 'Oficial']}
      subtitle={
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[#5c636c]">Ordenar por:</span>
            {(['overall', 'hard', 'clay', 'grass'] as Surface[]).map((s) => (
              <button key={s} className={chip(surface === s)} onClick={() => setSurface(s)}>
                {SURFACE_LABEL[s]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[#5c636c]">Mostrar:</span>
            <button className={chip(onlyActive)} onClick={() => setOnlyActive(true)}>
              En activo
            </button>
            <button className={chip(!onlyActive)} onClick={() => setOnlyActive(false)}>
              Histórico
            </button>
          </div>
          <p className="leading-relaxed">
            {onlyActive ? (
              <>
                Jugadores con al menos {data.minMatches} partidos y alguno en los últimos dos
                años.{' '}
                {hidden > 0 && (
                  <>
                    Quedan fuera <strong className="text-[#9aa1ac]">{hidden}</strong> por llevar
                    más tiempo sin jugar — su Elo sigue congelado en su último partido, así que
                    en una lista de «quién es mejor ahora» respondería a otra pregunta.
                  </>
                )}
              </>
            ) : (
              <>
                Lista <strong className="text-[#9aa1ac]">histórica</strong>: incluye a los
                retirados con el Elo congelado en su último partido. Contesta «quién llegó más
                alto en este archivo», no «quién es mejor ahora».
              </>
            )}
          </p>
        </div>
      }
      footer={
        <div className="space-y-2">
          <p>
            «Mejor sup.» compara al jugador <em>consigo mismo</em>, no con los demás: es cuánto
            sube su Elo en su mejor superficie respecto de su propio general. Un +150 es un
            especialista claro; un +10, alguien igual de bueno en todas.
          </p>
          {/* El defecto de los datos se dice, no se disimula. */}
          {!data.officialRanking.coherent && (
            <p className="text-amber-200/80">
              <strong>La columna «Oficial» no es una foto de un mismo día.</strong> Se guarda el
              último ranking de cada jugador por separado y aquí abarcan{' '}
              {data.officialRanking.spanDays} días, así que puede haber varios con el mismo
              número. Pasa el cursor por cada uno para ver su fecha. Arreglarlo pide traer el
              ranking completo de una fecha en la ingesta, no cambiar esta tabla.
            </p>
          )}
        </div>
      }
    />
  );
}

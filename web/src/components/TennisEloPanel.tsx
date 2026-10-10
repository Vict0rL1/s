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
import { conNodos, useI18n, type Clave } from '../i18n';
import { num as numF } from '../lib/formato';

type Surface = 'overall' | 'hard' | 'clay' | 'grass';

const SURFACE_LABEL: Record<Surface, Clave> = {
  overall: 'etn.general',
  hard: 'etn.dura',
  clay: 'etn.tierra',
  grass: 'etn.hierba',
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
      ? 'bg-(--raised-3) text-(--ink-strong) ring-(--line-strong)'
      : 'text-(--ink-soft) ring-(--line) hover:bg-(--raised) hover:text-(--ink-strong)'
  }`;
}

export default function TennisEloPanel({
  tour,
  onOpenPlayer,
}: {
  tour: string;
  onOpenPlayer?: (tour: string, id: number) => void;
}) {
  const { t } = useI18n();
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
              ? t('etn.sinJugar', { n: numF(years, 0) })
              : undefined,
          onOpen: onOpenPlayer ? () => onOpenPlayer(tour, p.id) : undefined,
          extra: [
            {
              label: t('etn.mejorSup'),
              value: `${t(SURFACE_LABEL[best.key])} ${best.edge >= 0 ? '+' : ''}${Math.round(best.edge)}`,
              title: t('etn.mejorSupTitulo'),
            },
            { label: t('etn.dura'), value: String(Math.round(p.hard)) },
            { label: t('etn.tierra'), value: String(Math.round(p.clay)) },
            { label: t('etn.hierba'), value: String(Math.round(p.grass)) },
            {
              label: t('etn.oficial'),
              value: p.officialRank != null ? `#${p.officialRank}` : '—',
              title:
                p.officialRankDate != null
                  ? t('etn.rankingDel', { fecha: `${p.officialRankDate.slice(0, 4)}-${p.officialRankDate.slice(4, 6)}-${p.officialRankDate.slice(6, 8)}` })
                  : t('etn.sinRanking'),
            },
          ],
        };
      });
  }, [data, surface, tour, onOpenPlayer, t]);

  if (error) {
    return (
      <section className="mt-8 rounded-xl border border-(--line) bg-(--surface-card) p-4 text-[13px] text-(--ink-muted)">
        {t('etn.errorCargar', { error })}
      </section>
    );
  }
  if (!data) return null;

  const hidden = data.rated - data.players.length;

  return (
    <EloRanking
      title={t('etn.titulo', { tour: tour.toUpperCase() })}
      rows={rows}
      extraHeaders={[t('etn.mejorSup'), t('etn.dura'), t('etn.tierra'), t('etn.hierba'), t('etn.oficial')]}
      subtitle={
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-(--ink-faint)">{t('etn.ordenarPor')}</span>
            {(['overall', 'hard', 'clay', 'grass'] as Surface[]).map((s) => (
              <button key={s} className={chip(surface === s)} onClick={() => setSurface(s)}>
                {t(SURFACE_LABEL[s])}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-(--ink-faint)">{t('etn.mostrar')}</span>
            <button className={chip(onlyActive)} onClick={() => setOnlyActive(true)}>
              {t('etn.enActivo')}
            </button>
            <button className={chip(!onlyActive)} onClick={() => setOnlyActive(false)}>
              {t('etn.historico')}
            </button>
          </div>
          <p className="leading-relaxed">
            {onlyActive ? (
              <>
                {t('etn.activos', { min: data.minMatches })}{' '}
                {hidden > 0 && conNodos(t('etn.quedanFuera'), { n: <strong className="text-(--ink-soft)">{hidden}</strong> })}
              </>
            ) : (
              conNodos(t('etn.listaHistorica'), { historica: <strong className="text-(--ink-soft)">{t('etn.historica')}</strong> })
            )}
          </p>
        </div>
      }
      footer={
        <div className="space-y-2">
          <p>{conNodos(t('etn.mejorSupExplica'), { consigo: <em>{t('etn.consigo')}</em> })}</p>
          {/* El defecto de los datos se dice, no se disimula. */}
          {!data.officialRanking.coherent && (
            <p className="text-amber-200/80">
              <strong>{t('etn.oficialNoFoto')}</strong>{' '}
              {t('etn.oficialDetalle', { dias: data.officialRanking.spanDays ?? '' })}
            </p>
          )}
        </div>
      }
    />
  );
}

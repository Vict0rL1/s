/**
 * Los cuatro mercados, del mismo modelo de puntos.
 *
 * ===========================================================================
 * POR QUÉ ESTÁN JUNTOS EN UN PANEL
 * ===========================================================================
 * Porque son la misma distribución mirada de cuatro formas, y separarlos en cuatro
 * tarjetas invitaría a leerlos como cuatro opiniones. No lo son: hay exactamente dos
 * números detrás —las probabilidades de ganar un punto al saque de cada jugador— y todo
 * lo demás sale de propagarlos por la cadena.
 *
 * La consecuencia práctica de eso es la que merece estar a la vista: NO PUEDEN
 * CONTRADECIRSE. Con modelos separados por mercado es perfectamente posible publicar un
 * 70 % de ganar el partido y un total de juegos que implique un 60 %, y nadie se entera
 * hasta que alguien lo suma a mano.
 */
import { useCallback, useEffect, useState } from 'react';
import { Panel, SectionTitle, Disclosure } from './ui';
import { conNodos, localeDe, useI18n } from '../i18n';
import { pct as pctF, num as numF } from '../lib/formato';

interface PointsResponse {
  points: { p1: number; p2: number };
  matchProb: number;
  setProb: number;
  setScores: { label: string; side: 1 | 2; probability: number }[];
  totals: { line: number; over: number; under: number }[];
  expectedGames: number;
  handicaps: { handicap: number; cover: number }[];
  detail: {
    mu: number;
    serve1: number;
    return1: number;
    serve2: number;
    return2: number;
    surfaceDelta1: number;
    surfaceDelta2: number;
  };
  model: {
    fittedAt: string;
    ageDays: number;
    observations: number;
    players: number;
    stale: boolean;
  };
}

const pct = (x: number): string => `${pctF(x, 1)}`;
const conSigno = (x: number): string => `${x >= 0 ? '+' : ''}${numF(x, 3)}`;

export default function PointsMarkets({
  tour,
  p1,
  p2,
  names,
  surface,
  bestOf = 3,
  tourney,
}: {
  tour: string;
  p1: number;
  p2: number;
  names: [string, string];
  surface: string;
  bestOf?: number;
  tourney?: string | null;
}) {
  const { t, idioma } = useI18n();
  const [data, setData] = useState<PointsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams({
      tour,
      p1: String(p1),
      p2: String(p2),
      surface,
      bestOf: String(bestOf),
    });
    if (tourney) q.set('tourney', tourney);
    fetch(`/api/points?${q}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        return j as PointsResponse;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)));
  }, [tour, p1, p2, surface, bestOf, tourney]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Panel className="mb-4">
        <SectionTitle>{t('pm.titulo')}</SectionTitle>
        <p className="text-[13px] leading-relaxed text-(--ink-muted)">{error}</p>
      </Panel>
    );
  }
  if (!data) return null;

  return (
    <Panel className="mb-4">
      <SectionTitle right={t('pm.esperados', { n: numF(data.expectedGames, 1) })}>
        {t('pm.titulo')}
      </SectionTitle>

      <p className="mb-3 text-[13px] leading-relaxed text-(--ink-muted)">
        {conNodos(t('pm.dosNumeros', { a: names[0], pa: pct(data.points.p1), b: names[1], pb: pct(data.points.p2) }), {
          dos: <strong className="text-(--ink-soft)">{t('pm.dos')}</strong>,
        })}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* --- Partido y set --- */}
        <div>
          <SectionTitle>{t('pm.partidoSet')}</SectionTitle>
          <Row label={t('pm.gana', { nombre: names[0] })} value={pct(data.matchProb)} strong />
          <Row label={t('pm.gana', { nombre: names[1] })} value={pct(1 - data.matchProb)} />
          <Row label={t('pm.ganaSet', { nombre: names[0] })} value={pct(data.setProb)} />
          <div className="mt-2 space-y-0.5">
            {data.setScores.map((s) => (
              <Row
                key={`${s.side}-${s.label}`}
                label={`${names[s.side - 1]} ${s.label}`}
                value={pct(s.probability)}
                dim
              />
            ))}
          </div>
        </div>

        {/* --- Totales --- */}
        <div>
          <SectionTitle>{t('pm.totalJuegos')}</SectionTitle>
          {data.totals.map((x) => (
            <Row
              key={x.line}
              label={t('pm.masDe', { linea: x.line })}
              value={pct(x.over)}
              strong={Math.abs(x.line - data.expectedGames) < 1}
            />
          ))}
          <p className="mt-1 text-[11px] leading-relaxed text-(--ink-faint)">
            {t('pm.lineasCentradas')}
          </p>
        </div>
      </div>

      {/* --- Hándicaps --- */}
      <div className="mt-3">
        <SectionTitle>{t('pm.handicapJuegos')}</SectionTitle>
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[22rem] text-left text-[13px] tabular-nums">
            <thead className="text-[11px] uppercase tracking-[0.06em] text-(--ink-muted)">
              <tr>
                <th className="pb-1 font-medium">{t('pm.handicap')}</th>
                <th className="pb-1 text-right font-medium">{names[0]}</th>
                <th className="pb-1 text-right font-medium">{names[1]}</th>
              </tr>
            </thead>
            <tbody>
              {data.handicaps
                .filter((h) => h.handicap < 0)
                .map((h) => {
                  const other = data.handicaps.find((x) => x.handicap === -h.handicap);
                  return (
                    <tr key={h.handicap} className="border-t border-(--line)">
                      <td className="py-1 text-(--ink-soft)">
                        {h.handicap} / +{-h.handicap}
                      </td>
                      <td className="py-1 text-right text-(--ink-strong)">{pct(h.cover)}</td>
                      <td className="py-1 text-right text-(--ink-strong)">
                        {other ? pct(1 - other.cover) : '—'}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-3">
        <Disclosure summary={t('pm.deDonde')}>
          <div className="space-y-2 text-[13px] leading-relaxed text-(--ink-muted)">
            <p>{conNodos(t('pm.estimados'), { aLaVez: <strong>{t('pm.aLaVez')}</strong> })}</p>
            <ul className="space-y-0.5 tabular-nums">
              <li>
                {t('pm.media', { pct: `${pctF(1 / (1 + Math.exp(-data.detail.mu)), 1)}` })}
              </li>
              <li>
                {t('pm.perfil', { nombre: names[0], saque: conSigno(data.detail.serve1), resto: conSigno(data.detail.return1), delta: conSigno(data.detail.surfaceDelta1) })}
              </li>
              <li>
                {t('pm.perfil', { nombre: names[1], saque: conSigno(data.detail.serve2), resto: conSigno(data.detail.return2), delta: conSigno(data.detail.surfaceDelta2) })}
              </li>
            </ul>
            <p>{t('pm.logit')}</p>
            <p className={data.model.stale ? 'text-amber-200/80' : undefined}>
              {t('pm.ajustado', { obs: data.model.observations.toLocaleString(localeDe(idioma)), jugadores: data.model.players, dias: data.model.ageDays })}
              {data.model.stale && (
                <> {conNodos(t('pm.viejo'), { cmd: <code>npm run update-data</code> })}</>
              )}
            </p>
          </div>
        </Disclosure>
      </div>
    </Panel>
  );
}

function Row({
  label,
  value,
  strong,
  dim,
}: {
  label: string;
  value: string;
  strong?: boolean;
  dim?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className={`break-words text-[13px] ${dim ? 'text-(--ink-muted)' : 'text-(--ink-soft)'}`}>
        {label}
      </span>
      <span
        className={`shrink-0 tabular-nums ${
          strong ? 'text-[15px] font-semibold text-(--ink-strong)' : 'text-[13px] text-(--ink-body)'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

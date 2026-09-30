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

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;

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
        <SectionTitle>Mercados del modelo de puntos</SectionTitle>
        <p className="text-[13px] leading-relaxed text-[#7b828d]">{error}</p>
      </Panel>
    );
  }
  if (!data) return null;

  return (
    <Panel className="mb-4">
      <SectionTitle right={`${data.expectedGames.toFixed(1)} juegos esperados`}>
        Mercados del modelo de puntos
      </SectionTitle>

      <p className="mb-3 text-[13px] leading-relaxed text-[#7b828d]">
        Los cuatro salen de <strong className="text-[#9aa1ac]">dos números</strong>:{' '}
        {names[0]} gana el {pct(data.points.p1)} de los puntos con su saque contra{' '}
        {names[1]}, que gana el {pct(data.points.p2)} con el suyo. Todo lo demás es
        propagar eso por la cadena, así que no pueden contradecirse entre sí.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* --- Partido y set --- */}
        <div>
          <SectionTitle>Partido y set</SectionTitle>
          <Row label={`Gana ${names[0]}`} value={pct(data.matchProb)} strong />
          <Row label={`Gana ${names[1]}`} value={pct(1 - data.matchProb)} />
          <Row label={`${names[0]} gana un set cualquiera`} value={pct(data.setProb)} />
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
          <SectionTitle>Total de juegos</SectionTitle>
          {data.totals.map((t) => (
            <Row
              key={t.line}
              label={`Más de ${t.line}`}
              value={pct(t.over)}
              strong={Math.abs(t.line - data.expectedGames) < 1}
            />
          ))}
          <p className="mt-1 text-[11px] leading-relaxed text-[#5c636c]">
            Las líneas se centran en los juegos que el propio modelo espera. Una lista fija
            publicaría un 99 % para «más de 20.5» en un partido de 45 juegos, que no informa
            de nada.
          </p>
        </div>
      </div>

      {/* --- Hándicaps --- */}
      <div className="mt-3">
        <SectionTitle>Hándicap de juegos</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-left text-[13px] tabular-nums">
            <thead className="text-[11px] uppercase tracking-[0.06em] text-[#7b828d]">
              <tr>
                <th className="pb-1 font-medium">hándicap</th>
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
                    <tr key={h.handicap} className="border-t border-white/[0.05]">
                      <td className="py-1 text-[#9aa1ac]">
                        {h.handicap} / +{-h.handicap}
                      </td>
                      <td className="py-1 text-right text-[#e8eaed]">{pct(h.cover)}</td>
                      <td className="py-1 text-right text-[#e8eaed]">
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
        <Disclosure summary="De dónde salen esos dos números">
          <div className="space-y-2 text-[13px] leading-relaxed text-[#7b828d]">
            <p>
              Saque y resto de cada jugador estimados <strong>a la vez para todo el
              circuito</strong>, así que la calidad de los rivales de cada uno está
              descontada. Una media de carrera no lo está: se midió contra los rivales que
              le tocaron.
            </p>
            <ul className="space-y-0.5 tabular-nums">
              <li>
                media de la superficie: {(1 / (1 + Math.exp(-data.detail.mu)) * 100).toFixed(1)} %
              </li>
              <li>
                {names[0]}: saque {data.detail.serve1 >= 0 ? '+' : ''}
                {data.detail.serve1.toFixed(3)} · resto {data.detail.return1 >= 0 ? '+' : ''}
                {data.detail.return1.toFixed(3)} · δ superficie{' '}
                {data.detail.surfaceDelta1 >= 0 ? '+' : ''}
                {data.detail.surfaceDelta1.toFixed(3)}
              </li>
              <li>
                {names[1]}: saque {data.detail.serve2 >= 0 ? '+' : ''}
                {data.detail.serve2.toFixed(3)} · resto {data.detail.return2 >= 0 ? '+' : ''}
                {data.detail.return2.toFixed(3)} · δ superficie{' '}
                {data.detail.surfaceDelta2 >= 0 ? '+' : ''}
                {data.detail.surfaceDelta2.toFixed(3)}
              </li>
            </ul>
            <p>
              En logit: positivo es mejor que la media. El δ de superficie es cuánto se
              desvía este jugador de su propio perfil global en esta pista, encogido hacia
              cero según los partidos que tenga ahí.
            </p>
            <p className={data.model.stale ? 'text-amber-200/80' : undefined}>
              Modelo ajustado con {data.model.observations.toLocaleString('es')} actuaciones
              al saque de {data.model.players} jugadores, hace {data.model.ageDays} días.
              {data.model.stale && (
                <> Está viejo: reajústalo con <code>npm run update-data</code>.</>
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
      <span className={`truncate text-[13px] ${dim ? 'text-[#7b828d]' : 'text-[#9aa1ac]'}`}>
        {label}
      </span>
      <span
        className={`shrink-0 tabular-nums ${
          strong ? 'text-[15px] font-semibold text-[#e8eaed]' : 'text-[13px] text-[#c3c9d1]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

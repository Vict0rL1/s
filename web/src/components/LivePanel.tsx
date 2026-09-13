/**
 * El motor en vivo: metes el marcador, sale la probabilidad.
 *
 * ===========================================================================
 * POR QUÉ SE TECLEA EL MARCADOR
 * ===========================================================================
 * Porque no hay de dónde sacarlo. Un marcador en vivo punto a punto lo venden los
 * proveedores de datos deportivos, y esta app tiene una API de cuotas y archivos
 * históricos. Fingir un marcador automático sería fingir una conexión que no existe.
 *
 * Tecleado sigue siendo útil: la pregunta que contesta —«voy 4-5 y 30-40 abajo, ¿cuánto
 * me queda?»— se hace mirando un partido, con el marcador delante.
 *
 * ===========================================================================
 * LAS DOS PROBABILIDADES SE ENSEÑAN SIEMPRE
 * ===========================================================================
 * La base usa el saque de la carrera; la viva, el saque corregido con lo que va del
 * partido. Enseñar solo la segunda escondería de dónde sale el número, y la diferencia
 * entre las dos es justo lo que ha aportado la actualización bayesiana.
 */
import { useCallback, useEffect, useState } from 'react';
import { Panel, SectionTitle, Disclosure } from './ui';

interface Situation {
  kind: string;
  side: 1 | 2;
  label: string;
  detail: string;
}

interface Update {
  prior: number;
  posterior: number;
  observed: number | null;
  weight: number;
  n: number;
  z: number | null;
}

interface LiveResponse {
  base: number;
  live: number;
  describe: string;
  serve: { p1: number; p2: number; update1: Update; update2: Update };
  anomalies: { side: 1 | 2; text: string }[];
  leverage: { now: number; ifWins1: number; ifWins2: number; swingPp: number };
  situations: Situation[];
  market: { fair: [number, number]; overround: number; edgePp: number; note: string } | null;
  notes: string[];
  derived: { p1: number; p2: number; baseline: number } | null;
}

const PT = ['0', '15', '30', '40', 'AD'];

function Num({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  max: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.06em] text-[#7b828d]">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
        className="w-16 rounded-md bg-white/[0.06] px-2 py-1 text-[14px] tabular-nums text-[#e8eaed] ring-1 ring-inset ring-white/[0.1] focus:outline-none focus:ring-white/[0.25]"
      />
    </label>
  );
}

export default function LivePanel({
  tour,
  p1,
  p2,
  names,
  bestOf = 3,
}: {
  tour: string;
  p1: number;
  p2: number;
  names: [string, string];
  bestOf?: 3 | 5;
}) {
  const [sets, setSets] = useState<[number, number]>([0, 0]);
  const [games, setGames] = useState<[number, number]>([0, 0]);
  const [points, setPoints] = useState<[number, number]>([0, 0]);
  const [server, setServer] = useState<1 | 2>(1);
  const [tally, setTally] = useState<[[number, number], [number, number]]>([
    [0, 0],
    [0, 0],
  ]);
  const [odds, setOdds] = useState<[string, string]>(['', '']);
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const o1 = Number(odds[0]);
    const o2 = Number(odds[1]);
    fetch('/api/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tour,
        p1,
        p2,
        state: { sets, games, points, server, bestOf, inTiebreak: games[0] === 6 && games[1] === 6 },
        tally: [
          { won: tally[0][0], played: tally[0][1] },
          { won: tally[1][0], played: tally[1][1] },
        ],
        odds: o1 > 1 && o2 > 1 ? [o1, o2] : null,
      }),
    })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.invalid ? j.invalid.map((i: { reason: string }) => i.reason).join(' · ') : j.error);
        return j as LiveResponse;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(String(e instanceof Error ? e.message : e));
        setData(null);
      });
  }, [tour, p1, p2, sets, games, points, server, bestOf, tally, odds]);

  useEffect(load, [load]);

  const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;

  return (
    <Panel className="mb-4">
      <SectionTitle right={`al mejor de ${bestOf}`}>Motor en vivo</SectionTitle>

      {/* ---- El marcador ---- */}
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Sets 1" value={sets[0]} max={2} onChange={(n) => setSets([n, sets[1]])} />
        <Num label="Sets 2" value={sets[1]} max={2} onChange={(n) => setSets([sets[0], n])} />
        <span className="pb-1 text-[#5c636c]">·</span>
        <Num label="Juegos 1" value={games[0]} max={7} onChange={(n) => setGames([n, games[1]])} />
        <Num label="Juegos 2" value={games[1]} max={7} onChange={(n) => setGames([games[0], n])} />
        <span className="pb-1 text-[#5c636c]">·</span>
        <Num label="Pts saque" value={points[0]} max={8} onChange={(n) => setPoints([n, points[1]])} />
        <Num label="Pts resto" value={points[1]} max={8} onChange={(n) => setPoints([points[0], n])} />
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.06em] text-[#7b828d]">Saca</span>
          <select
            value={server}
            onChange={(e) => setServer(Number(e.target.value) as 1 | 2)}
            className="rounded-md bg-white/[0.06] px-2 py-1 text-[14px] text-[#e8eaed] ring-1 ring-inset ring-white/[0.1] focus:outline-none"
          >
            <option value={1}>{names[0]}</option>
            <option value={2}>{names[1]}</option>
          </select>
        </label>
      </div>
      <p className="mt-1.5 text-[12px] text-[#5c636c]">
        Los puntos van del <strong className="text-[#7b828d]">sacador</strong> primero:{' '}
        {points.map((p, i) => `${PT[Math.min(p, 4)]}${i === 0 ? '-' : ''}`).join('')} — 4 o más es
        ventaja.
      </p>

      {error ? (
        <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] p-2.5 text-[13px] text-rose-200">
          {error}
        </p>
      ) : data ? (
        <>
          <p className="mt-3 text-[13px] text-[#7b828d]">{data.describe}</p>

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Figure label={`${names[0]} — base`} value={pct(data.base)} hint="con el saque de la carrera" />
            <Figure
              label={`${names[0]} — viva`}
              value={pct(data.live)}
              hint={
                Math.abs(data.live - data.base) < 0.005
                  ? 'la actualización no la mueve'
                  : `${data.live > data.base ? '+' : ''}${((data.live - data.base) * 100).toFixed(1)} pp por el saque de hoy`
              }
            />
            <Figure
              label="Vale este punto"
              value={`${data.leverage.swingPp.toFixed(1)} pp`}
              hint={`${pct(data.leverage.ifWins1)} si lo gana · ${pct(data.leverage.ifWins2)} si no`}
            />
            {data.market ? (
              <Figure
                label="Mercado"
                value={pct(data.market.fair[0])}
                hint={`modelo ${data.market.edgePp > 0 ? '+' : ''}${data.market.edgePp.toFixed(1)} pp`}
              />
            ) : (
              <Figure label="Mercado" value="—" hint="pon las cuotas en vivo abajo" />
            )}
          </div>

          {data.situations.length > 0 && (
            <ul className="mt-3 space-y-1">
              {data.situations.map((s, i) => (
                <li key={i} className="text-[13px] leading-relaxed">
                  <span className="font-medium text-[#e8eaed]">
                    {names[s.side - 1]} · {s.label}
                  </span>{' '}
                  <span className="text-[#7b828d]">{s.detail}</span>
                </li>
              ))}
            </ul>
          )}

          {data.anomalies.map((a, i) => (
            <p
              key={i}
              className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-2.5 text-[13px] leading-relaxed text-amber-200/90"
            >
              <strong>{names[a.side - 1]}:</strong> {a.text}
            </p>
          ))}

          {data.market && (
            <p className="mt-2 text-[13px] leading-relaxed text-[#7b828d]">{data.market.note}</p>
          )}
          {data.notes.map((n, i) => (
            <p key={i} className="mt-2 text-[13px] leading-relaxed text-[#7b828d]">
              {n}
            </p>
          ))}
        </>
      ) : null}

      {/* ---- Lo que va del partido y las cuotas ---- */}
      <div className="mt-3 border-t border-white/[0.07] pt-3">
        <Disclosure summary="Puntos al saque de hoy y cuotas en vivo">
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-[#7b828d]">
              Cuántos puntos lleva ganados cada uno <em>con su saque</em> en este partido. Es lo
              que alimenta la actualización bayesiana: con κ = 63 puntos medidos, 40 puntos pesan
              un 39 % frente a la media de su carrera.
            </p>
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <span className="w-28 shrink-0 pb-1 text-[13px] text-[#c3c9d1]">{names[i]}</span>
                <Num
                  label="ganados"
                  value={tally[i][0]}
                  max={300}
                  onChange={(n) => {
                    const t = [...tally] as typeof tally;
                    t[i] = [n, t[i][1]];
                    setTally(t);
                  }}
                />
                <Num
                  label="servidos"
                  value={tally[i][1]}
                  max={300}
                  onChange={(n) => {
                    const t = [...tally] as typeof tally;
                    t[i] = [t[i][0], n];
                    setTally(t);
                  }}
                />
                {data && (
                  <span className="pb-1 text-[13px] tabular-nums text-[#7b828d]">
                    {pct((i === 0 ? data.serve.update1 : data.serve.update2).prior)} →{' '}
                    <span className="text-[#e8eaed]">
                      {pct((i === 0 ? data.serve.update1 : data.serve.update2).posterior)}
                    </span>{' '}
                    (peso hoy{' '}
                    {((i === 0 ? data.serve.update1 : data.serve.update2).weight * 100).toFixed(0)}{' '}
                    %)
                  </span>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-3">
              <span className="w-28 shrink-0 pb-1 text-[13px] text-[#c3c9d1]">Cuotas en vivo</span>
              {[0, 1].map((i) => (
                <label key={i} className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-[0.06em] text-[#7b828d]">
                    {names[i]}
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={odds[i]}
                    placeholder="2.10"
                    onChange={(e) => {
                      const o = [...odds] as [string, string];
                      o[i] = e.target.value;
                      setOdds(o);
                    }}
                    className="w-20 rounded-md bg-white/[0.06] px-2 py-1 text-[14px] tabular-nums text-[#e8eaed] ring-1 ring-inset ring-white/[0.1] placeholder:text-[#5c636c] focus:outline-none focus:ring-white/[0.25]"
                  />
                </label>
              ))}
            </div>
            <p className="text-[13px] leading-relaxed text-[#7b828d]">
              Una discrepancia grande contra la cuota en vivo{' '}
              <strong className="text-[#9aa1ac]">no es una ventaja</strong>: el mercado ve cosas
              que este modelo no puede ver —una lesión, un fisio en pista— y discrepa más justo
              cuando tiene razón.
            </p>
          </div>
        </Disclosure>
      </div>
    </Panel>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
        {label}
      </div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-[#e8eaed]">{value}</div>
      <div className="text-[11px] text-[#7b828d]">{hint}</div>
    </div>
  );
}

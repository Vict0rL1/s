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
import LivePuntoAPunto, { type UltimoJuego } from './LivePuntoAPunto';
import { useFeature } from '../lib/features';
import { conNodos, useI18n } from '../i18n';
import { pct as pctF, num as numF } from '../lib/formato';

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
      <span className="text-[11px] uppercase tracking-[0.06em] text-(--ink-muted)">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
        className="w-16 rounded-md bg-(--raised) px-2 py-1 text-[14px] tabular-nums text-(--ink-strong) ring-1 ring-inset ring-(--line) focus:outline-none focus:ring-(--line-strong)"
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
  const [ultimo, setUltimo] = useState<UltimoJuego | null>(null);
  const puntoAPunto = useFeature('tenis.enVivo');
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

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
        lastGame: ultimo ?? undefined,
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
  }, [tour, p1, p2, sets, games, points, server, bestOf, tally, odds, ultimo]);

  useEffect(load, [load]);

  const pct = (x: number): string => `${pctF(x, 1)}`;

  return (
    <Panel className="mb-4">
      <SectionTitle right={t('vivo.alMejorDe', { n: bestOf })}>{t('vivo.titulo')}</SectionTitle>

      {puntoAPunto && (
        <LivePuntoAPunto
          marcador={{ sets, games, points, server }}
          recuento={tally}
          ultimo={ultimo}
          bestOf={bestOf}
          names={names}
          onCambio={(m, r, u) => {
            setSets(m.sets);
            setGames(m.games);
            setPoints(m.points);
            setServer(m.server);
            setTally(r);
            setUltimo(u);
          }}
        />
      )}

      {/* ---- El marcador ---- */}
      <div className="flex flex-wrap items-end gap-3">
        <Num label={t('vivo.sets1')} value={sets[0]} max={2} onChange={(n) => setSets([n, sets[1]])} />
        <Num label={t('vivo.sets2')} value={sets[1]} max={2} onChange={(n) => setSets([sets[0], n])} />
        <span className="pb-1 text-(--ink-faint)">·</span>
        <Num label={t('vivo.juegos1')} value={games[0]} max={7} onChange={(n) => setGames([n, games[1]])} />
        <Num label={t('vivo.juegos2')} value={games[1]} max={7} onChange={(n) => setGames([games[0], n])} />
        <span className="pb-1 text-(--ink-faint)">·</span>
        <Num label={t('vivo.ptsSaque')} value={points[0]} max={8} onChange={(n) => setPoints([n, points[1]])} />
        <Num label={t('vivo.ptsResto')} value={points[1]} max={8} onChange={(n) => setPoints([points[0], n])} />
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.06em] text-(--ink-muted)">{t('vivo.saca')}</span>
          <select
            value={server}
            onChange={(e) => setServer(Number(e.target.value) as 1 | 2)}
            className="rounded-md bg-(--raised) px-2 py-1 text-[14px] text-(--ink-strong) ring-1 ring-inset ring-(--line) focus:outline-none"
          >
            <option value={1}>{names[0]}</option>
            <option value={2}>{names[1]}</option>
          </select>
        </label>
      </div>
      <p className="mt-1.5 text-[12px] text-(--ink-faint)">
        {conNodos(t('vivo.puntosOrden', { marcador: points.map((p, i) => `${PT[Math.min(p, 4)]}${i === 0 ? '-' : ''}`).join('') }), {
          sacador: <strong className="text-(--ink-muted)">{t('vivo.sacador')}</strong>,
        })}
      </p>

      {error ? (
        <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] p-2.5 text-[13px] text-rose-200">
          {error}
        </p>
      ) : data ? (
        <>
          <p className="mt-3 text-[13px] text-(--ink-muted)">{data.describe}</p>

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Figure label={t('vivo.base', { nombre: names[0] })} value={pct(data.base)} hint={t('vivo.baseNota')} />
            <Figure
              label={t('vivo.viva', { nombre: names[0] })}
              value={pct(data.live)}
              hint={
                Math.abs(data.live - data.base) < 0.005
                  ? t('vivo.sinMovimiento')
                  : t('vivo.porSaqueHoy', { dif: `${data.live > data.base ? '+' : ''}${numF((data.live - data.base) * 100, 1)}` })
              }
            />
            <Figure
              label={t('vivo.valePunto')}
              value={`${numF(data.leverage.swingPp, 1)} pp`}
              hint={t('vivo.siLoGana', { si: pct(data.leverage.ifWins1), no: pct(data.leverage.ifWins2) })}
            />
            {data.market ? (
              <Figure
                label={t('vivo.mercado')}
                value={pct(data.market.fair[0])}
                hint={t('vivo.modeloDif', { dif: `${data.market.edgePp > 0 ? '+' : ''}${numF(data.market.edgePp, 1)}` })}
              />
            ) : (
              <Figure label={t('vivo.mercado')} value="—" hint={t('vivo.ponCuotas')} />
            )}
          </div>

          {data.situations.length > 0 && (
            <ul className="mt-3 space-y-1">
              {data.situations.map((s, i) => (
                <li key={i} className="text-[13px] leading-relaxed">
                  <span className="font-medium text-(--ink-strong)">
                    {names[s.side - 1]} · {s.label}
                  </span>{' '}
                  <span className="text-(--ink-muted)">{s.detail}</span>
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
            <p className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">{data.market.note}</p>
          )}
          {data.notes.map((n, i) => (
            <p key={i} className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">
              {n}
            </p>
          ))}
        </>
      ) : null}

      {/* ---- Lo que va del partido y las cuotas ---- */}
      <div className="mt-3 border-t border-(--line) pt-3">
        <Disclosure summary={t('vivo.desplegable')}>
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-(--ink-muted)">
              {conNodos(t('vivo.explicaSaque'), { conSuSaque: <em>{t('vivo.conSuSaque')}</em> })}
            </p>
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <span className="w-28 shrink-0 pb-1 text-[13px] text-(--ink-body)">{names[i]}</span>
                <Num
                  label={t('vivo.ganados')}
                  value={tally[i][0]}
                  max={300}
                  onChange={(n) => {
                    const nuevo = [...tally] as typeof tally;
                    nuevo[i] = [n, nuevo[i][1]];
                    setTally(nuevo);
                  }}
                />
                <Num
                  label={t('vivo.servidos')}
                  value={tally[i][1]}
                  max={300}
                  onChange={(n) => {
                    const nuevo = [...tally] as typeof tally;
                    nuevo[i] = [nuevo[i][0], n];
                    setTally(nuevo);
                  }}
                />
                {data && (
                  <span className="pb-1 text-[13px] tabular-nums text-(--ink-muted)">
                    {pct((i === 0 ? data.serve.update1 : data.serve.update2).prior)} →{' '}
                    <span className="text-(--ink-strong)">
                      {pct((i === 0 ? data.serve.update1 : data.serve.update2).posterior)}
                    </span>{' '}
                    {t('vivo.pesoHoy', { peso: numF((i === 0 ? data.serve.update1 : data.serve.update2).weight * 100, 0) })}
                  </span>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-3">
              <span className="w-28 shrink-0 pb-1 text-[13px] text-(--ink-body)">{t('vivo.cuotasVivo')}</span>
              {[0, 1].map((i) => (
                <label key={i} className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-[0.06em] text-(--ink-muted)">
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
                    className="w-20 rounded-md bg-(--raised) px-2 py-1 text-[14px] tabular-nums text-(--ink-strong) ring-1 ring-inset ring-(--line) placeholder:text-(--ink-faint) focus:outline-none focus:ring-(--line-strong)"
                  />
                </label>
              ))}
            </div>
            <p className="text-[13px] leading-relaxed text-(--ink-muted)">
              {conNodos(t('vivo.discrepancia'), { noVentaja: <strong className="text-(--ink-soft)">{t('vivo.noVentaja')}</strong> })}
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
      <div className="break-words text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">
        {label}
      </div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-(--ink-strong)">{value}</div>
      <div className="text-[11px] text-(--ink-muted)">{hint}</div>
    </div>
  );
}

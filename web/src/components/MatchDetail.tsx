import type { Prediction, ServeStats } from '../lib/api';
import { pct, surfaceLabelEs, formatDate } from '../lib/format';
import { P1_COLOR, P2_COLOR } from './ProbabilityBars';

function Num({ value, plus = false }: { value: number; plus?: boolean }) {
  const sign = plus && value > 0 ? '+' : '';
  const color = value > 0 ? 'text-lime-400' : value < 0 ? 'text-rose-400' : 'text-slate-400';
  return (
    <span className={color}>
      {sign}
      {value}
    </span>
  );
}

/** Diverging bar for one reasoning factor: right = favours p1 (lime), left = p2 (sky). */
function FactorBar({ points, max }: { points: number; max: number }) {
  const frac = Math.max(-1, Math.min(1, points / max));
  const width = Math.abs(frac) * 50;
  return (
    <div className="relative h-3 w-full rounded bg-slate-700/50">
      <div className="absolute left-1/2 top-0 h-full w-px bg-slate-500" />
      <div
        className="absolute top-0 h-full rounded"
        style={
          frac >= 0
            ? { left: '50%', width: `${width}%`, backgroundColor: P1_COLOR }
            : { right: '50%', width: `${width}%`, backgroundColor: P2_COLOR }
        }
      />
    </div>
  );
}

function Last5({ results, color }: { results: boolean[]; color: string }) {
  if (results.length === 0) return <span className="text-slate-500">—</span>;
  return (
    <span className="inline-flex gap-1">
      {results.map((w, i) => (
        <span
          key={i}
          title={w ? 'Victoria' : 'Derrota'}
          className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold"
          style={{
            backgroundColor: w ? color : 'transparent',
            color: w ? '#0a0f1e' : '#f87171',
            border: w ? 'none' : '1px solid #f87171',
          }}
        >
          {w ? 'V' : 'D'}
        </span>
      ))}
    </span>
  );
}

/** Signal-by-signal breakdown, all in Elo points so the math is transparent. */
export default function MatchDetail({ prediction }: { prediction: Prediction }) {
  const { ratings, form, h2h, adjustedRatings, players, surface, market, reasoning } = prediction;
  const surfLabel = surfaceLabelEs(surface);
  const maxFactor = Math.max(50, ...reasoning.factors.map((f) => Math.abs(f.pointsForP1)));

  const rows: { label: string; p1: React.ReactNode; p2: React.ReactNode }[] = [
    { label: 'Elo general', p1: ratings.p1.overall, p2: ratings.p2.overall },
    { label: `Elo ${surfLabel.toLowerCase()}`, p1: ratings.p1.surface ?? '—', p2: ratings.p2.surface ?? '—' },
    { label: 'Efectivo (0.7·sup + 0.3·gen)', p1: ratings.p1.effective, p2: ratings.p2.effective },
    { label: 'Ajuste forma', p1: <Num value={form.p1.delta} plus />, p2: <Num value={form.p2.delta} plus /> },
    { label: 'Ajuste head-to-head', p1: <Num value={h2h.delta} plus />, p2: <Num value={-h2h.delta} plus /> },
    { label: 'Rating ajustado', p1: <strong>{adjustedRatings.p1}</strong>, p2: <strong>{adjustedRatings.p2}</strong> },
    { label: 'Prob. del modelo', p1: <strong>{pct(prediction.model.prob1, 1)}</strong>, p2: <strong>{pct(prediction.model.prob2, 1)}</strong> },
  ];

  return (
    <div className="mt-4 space-y-5 border-t border-slate-700/60 pt-4 text-sm">
      {/* WHY — reasoning */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Por qué</div>
        <p className="mb-3 text-slate-300">{reasoning.text}</p>
        <div className="space-y-2">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2">
              <span className="text-xs text-slate-400">{f.label}</span>
              <FactorBar points={f.pointsForP1} max={maxFactor} />
              <span
                className="text-right text-xs tabular-nums"
                style={{ color: f.pointsForP1 >= 0 ? P1_COLOR : P2_COLOR }}
              >
                {f.pointsForP1 > 0 ? '+' : ''}
                {f.pointsForP1}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-slate-500">
          <span>◀ ventaja {players.p2.name}</span>
          <span>ventaja {players.p1.name} ▶</span>
        </div>
      </div>

      {/* Player headers with rank */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <div className="text-slate-400">Señal</div>
        <div className="w-24 text-right font-semibold" style={{ color: P1_COLOR }}>
          {players.p1.name}
          <span className="ml-1 text-xs font-normal text-slate-500">#{prediction.ranks.p1}</span>
        </div>
        <div className="w-24 text-right font-semibold" style={{ color: P2_COLOR }}>
          {players.p2.name}
          <span className="ml-1 text-xs font-normal text-slate-500">#{prediction.ranks.p2}</span>
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[1fr_auto_auto] gap-2 -my-2">
          <div className="text-slate-400">{r.label}</div>
          <div className="w-24 text-right tabular-nums">{r.p1}</div>
          <div className="w-24 text-right tabular-nums">{r.p2}</div>
        </div>
      ))}

      {/* Form + surface record */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
          Forma reciente · récord en {surfLabel.toLowerCase()}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormBox
            name={players.p1.name}
            color={P1_COLOR}
            f={form.p1}
            last5={prediction.last5.p1}
            rec={prediction.surfaceRecord.p1}
          />
          <FormBox
            name={players.p2.name}
            color={P2_COLOR}
            f={form.p2}
            last5={prediction.last5.p2}
            rec={prediction.surfaceRecord.p2}
          />
        </div>
      </div>

      {/* Serve / return stats */}
      <ServeCompare
        p1Name={players.p1.name}
        p2Name={players.p2.name}
        s1={prediction.serve.p1}
        s2={prediction.serve.p2}
      />

      {/* Head-to-head */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-slate-500">Head-to-head</span>
          <span className="text-sm">
            <span style={{ color: P1_COLOR }}>{h2h.p1Wins}</span>
            <span className="text-slate-500"> – </span>
            <span style={{ color: P2_COLOR }}>{h2h.p2Wins}</span>
            <span className="ml-2 text-slate-500">({h2h.total} enfrentamientos)</span>
          </span>
        </div>
        {h2h.recent.length === 0 ? (
          <div className="text-slate-500">Sin enfrentamientos previos.</div>
        ) : (
          <ul className="space-y-1">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex items-center justify-between text-xs text-slate-300">
                <span>
                  {formatDate(m.date)} · {m.tourney_name} ({surfaceLabelEs(m.surface)}) {m.round}
                </span>
                <span className="text-slate-400">
                  ganó{' '}
                  <span style={{ color: m.winnerId === players.p1.id ? P1_COLOR : P2_COLOR }}>
                    {m.winnerId === players.p1.id ? players.p1.name : players.p2.name}
                  </span>{' '}
                  {m.score}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Market + expected score */}
      <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
        <div className="mb-2 uppercase tracking-wide text-slate-500">Mercado y marcador estimado</div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-300">
          {market.market && (
            <>
              <span>Cuotas: {market.market.odds1} / {market.market.odds2}</span>
              <span>
                Prob. implícita: {pct(market.market.implied1, 1)} / {pct(market.market.implied2, 1)}
              </span>
              <span>Overround: {pct(market.market.overround - 1, 1)}</span>
              {market.edge1 != null && (
                <span>
                  Ventaja modelo ({players.p1.name}):{' '}
                  <Num value={Math.round(market.edge1 * 1000) / 10} plus /> pp
                </span>
              )}
            </>
          )}
          <span className="w-full text-slate-400">
            Marcador probable: <strong className="text-slate-200">{prediction.expectedScore.likelySets} sets</strong>{' '}
            para {prediction.verdict.favoredName ?? '—'} — {prediction.expectedScore.note}
          </span>
        </div>
      </div>
    </div>
  );
}

function FormBox({
  name,
  color,
  f,
  last5,
  rec,
}: {
  name: string;
  color: string;
  f: Prediction['form']['p1'];
  last5: boolean[];
  rec: { wins: number; losses: number };
}) {
  const streakTxt =
    f.streak > 0 ? `${f.streak}V seguidas` : f.streak < 0 ? `${-f.streak}D seguidas` : '—';
  return (
    <div>
      <div className="mb-1 font-medium" style={{ color }}>
        {name}
      </div>
      <div className="mb-1">
        <Last5 results={last5} color={color} />
      </div>
      <div className="text-xs text-slate-400">Racha: {streakTxt}</div>
      <div className="text-xs text-slate-400">
        En superficie: {rec.wins}V–{rec.losses}D
      </div>
    </div>
  );
}

const SERVE_ROWS: { label: string; key: keyof ServeStats; suffix: string }[] = [
  { label: 'Aces por partido', key: 'acesPerMatch', suffix: '' },
  { label: 'Ace %', key: 'acePct', suffix: '%' },
  { label: '1er saque dentro %', key: 'firstInPct', suffix: '%' },
  { label: '1er saque ganado %', key: 'firstWonPct', suffix: '%' },
  { label: '2do saque ganado %', key: 'secondWonPct', suffix: '%' },
  { label: 'Break points salvados %', key: 'bpSavedPct', suffix: '%' },
];

function ServeCompare({
  p1Name,
  p2Name,
  s1,
  s2,
}: {
  p1Name: string;
  p2Name: string;
  s1: ServeStats;
  s2: ServeStats;
}) {
  if (s1.matches === 0 && s2.matches === 0) return null;
  const fmt = (v: number | null, suf: string) => (v == null ? '—' : `${v}${suf}`);
  return (
    <div className="rounded-lg bg-slate-800/50 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
        Saque y quiebre (promedio histórico)
      </div>
      <div className="space-y-1.5">
        {SERVE_ROWS.map((row) => {
          const v1 = s1[row.key];
          const v2 = s2[row.key];
          const better = v1 != null && v2 != null ? (v1 > v2 ? 1 : v1 < v2 ? 2 : 0) : 0;
          return (
            <div key={row.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-xs">
              <span
                className="w-16 text-right tabular-nums"
                style={{ color: better === 1 ? P1_COLOR : '#cbd5e1', fontWeight: better === 1 ? 600 : 400 }}
              >
                {fmt(v1 as number | null, row.suffix)}
              </span>
              <span className="text-center text-slate-500">{row.label}</span>
              <span
                className="w-16 tabular-nums"
                style={{ color: better === 2 ? P2_COLOR : '#cbd5e1', fontWeight: better === 2 ? 600 : 400 }}
              >
                {fmt(v2 as number | null, row.suffix)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>{p1Name}</span>
        <span>{p2Name}</span>
      </div>
    </div>
  );
}

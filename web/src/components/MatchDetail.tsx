import type { FitnessSignals, Prediction, ServeStats } from '../lib/api';
import { pct, surfaceLabelEs, formatDate } from '../lib/format';
import { P1_COLOR, P2_COLOR } from './ProbabilityBars';

function Num({ value, plus = false }: { value: number; plus?: boolean }) {
  const sign = plus && value > 0 ? '+' : '';
  const color = value > 0 ? 'text-emerald-400' : value < 0 ? 'text-rose-400' : 'text-[#9aa1ac]';
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
    <div className="relative h-3 w-full rounded bg-white/[0.06]">
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/20" />
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
  if (results.length === 0) return <span className="text-[#7b828d]">—</span>;
  return (
    <span className="inline-flex gap-1">
      {results.map((w, i) => (
        <span
          key={i}
          title={w ? 'Victoria' : 'Derrota'}
          className="inline-flex h-4 w-4 items-center justify-center rounded text-[11px] font-bold"
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
  // Most likely scoreline comes from the derived distribution — never a separate
  // heuristic, which could contradict the table right above it.
  const topOutcome = prediction.scorelines.outcomes[0];

  const rows: { label: string; p1: React.ReactNode; p2: React.ReactNode }[] = [
    { label: 'Elo general', p1: ratings.p1.overall, p2: ratings.p2.overall },
    { label: `Elo ${surfLabel.toLowerCase()}`, p1: ratings.p1.surface ?? '—', p2: ratings.p2.surface ?? '—' },
    { label: 'Efectivo (0.7·sup + 0.3·gen)', p1: ratings.p1.effective, p2: ratings.p2.effective },
    { label: 'Ajuste forma', p1: <Num value={form.p1.delta} plus />, p2: <Num value={form.p2.delta} plus /> },
    { label: 'Ajuste head-to-head', p1: <Num value={h2h.delta} plus />, p2: <Num value={-h2h.delta} plus /> },
    // Only shown when it bites: a zero row for every in-season match would be noise.
    ...(prediction.layoff.p1 !== 0 || prediction.layoff.p2 !== 0
      ? [
          {
            label: 'Ajuste inactividad',
            p1: <Num value={prediction.layoff.p1} plus />,
            p2: <Num value={prediction.layoff.p2} plus />,
          },
        ]
      : []),
    { label: 'Rating ajustado', p1: <strong>{adjustedRatings.p1}</strong>, p2: <strong>{adjustedRatings.p2}</strong> },
    { label: 'Prob. del modelo', p1: <strong>{pct(prediction.model.prob1, 1)}</strong>, p2: <strong>{pct(prediction.model.prob2, 1)}</strong> },
  ];

  return (
    <div className="mt-4 space-y-5 border-t border-white/[0.07] pt-4 text-[16px]">
      {/* HOW SOLID — qualifies every number below it, so it goes first */}
      <ReliabilityBlock prediction={prediction} />

      {/* WHY — reasoning */}
      <div className="rounded-lg bg-white/[0.04] p-3">
        <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">Por qué</div>
        <p className="mb-3 text-[#c3c9d1]">{reasoning.text}</p>
        <div className="space-y-2">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2">
              <span className="text-[14px] text-[#9aa1ac]">{f.label}</span>
              <FactorBar points={f.pointsForP1} max={maxFactor} />
              <span className="text-right text-[14px] tabular-nums text-[#c3c9d1]">
                {f.pointsForP1 > 0 ? '+' : ''}
                {f.pointsForP1}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-[#7b828d]">
          <span>◀ ventaja {players.p2.name}</span>
          <span>ventaja {players.p1.name} ▶</span>
        </div>
      </div>

      {/* Player headers with rank */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <div className="text-[#9aa1ac]">Señal</div>
        <div className="w-24 text-right font-semibold" style={{ color: P1_COLOR }}>
          {players.p1.name}
          <span className="ml-1 text-[14px] font-normal text-[#7b828d]">#{prediction.ranks.p1}</span>
        </div>
        <div className="w-24 text-right font-semibold" style={{ color: P2_COLOR }}>
          {players.p2.name}
          <span className="ml-1 text-[14px] font-normal text-[#7b828d]">#{prediction.ranks.p2}</span>
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[1fr_auto_auto] gap-2 -my-2">
          <div className="text-[#9aa1ac]">{r.label}</div>
          <div className="w-24 text-right tabular-nums">{r.p1}</div>
          <div className="w-24 text-right tabular-nums">{r.p2}</div>
        </div>
      ))}

      {/* Form + surface record */}
      <div className="rounded-lg bg-white/[0.04] p-3">
        <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">
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
      <div className="rounded-lg bg-white/[0.04] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[14px] uppercase tracking-wide text-[#7b828d]">Head-to-head</span>
          <span className="text-[16px]">
            <span style={{ color: P1_COLOR }}>{h2h.p1Wins}</span>
            <span className="text-[#7b828d]"> – </span>
            <span style={{ color: P2_COLOR }}>{h2h.p2Wins}</span>
            <span className="ml-2 text-[#7b828d]">({h2h.total} enfrentamientos)</span>
          </span>
        </div>
        {h2h.recent.length === 0 ? (
          <div className="text-[#7b828d]">Sin enfrentamientos previos.</div>
        ) : (
          <ul className="space-y-1">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex items-center justify-between text-[14px] text-[#c3c9d1]">
                <span>
                  {formatDate(m.date)} · {m.tourney_name} ({surfaceLabelEs(m.surface)}) {m.round}
                </span>
                <span className="text-[#9aa1ac]">
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

      {/* Scoreline distribution — real probabilities, not a single guess */}
      <div className="rounded-lg bg-white/[0.04] p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[14px] uppercase tracking-wide text-[#7b828d]">
            Probabilidad de cada marcador
          </span>
          <span className="text-[11px] text-[#7b828d]">
            al mejor de {prediction.scorelines.bestOf}
          </span>
        </div>
        <div className="space-y-1.5">
          {prediction.scorelines.outcomes.map((o) => (
            <div key={o.label} className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-2">
              <span className="truncate text-[14px] font-medium text-[#c3c9d1]" title={o.label}>
                {(o.side === 1 ? players.p1.name : players.p2.name).split(' ').slice(-1)[0]}{' '}
                {o.side === 1 ? o.label : o.label.split('-').reverse().join('-')}
              </span>
              <div className="h-3 overflow-hidden rounded bg-white/[0.06]">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${Math.max(1, o.probability * 100 * 2.4)}%`,
                    backgroundColor: o.side === 1 ? P1_COLOR : P2_COLOR,
                  }}
                />
              </div>
              <span className="text-right text-[14px] tabular-nums text-[#9aa1ac]">
                {pct(o.probability, 1)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 text-[14px] text-[#9aa1ac]">
          <span>Set decisivo: {pct(prediction.scorelines.decidingSetProbability, 1)}</span>
          <span>Sets corridos: {pct(prediction.scorelines.straightSetsProbability, 1)}</span>
        </div>
      </div>

      {/* Tournament history */}
      {prediction.tournamentHistory &&
        (prediction.tournamentHistory.p1.played > 0 ||
          prediction.tournamentHistory.p2.played > 0) && (
          <div className="rounded-lg bg-white/[0.04] p-3">
            <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">
              Historial en este torneo
            </div>
            <div className="grid grid-cols-2 gap-4 text-[14px]">
              {(['p1', 'p2'] as const).map((k) => {
                const h = prediction.tournamentHistory![k];
                const name = players[k].name;
                return (
                  <div key={k}>
                    <div
                      className="mb-0.5 font-medium"
                      style={{ color: k === 'p1' ? P1_COLOR : P2_COLOR }}
                    >
                      {name}
                    </div>
                    {h.played === 0 ? (
                      <div className="text-[#7b828d]">Nunca ha jugado aquí</div>
                    ) : (
                      <div className="text-[#9aa1ac]">
                        {h.wins}V–{h.losses}D
                        {h.titles > 0 && ` · ${h.titles} título${h.titles > 1 ? 's' : ''}`}
                        {h.titles === 0 && h.bestRound && ` · mejor ronda ${h.bestRound}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

      {/* Physical availability signals */}
      <FitnessBlock
        p1Name={players.p1.name}
        p2Name={players.p2.name}
        f1={prediction.fitness.p1}
        f2={prediction.fitness.p2}
      />

      {/* Market + expected score */}
      <div className="rounded-lg bg-white/[0.04] p-3 text-[14px]">
        <div className="mb-2 uppercase tracking-wide text-[#7b828d]">Mercado y marcador estimado</div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[#c3c9d1]">
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
          <span className="w-full text-[#9aa1ac]">
            Marcador más probable:{' '}
            <strong className="text-[#d5d9df]">
              {topOutcome
                ? `${topOutcome.side === 1 ? players.p1.name : players.p2.name} ${
                    topOutcome.side === 1
                      ? topOutcome.label
                      : topOutcome.label.split('-').reverse().join('-')
                  }`
                : '—'}
            </strong>{' '}
            ({topOutcome ? pct(topOutcome.probability, 1) : '—'}) · set decisivo{' '}
            {pct(prediction.scorelines.decidingSetProbability, 1)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * How much evidence sits behind the probability, as a range plus the reasons it
 * isn't tighter. Placed at the top of the breakdown because it qualifies every
 * figure below: the same 62% means different things with 800 matches of history
 * than with 8.
 */
function ReliabilityBlock({ prediction }: { prediction: Prediction }) {
  const rel = prediction.reliability;
  const { p1, p2 } = prediction.players;
  // Express the range from the favourite's side — that's the number the user
  // reads off the card, so the band has to qualify the same quantity.
  const favIsP1 = prediction.model.prob1 >= 0.5;
  const favProb = favIsP1 ? prediction.model.prob1 : prediction.model.prob2;
  const favName = favIsP1 ? p1.name : p2.name;
  const lo = Math.max(0, favProb - rel.marginPp / 100);
  const hi = Math.min(1, favProb + rel.marginPp / 100);

  const tone =
    rel.level === 'high'
      ? 'border-emerald-700/50 bg-emerald-950/30'
      : rel.level === 'medium'
        ? 'border-amber-700/50 bg-amber-950/30'
        : 'border-rose-700/50 bg-rose-950/30';

  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">
        Cuánta confianza merece este número
      </div>
      <p className="text-[#d5d9df]">
        <strong className="capitalize">{rel.label}</strong> — {favName} entre{' '}
        <strong className="tabular-nums">{pct(lo, 1)}</strong> y{' '}
        <strong className="tabular-nums">{pct(hi, 1)}</strong>{' '}
        <span className="text-[#9aa1ac]">(±{rel.marginPp} pp)</span>
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[14px]">
        <div className="min-w-0">
          <div className="truncate text-[#9aa1ac]" title={p1.name}>
            {p1.name}
          </div>
          <div className="tabular-nums text-[#d5d9df]">
            {rel.effectiveMatches.p1} partidos efectivos
          </div>
        </div>
        <div className="min-w-0">
          <div className="truncate text-[#9aa1ac]" title={p2.name}>
            {p2.name}
          </div>
          <div className="tabular-nums text-[#d5d9df]">
            {rel.effectiveMatches.p2} partidos efectivos
          </div>
        </div>
      </div>
      {rel.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rel.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-[14px] text-[#c3c9d1]">
              <span className="text-[#5c636c]">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[14px] text-[#7b828d]">
        «Partidos efectivos» pondera el historial igual que el Elo del partido: 70% los partidos en
        esta superficie, 30% el total. Menos partidos (o datos antiguos) ⇒ banda más ancha.
      </p>
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
      <div className="text-[14px] text-[#9aa1ac]">Racha: {streakTxt}</div>
      <div className="text-[14px] text-[#9aa1ac]">
        En superficie: {rec.wins}V–{rec.losses}D
      </div>
    </div>
  );
}

/**
 * Physical availability. These are traces injuries leave in results (retirements,
 * walkovers, absences, workload) — evidence, not a medical report. Labelled that
 * way so nobody reads it as "player X is injured".
 */
function FitnessBlock({
  p1Name,
  p2Name,
  f1,
  f2,
}: {
  p1Name: string;
  p2Name: string;
  f1: FitnessSignals;
  f2: FitnessSignals;
}) {
  const describe = (f: FitnessSignals) => {
    const items: string[] = [];
    if (f.retirements > 0) items.push(`${f.retirements} retiro${f.retirements > 1 ? 's' : ''}`);
    if (f.walkovers > 0) items.push(`${f.walkovers} W/O`);
    if (f.daysSinceLastMatch != null) items.push(`${f.daysSinceLastMatch} días sin jugar`);
    items.push(`${f.matchesLast30Days} partidos en 30 días`);
    return items;
  };

  return (
    <div className="rounded-lg bg-white/[0.04] p-3">
      <div className="mb-1 text-[14px] uppercase tracking-wide text-[#7b828d]">
        Señales físicas (de resultados, no diagnóstico)
      </div>
      <p className="mb-2 text-[11px] leading-snug text-[#7b828d]">
        Retiros, ausencias y carga de partidos. No existe una fuente abierta de lesiones actuales;
        esto son las huellas que dejan en los resultados.
      </p>
      <div className="grid grid-cols-2 gap-4 text-[14px]">
        {(
          [
            [p1Name, f1, P1_COLOR],
            [p2Name, f2, P2_COLOR],
          ] as [string, FitnessSignals, string][]
        ).map(([name, f, color]) => (
          <div key={name}>
            <div className="mb-0.5 font-medium" style={{ color }}>
              {name}
            </div>
            <ul className="text-[#9aa1ac]">
              {describe(f).map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        ))}
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
    <div className="rounded-lg bg-white/[0.04] p-3">
      <div className="mb-2 text-[14px] uppercase tracking-wide text-[#7b828d]">
        Saque y quiebre (promedio histórico)
      </div>
      <div className="space-y-1.5">
        {SERVE_ROWS.map((row) => {
          const v1 = s1[row.key];
          const v2 = s2[row.key];
          const better = v1 != null && v2 != null ? (v1 > v2 ? 1 : v1 < v2 ? 2 : 0) : 0;
          return (
            <div key={row.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-[14px]">
              <span
                className="w-16 text-right tabular-nums"
                style={{ color: better === 1 ? P1_COLOR : '#cbd5e1', fontWeight: better === 1 ? 600 : 400 }}
              >
                {fmt(v1 as number | null, row.suffix)}
              </span>
              <span className="text-center text-[#7b828d]">{row.label}</span>
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
      <div className="mt-1 flex justify-between text-[11px] text-[#7b828d]">
        <span>{p1Name}</span>
        <span>{p2Name}</span>
      </div>
    </div>
  );
}

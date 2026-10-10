// Piezas de MatchDetail.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { type FitnessSignals, type Prediction, type ServeStats } from '../lib/api';
import { pct } from '../lib/format';
import { num } from '../lib/formato';
import { P1_COLOR, P2_COLOR } from './ProbabilityBars';
import { conNodos, useI18n, type Clave } from '../i18n';

export function Last5({ results, color }: { results: boolean[]; color: string }) {
  const { t } = useI18n();
  if (results.length === 0) return <span className="text-(--ink-muted)">—</span>;
  return (
    <span className="inline-flex gap-1">
      {results.map((w, i) => (
        <span
          key={i}
          title={w ? t('det.victoria') : t('det.derrota')}
          className="inline-flex h-4 w-4 items-center justify-center rounded text-[11px] font-bold"
          style={{
            backgroundColor: w ? color : 'transparent',
            color: w ? '#0a0f1e' : 'var(--status-critical)',
            border: w ? 'none' : '1px solid var(--status-critical)',
          }}
        >
          {w ? t('det.v') : t('det.d')}
        </span>
      ))}
    </span>
  );
}

/**
 * How much evidence sits behind the probability, as a range plus the reasons it
 * isn't tighter. Placed at the top of the breakdown because it qualifies every
 * figure below: the same 62% means different things with 800 matches of history
 * than with 8.
 */
export function ReliabilityBlock({ prediction }: { prediction: Prediction }) {
  const rel = prediction.reliability;
  const { t } = useI18n();
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
      <div className="mb-2 text-[14px] uppercase tracking-wide text-(--ink-muted)">
        {t('det.cuantaConfianza')}
      </div>
      <p className="text-(--ink-body)">
        {conNodos(t('det.rango', { nombre: favName }), {
          nivel: <strong className="capitalize">{rel.label}</strong>,
          lo: <strong className="tabular-nums">{pct(lo, 1)}</strong>,
          hi: <strong className="tabular-nums">{pct(hi, 1)}</strong>,
          margen: <span className="text-(--ink-soft)">(±{num(rel.marginPp, 1)} pp)</span>,
        })}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[14px]">
        <div className="min-w-0">
          <div className="break-words text-(--ink-soft)" title={p1.name}>
            {p1.name}
          </div>
          <div className="tabular-nums text-(--ink-body)">
            {t('det.efectivos', { n: rel.effectiveMatches.p1 })}
          </div>
        </div>
        <div className="min-w-0">
          <div className="break-words text-(--ink-soft)" title={p2.name}>
            {p2.name}
          </div>
          <div className="tabular-nums text-(--ink-body)">
            {t('det.efectivos', { n: rel.effectiveMatches.p2 })}
          </div>
        </div>
      </div>
      {rel.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rel.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-[14px] text-(--ink-body)">
              <span className="text-(--ink-faint)">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[14px] text-(--ink-muted)">
        {t('det.efectivosNota')}
      </p>
    </div>
  );
}

export function FormBox({
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
  const { t } = useI18n();
  const streakTxt = f.streak > 0 ? t('det.seguidasV', { n: f.streak }) : f.streak < 0 ? t('det.seguidasD', { n: -f.streak }) : '—';
  return (
    <div>
      <div className="mb-1 font-medium" style={{ color }}>
        {name}
      </div>
      <div className="mb-1">
        <Last5 results={last5} color={color} />
      </div>
      <div className="text-[14px] text-(--ink-soft)">{t('det.racha', { r: streakTxt })}</div>
      <div className="text-[14px] text-(--ink-soft)">{t('det.enSuperficie', { v: rec.wins, d: rec.losses })}</div>
    </div>
  );
}

/**
 * Physical availability. These are traces injuries leave in results (retirements,
 * walkovers, absences, workload) — evidence, not a medical report. Labelled that
 * way so nobody reads it as "player X is injured".
 */
export function FitnessBlock({
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
  const { t } = useI18n();
  const describe = (f: FitnessSignals) => {
    const items: string[] = [];
    if (f.retirements > 0) items.push(t(f.retirements > 1 ? 'det.retirosN' : 'det.retiros1', { n: f.retirements }));
    if (f.walkovers > 0) items.push(t('det.wo', { n: f.walkovers }));
    if (f.daysSinceLastMatch != null) items.push(t('det.diasSinJugar', { n: f.daysSinceLastMatch }));
    items.push(t('det.partidos30', { n: f.matchesLast30Days }));
    return items;
  };

  return (
    <div className="rounded-lg bg-(--raised) p-3">
      <div className="mb-1 text-[14px] uppercase tracking-wide text-(--ink-muted)">
        {t('det.senalesFisicas')}
      </div>
      <p className="mb-2 text-[11px] leading-snug text-(--ink-muted)">{t('det.senalesNota')}</p>
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
            <ul className="text-(--ink-soft)">
              {describe(f).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export const SERVE_ROWS: { label: Clave; key: keyof ServeStats; suffix: string }[] = [
  { label: 'det.aces', key: 'acesPerMatch', suffix: '' },
  { label: 'det.acePct', key: 'acePct', suffix: '%' },
  { label: 'det.primerDentro', key: 'firstInPct', suffix: '%' },
  { label: 'det.primerGanado', key: 'firstWonPct', suffix: '%' },
  { label: 'det.segundoGanado', key: 'secondWonPct', suffix: '%' },
  { label: 'det.bpSalvados', key: 'bpSavedPct', suffix: '%' },
];

export function ServeCompare({
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
  const { t } = useI18n();
  if (s1.matches === 0 && s2.matches === 0) return null;
  const fmt = (v: number | null, suf: string) => (v == null ? '—' : `${num(v, 1)}${suf ? `\u00a0${suf}` : ''}`);
  return (
    <div className="rounded-lg bg-(--raised) p-3">
      <div className="mb-2 text-[14px] uppercase tracking-wide text-(--ink-muted)">
        {t('det.saqueTitulo')}
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
                style={{ color: better === 1 ? P1_COLOR : 'var(--ink-body)', fontWeight: better === 1 ? 600 : 400 }}
              >
                {fmt(v1 as number | null, row.suffix)}
              </span>
              <span className="text-center text-(--ink-muted)">{t(row.label)}</span>
              <span
                className="w-16 tabular-nums"
                style={{ color: better === 2 ? P2_COLOR : 'var(--ink-body)', fontWeight: better === 2 ? 600 : 400 }}
              >
                {fmt(v2 as number | null, row.suffix)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-(--ink-muted)">
        <span>{p1Name}</span>
        <span>{p2Name}</span>
      </div>
    </div>
  );
}

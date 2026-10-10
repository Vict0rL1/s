// Piezas de la tarjeta de la UFC: el nombre de cada luchador y el desglose del «¿por qué?».
import type { UfcFactor, UfcPrediction, UfcSide } from '../../lib/ufc';
import { AWAY_COLOR, HOME_COLOR, NEUTRAL_COLOR, pct } from '../../lib/theme';
import { CompareRow, FactorValue, FormDots, Panel, SectionTitle } from '../ui';
import { useI18n, type Clave } from '../../i18n';
import { num as numF } from '../../lib/formato';

const coma = (x: number, d = 0) => numF(x, d);
const record = (r: UfcSide['record']) => `${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}${r.noContests ? ` (${r.noContests} NC)` : ''}`;

/** El nombre de un luchador con su Elo, puesto y récord en la UFC. A la izquierda A, a la derecha B. */
export function FighterName({
  name,
  info,
  alignRight = false,
  onClick,
}: {
  name: string;
  info: Pick<UfcSide, 'elo' | 'eloRank' | 'record'> | null;
  alignRight?: boolean;
  onClick?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <button
        onClick={onClick}
        disabled={!onClick}
        className={`max-w-full text-[17px] font-semibold leading-tight break-words text-(--ink-strong) ${alignRight ? 'text-right' : 'text-left'} ${onClick ? 'hover:underline' : 'cursor-default'}`}
        title={onClick ? t('ufcc.verFicha') : name}
      >
        {name}
      </button>
      {info && (
        <div className="text-[13px] tabular-nums text-(--ink-muted)">
          Elo {Math.round(info.elo)}
          {info.eloRank != null && ` · #${info.eloRank}`} · {record(info.record)}
        </div>
      )}
    </div>
  );
}

/** Lo que dice cada rasgo, en claro. */
function textoFactor(t: (k: Clave, v?: Record<string, string | number>) => string, f: UfcFactor, a: UfcSide, b: UfcSide): string {
  const quien = f.pp > 0 ? a.name : b.name;
  const pp = coma(Math.abs(f.pp), 1);
  if (f.key === 'edad' && f.diff == null) return t('ufcd.sinEdad');
  if (f.key === 'alcance' && f.diff == null) return t('ufcd.sinAlcance');
  if (Math.abs(f.pp) < 0.05) return t('ufcd.neutro');
  return t('ufcd.ppPara', { pp, nombre: quien });
}

const ETIQUETA: Record<UfcFactor['key'], Clave> = {
  elo: 'ufcd.rasgo.elo',
  record: 'ufcd.rasgo.record',
  edad: 'ufcd.rasgo.edad',
  alcance: 'ufcd.rasgo.alcance',
  experiencia: 'ufcd.rasgo.experiencia',
};

export function Detail({ prediction }: { prediction: UfcPrediction }) {
  const { t } = useI18n();
  const { fighters, factors, h2h, market } = prediction;
  const a = fighters.home;
  const b = fighters.away;
  const formColors = { W: HOME_COLOR, D: NEUTRAL_COLOR, L: AWAY_COLOR };
  const edad = (x: UfcSide) => (x.age != null ? coma(x.age, 1) : '—');
  const cm = (v: number | null) => (v != null ? `${coma(v)} cm` : '—');

  return (
    <div className="space-y-3">
      <Panel>
        <SectionTitle>{t('det.porQue')}</SectionTitle>
        <ul className="mb-2 list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-(--ink-body)">
          {prediction.summary.bullets.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        {/* Cada rasgo con lo que aporta, en puntos de probabilidad para quien lo tiene a favor. */}
        <dl className="space-y-1 text-[13px]">
          {factors.map((f) => (
            <div key={f.key} className="flex justify-between gap-3">
              <dt className="text-(--ink-soft)">{t(ETIQUETA[f.key])}</dt>
              <dd className="text-right">
                <FactorValue color={f.pp >= 0 ? HOME_COLOR : AWAY_COLOR} neutral={Math.abs(f.pp) < 0.05 || f.diff == null}>
                  {textoFactor(t, f, a, b)}
                </FactorValue>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">{t('ufcd.rasgosNota')}</p>
      </Panel>

      <Panel>
        <SectionTitle>{t('ufcd.losDos')}</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
          <div />
          <div className="w-24 break-words text-right font-medium text-(--ink-strong)">{a.name}</div>
          <div className="w-24 break-words text-right font-medium text-(--ink-strong)">{b.name}</div>
          <CompareRow label="Elo" left={`${Math.round(a.elo)}${a.eloRank != null ? ` (#${a.eloRank})` : ''}`} right={`${Math.round(b.elo)}${b.eloRank != null ? ` (#${b.eloRank})` : ''}`} />
          <CompareRow label={t('ufcd.recordUfc')} left={record(a.record)} right={record(b.record)} />
          <CompareRow label={t('ufcd.edad')} left={edad(a)} right={edad(b)} />
          <CompareRow label={t('ufcd.alcance')} left={cm(a.reachCm)} right={cm(b.reachCm)} />
          <CompareRow label={t('ufcd.altura')} left={cm(a.heightCm)} right={cm(b.heightCm)} />
          <CompareRow label={t('ufcd.guardia')} left={a.stance ?? '—'} right={b.stance ?? '—'} />
          <CompareRow label={t('ufcd.categoria')} left={a.weightClass ?? '—'} right={b.weightClass ?? '—'} />
          <CompareRow label={t('ufcd.ultimaPelea')} left={a.lastDate ?? '—'} right={b.lastDate ?? '—'} />
          <CompareRow label={t('eq.ultimos5')} left={<FormDots results={a.last5} colors={formColors} />} right={<FormDots results={b.last5} colors={formColors} />} />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle right={h2h.length ? String(h2h.length) : undefined}>{t('ufcd.caraACara')}</SectionTitle>
        {h2h.length === 0 ? (
          <p className="text-[13px] text-(--ink-muted)">{t('ufcd.sinCaraACara')}</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {h2h.map((m) => (
              <li key={m.date} className="flex justify-between gap-3 text-(--ink-body)">
                <span className="shrink-0 text-(--ink-muted)">{m.date}</span>
                <span className="break-words text-right">
                  {m.result === 'W' ? t('ufcd.gano', { nombre: a.name }) : m.result === 'L' ? t('ufcd.gano', { nombre: b.name }) : m.result === 'D' ? t('ufcd.empate') : t('ufcd.sinResultado')}
                  {m.method ? ` · ${m.method}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <SectionTitle>{t('eq.deDondeNumero')}</SectionTitle>
        <p className="text-[13px] leading-relaxed text-(--ink-body)">{t('ufcd.deDonde', { n: prediction.context.ajustadaCon.toLocaleString('es'), anio: prediction.context.holdoutDesde })}</p>
      </Panel>

      {market.market && (
        <Panel>
          <SectionTitle right={t('eq.margenPct', { p: numF((market.market.overround - 1) * 100, 1) })}>{t('eq.mercado')}</SectionTitle>
          <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
            <div />
            <div className="w-20 text-right font-medium text-(--ink-strong)">{t('nhld.casa')}</div>
            <div className="w-20 text-right font-medium text-(--ink-strong)">{t('nhld.modelo')}</div>
            <CompareRow label={a.name} left={pct(market.market.home)} right={pct(prediction.final.home)} />
            <CompareRow label={b.name} left={pct(market.market.away)} right={pct(prediction.final.away)} />
          </dl>
          <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">{t('ufcd.desacuerdoNota')}</p>
        </Panel>
      )}

      <p className="text-[12px] leading-relaxed text-(--ink-muted)">{prediction.disclaimer}</p>
    </div>
  );
}

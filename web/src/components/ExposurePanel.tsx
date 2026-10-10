/**
 * La cartera: cuánto se pondría hoy, y cuánto riesgo es eso de verdad.
 *
 * ===========================================================================
 * LAS DOS CIFRAS SON DOS PREGUNTAS DISTINTAS
 * ===========================================================================
 * La SUMA INGENUA responde «¿cuánto puedo perder?», y no depende de la correlación: si
 * fallan todas, se pierde la suma, correlacionadas o no.
 *
 * El RIESGO EFECTIVO responde «¿cuánto riesgo estoy corriendo?», que es otra cosa.
 * Veinte apuestas independientes al 2 % no son una del 40 %, aunque el peor caso
 * coincida — y esa diferencia es la que decide el tamaño, porque es la que entra en el
 * crecimiento logarítmico.
 *
 * Enseñar solo una de las dos produce las dos formas de equivocarse: con la ingenua
 * sola se rechazan carteras diversificadas perfectamente sanas, y con la efectiva sola
 * se deja pasar una concentración capaz de vaciar el banco en una tarde.
 *
 * ===========================================================================
 * Y LA CORRELACIÓN QUE ESTE PANEL NO FINGE
 * ===========================================================================
 * Se midió si las apuestas de una misma liga y jornada se arrastran entre sí y la
 * respuesta fue que no (ρ = 0.0013, intervalo que incluye el cero, sobre 65.505
 * predicciones fuera de muestra). Así que cuando no hay vínculos que enseñar, este panel
 * lo dice y explica que es una medición — no un cálculo que se olvidó de hacer.
 */
import { useCallback, useEffect, useState } from 'react';
import { Panel, SectionTitle, Disclosure } from './ui';
import { money } from '../lib/bets';
import { conNodos, useI18n } from '../i18n';
import { pct as pctF, num as numF } from '../lib/formato';

interface BookEntry {
  key: string;
  label: string;
  league: string;
  day: string;
  soloStake: number;
  stake: number;
  fraction: number;
  edge: number;
  portfolioFactor: number;
  exposureFactor: number;
}

interface Book {
  bankroll: number;
  considered: number;
  demoOdds: number;
  priced: number;
  limits: {
    maxPerEvent: number;
    maxTotalExposure: number;
    maxExposurePerDay: number;
    maxExposurePerLeague: number;
  };
  loss: { today: number; week: number; dayBreached: boolean; weekBreached: boolean };
  entries: BookEntry[];
  blocked: number;
  naiveStake: number;
  totalStake: number;
  aggregate: { naive: number; effective: number; concentration: number; positions: number };
  links: { a: string; b: string; rho: number; reason: string }[];
  caps: { scope: string; limit: number; used: number; factor: number }[];
  notes: string[];
  correlation: {
    sameMatch: Record<string, { rho: number; lo: number; hi: number }>;
    sameLeagueDay: { rho: number; lo: number; hi: number };
    used: number;
    control: number;
    n: number;
  };
}

const pct = (x: number): string => `${pctF(x, 1)}`;

/**
 * El banco, que lo pone el usuario.
 *
 * Sin esto el panel enseñaría euros calculados sobre un banco inventado, y un «riesgo
 * efectivo de 30,15» que no es el de nadie es peor que no enseñar la cifra: se lee como
 * un dato. El valor por defecto es el mismo 1.000 del CLI, y se dice que lo es.
 */
const BANKROLL_KEY = 'predictor.bankroll';

function readBankroll(): number {
  try {
    const v = Number(localStorage.getItem(BANKROLL_KEY));
    return Number.isFinite(v) && v > 0 ? v : 1000;
  } catch {
    return 1000;
  }
}

export default function ExposurePanel() {
  const [bankroll, setBankroll] = useState<number>(readBankroll);
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t, idioma } = useI18n();

  useEffect(() => {
    try {
      localStorage.setItem(BANKROLL_KEY, String(bankroll));
    } catch {
      // Solo afecta a que haya que volver a escribirlo la próxima vez.
    }
  }, [bankroll]);

  const load = useCallback(() => {
    fetch(`/api/staking/book?bankroll=${bankroll}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b: Book) => {
        setBook(b);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [bankroll]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Panel className="mb-4">
        <SectionTitle>{t('cartera.titulo')}</SectionTitle>
        <p className="text-[13px] text-(--ink-muted)">{t('cartera.errorLeer', { error })}</p>
      </Panel>
    );
  }
  if (!book) return null;

  const { aggregate, correlation } = book;
  const cut = book.naiveStake - book.totalStake;

  return (
    <Panel className="mb-4">
      <SectionTitle
        right={
          <label className="flex items-center gap-1.5">
            <span>{t('cartera.banco')}</span>
            <input
              type="number"
              min={1}
              step={50}
              value={bankroll}
              onChange={(e) => setBankroll(Math.max(1, Number(e.target.value) || 1))}
              className="w-24 rounded-md bg-(--raised) px-2 py-0.5 text-right text-[13px] tabular-nums text-(--ink-strong) ring-1 ring-inset ring-(--line) focus:outline-none focus:ring-(--line-strong)"
              aria-label={t('cartera.tuBanco')}
            />
          </label>
        }
      >
        {t('cartera.titulo')}
      </SectionTitle>

      {book.entries.length === 0 ? (
        <p className="text-[14px] leading-relaxed text-(--ink-soft)">
          {t('cartera.ninguna')}{' '}
          {book.demoOdds > 0 && book.priced === 0
            ? conNodos(t('cartera.demo', { n: book.demoOdds }), { demostracion: <strong className="text-(--ink-body)">{t('cartera.demostracion')}</strong> })
            : book.loss.dayBreached || book.loss.weekBreached
              ? t('cartera.cortada')
              : t('cartera.bloqueadas', { n: book.blocked })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Figure
              label={t('cartera.sumaIngenua')}
              value={money(book.naiveStake)}
              hint={t('cartera.sumaNota', { p: pct(book.naiveStake / book.bankroll) })}
            />
            <Figure
              label={t('cartera.sePone')}
              value={money(book.totalStake)}
              hint={cut > 0.005 ? t('cartera.recortado', { p: pct(book.totalStake / book.bankroll), d: money(cut) }) : t('cartera.sinRecorte', { p: pct(book.totalStake / book.bankroll) })}
            />
            <Figure
              label={t('cartera.riesgo')}
              value={money(aggregate.effective * book.bankroll)}
              hint={t('cartera.riesgoNota', { p: pct(aggregate.effective) })}
            />
            <Figure
              label={t('cartera.concentracion')}
              value={`${pctF(aggregate.concentration, 0)}`}
              hint={aggregate.positions === 1 ? t('cartera.unaPosicion') : t('cartera.todoJunto')}
            />
          </div>

          <p className="mt-3 text-[13px] leading-relaxed text-(--ink-muted)">
            {conNodos(t('cartera.dosPreguntas'), { cuanto: <em>{t('cartera.cuantoPerder')}</em>, riesgo: <em>{t('cartera.cuantoRiesgo')}</em> })}
          </p>

          {book.caps.length > 0 && (
            <div className="mt-3">
              <SectionTitle>{t('cartera.topes')}</SectionTitle>
              <ul className="space-y-1">
                {book.caps.map((c) => (
                  <li key={c.scope} className="text-[13px] tabular-nums text-(--ink-soft)">
                    <span className="text-(--ink-body)">{c.scope}</span>
                    {t('cartera.topeLinea', { limite: money(c.limit), usado: money(c.used), factor: numF(c.factor, 2) })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3">
            <SectionTitle>{t('cartera.correlacion')}</SectionTitle>
            {book.links.length > 0 ? (
              <ul className="space-y-1">
                {book.links.map((l) => (
                  <li key={`${l.a}-${l.b}`} className="text-[13px] leading-relaxed text-(--ink-soft)">
                    <span
                      className={`tabular-nums ${l.rho > 0 ? 'text-amber-300/90' : 'text-emerald-300/90'}`}
                    >
                      ρ {l.rho >= 0 ? '+' : ''}
                      {numF(l.rho, 3)}
                    </span>{' '}
                    {l.reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] leading-relaxed text-(--ink-muted)">
                {conNodos(t('cartera.sinCorrelacion', { rho: numF(correlation.sameLeagueDay.rho, 4) }), {
                  medicion: <strong className="text-(--ink-soft)">{t('cartera.medicion')}</strong>,
                })}
              </p>
            )}
          </div>

          <div className="mt-3">
            <Disclosure summary={t('cartera.queSeMidio')}>
              <div className="space-y-2 text-[13px] leading-relaxed text-(--ink-muted)">
                <p>
                  {conNodos(t('cartera.sobre', { n: correlation.n.toLocaleString(idioma === 'en' ? 'en-GB' : 'es') }), { errores: <em>{t('cartera.errores')}</em> })}
                </p>
                <ul className="space-y-1 tabular-nums">
                  {Object.entries(correlation.sameMatch).map(([k, v]) => (
                    <li key={k}>
                      {t('cartera.mismoPartido', { par: k.replace('~', ' ~ '), rho: `${v.rho >= 0 ? '+' : ''}${numF(v.rho, 3)}`, lo: numF(v.lo, 3), hi: numF(v.hi, 3) })}
                    </li>
                  ))}
                  <li>
                    {t('cartera.distintos', {
                      rho: numF(correlation.sameLeagueDay.rho, 4),
                      lo: numF(correlation.sameLeagueDay.lo, 4),
                      hi: numF(correlation.sameLeagueDay.hi, 4),
                      usado: numF(correlation.used, 4),
                    })}
                  </li>
                  <li>{t('cartera.control', { rho: numF(correlation.control, 4) })}</li>
                </ul>
                <p>
                  {t('cartera.controlNota')}
                </p>
                <p>
                  {t('cartera.topesVigentes', {
                    evento: pct(book.limits.maxPerEvent),
                    total: pct(book.limits.maxTotalExposure),
                    dia: pct(book.limits.maxExposurePerDay),
                    liga: pct(book.limits.maxExposurePerLeague),
                  })}
                </p>
              </div>
            </Disclosure>
          </div>

          <div className="mt-3 overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[30rem] text-[13px] tabular-nums">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-(--ink-muted)">
                  <th className="pb-1 font-medium">{t('cartera.thApuesta')}</th>
                  <th className="pb-1 text-right font-medium">{t('cartera.thSolitario')}</th>
                  <th className="pb-1 text-right font-medium">{t('cartera.thCartera')}</th>
                  <th className="pb-1 text-right font-medium">{t('cartera.thFactor')}</th>
                </tr>
              </thead>
              <tbody>
                {book.entries.slice(0, 10).map((e) => (
                  <tr key={e.key} className="border-t border-(--line)">
                    <td className="py-1 pr-2 text-(--ink-body)">{e.label}</td>
                    <td className="py-1 text-right text-(--ink-muted)">{money(e.soloStake)}</td>
                    <td className="py-1 text-right text-(--ink-strong)">{money(e.stake)}</td>
                    <td className="py-1 text-right text-(--ink-muted)">
                      ×{numF((e.portfolioFactor * e.exposureFactor), 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {book.entries.length > 10 && (
              <p className="mt-1 text-[13px] text-(--ink-faint)">
                {t('cartera.mas', { n: book.entries.length - 10 })}
              </p>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">
        {label}
      </div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-(--ink-strong)">{value}</div>
      <div className="text-[11px] tabular-nums text-(--ink-muted)">{hint}</div>
    </div>
  );
}

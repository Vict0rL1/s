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

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;

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
        <SectionTitle>Exposición de la cartera</SectionTitle>
        <p className="text-[13px] text-[#7b828d]">No se pudo leer /api/staking/book: {error}</p>
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
            <span>banco</span>
            <input
              type="number"
              min={1}
              step={50}
              value={bankroll}
              onChange={(e) => setBankroll(Math.max(1, Number(e.target.value) || 1))}
              className="w-24 rounded-md bg-white/[0.06] px-2 py-0.5 text-right text-[13px] tabular-nums text-[#e8eaed] ring-1 ring-inset ring-white/[0.1] focus:outline-none focus:ring-white/[0.25]"
              aria-label="Tu banco"
            />
          </label>
        }
      >
        Exposición de la cartera
      </SectionTitle>

      {book.entries.length === 0 ? (
        <p className="text-[14px] leading-relaxed text-[#9aa1ac]">
          Ninguna apuesta se dimensionaría ahora mismo.{' '}
          {book.demoOdds > 0 && book.priced === 0 ? (
            <>
              Los {book.demoOdds} partidos del calendario llevan cuotas de{' '}
              <strong className="text-[#c3c9d1]">demostración</strong>, generadas por el propio
              modelo: apostar contra tu propia salida no es una ventaja, es una identidad. Hace
              falta una clave de The Odds API.
            </>
          ) : book.loss.dayBreached || book.loss.weekBreached ? (
            <>Operativa cortada por límite de pérdida.</>
          ) : (
            <>
              {book.blocked} candidatas se pararon en alguna de las ocho puertas. Nada que
              arriesgar hoy es un resultado válido.
            </>
          )}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Figure
              label="Suma ingenua"
              value={money(book.naiveStake)}
              hint={`${pct(book.naiveStake / book.bankroll)} · cada apuesta por su cuenta`}
            />
            <Figure
              label="Se pone"
              value={money(book.totalStake)}
              hint={
                cut > 0.005
                  ? `${pct(book.totalStake / book.bankroll)} · recortado ${money(cut)}`
                  : `${pct(book.totalStake / book.bankroll)} · sin recorte`
              }
            />
            <Figure
              label="Riesgo efectivo"
              value={money(aggregate.effective * book.bankroll)}
              hint={`${pct(aggregate.effective)} · una apuesta equivalente`}
            />
            <Figure
              label="Concentración"
              value={`${(aggregate.concentration * 100).toFixed(0)} %`}
              hint={aggregate.positions === 1 ? 'una sola posición' : '100 % = todo falla junto'}
            />
          </div>

          <p className="mt-3 text-[13px] leading-relaxed text-[#7b828d]">
            Las dos primeras responden <em>¿cuánto puedo perder?</em> y no dependen de la
            correlación: si fallan todas, se pierde la suma. La tercera responde{' '}
            <em>¿cuánto riesgo corro?</em>, que es otra pregunta.
          </p>

          {book.caps.length > 0 && (
            <div className="mt-3">
              <SectionTitle>Topes que recortaron</SectionTitle>
              <ul className="space-y-1">
                {book.caps.map((c) => (
                  <li key={c.scope} className="text-[13px] tabular-nums text-[#9aa1ac]">
                    <span className="text-[#c3c9d1]">{c.scope}</span> · tope {money(c.limit)} · ya
                    en juego {money(c.used)} → ×{c.factor.toFixed(2)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3">
            <SectionTitle>Correlación entre posiciones</SectionTitle>
            {book.links.length > 0 ? (
              <ul className="space-y-1">
                {book.links.map((l) => (
                  <li key={`${l.a}-${l.b}`} className="text-[13px] leading-relaxed text-[#9aa1ac]">
                    <span
                      className={`tabular-nums ${l.rho > 0 ? 'text-amber-300/90' : 'text-emerald-300/90'}`}
                    >
                      ρ {l.rho >= 0 ? '+' : ''}
                      {l.rho.toFixed(3)}
                    </span>{' '}
                    {l.reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] leading-relaxed text-[#7b828d]">
                Ninguna correlación relevante entre estas posiciones, y{' '}
                <strong className="text-[#9aa1ac]">eso es una medición, no un olvido</strong>: se
                comprobó si las apuestas de una misma liga y jornada se arrastran entre sí y salió
                ρ&nbsp;=&nbsp;{correlation.sameLeagueDay.rho.toFixed(4)}, con un intervalo que
                incluye el cero. La que sí existe es entre mercados del mismo partido, y aquí solo
                hay una apuesta por encuentro.
              </p>
            )}
          </div>

          <div className="mt-3">
            <Disclosure summary="Qué se midió, y en qué se convierte">
              <div className="space-y-2 text-[13px] leading-relaxed text-[#7b828d]">
                <p>
                  Sobre {correlation.n.toLocaleString('es')} predicciones fuera de muestra del
                  Dixon-Coles, comparando los <em>errores</em> del modelo entre pares de apuestas.
                </p>
                <ul className="space-y-1 tabular-nums">
                  {Object.entries(correlation.sameMatch).map(([k, v]) => (
                    <li key={k}>
                      mismo partido · {k.replace('~', ' ~ ')}: ρ {v.rho >= 0 ? '+' : ''}
                      {v.rho.toFixed(3)} [{v.lo.toFixed(3)}, {v.hi.toFixed(3)}]
                    </li>
                  ))}
                  <li>
                    partidos distintos, misma liga y jornada: ρ{' '}
                    {correlation.sameLeagueDay.rho.toFixed(4)} [
                    {correlation.sameLeagueDay.lo.toFixed(4)},{' '}
                    {correlation.sameLeagueDay.hi.toFixed(4)}] — se usa{' '}
                    {correlation.used.toFixed(4)}, el extremo alto
                  </li>
                  <li>control (ligas y días distintos): ρ {correlation.control.toFixed(4)}</li>
                </ul>
                <p>
                  El control es lo que convierte ese cero en un resultado y no en una excusa: el
                  estimador detecta correlación cuando la hay — el 0.558 de arriba lo demuestra —
                  así que el cero es una medición, no falta de potencia.
                </p>
                <p>
                  Topes vigentes: {pct(book.limits.maxPerEvent)} por evento,{' '}
                  {pct(book.limits.maxTotalExposure)} en total,{' '}
                  {pct(book.limits.maxExposurePerDay)} por día,{' '}
                  {pct(book.limits.maxExposurePerLeague)} por liga.
                </p>
              </div>
            </Disclosure>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-[13px] tabular-nums">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-[#7b828d]">
                  <th className="pb-1 font-medium">apuesta</th>
                  <th className="pb-1 text-right font-medium">en solitario</th>
                  <th className="pb-1 text-right font-medium">de cartera</th>
                  <th className="pb-1 text-right font-medium">factor</th>
                </tr>
              </thead>
              <tbody>
                {book.entries.slice(0, 10).map((e) => (
                  <tr key={e.key} className="border-t border-white/[0.05]">
                    <td className="py-1 pr-2 text-[#c3c9d1]">{e.label}</td>
                    <td className="py-1 text-right text-[#7b828d]">{money(e.soloStake)}</td>
                    <td className="py-1 text-right text-[#e8eaed]">{money(e.stake)}</td>
                    <td className="py-1 text-right text-[#7b828d]">
                      ×{(e.portfolioFactor * e.exposureFactor).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {book.entries.length > 10 && (
              <p className="mt-1 text-[13px] text-[#5c636c]">
                … y {book.entries.length - 10} más
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
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
        {label}
      </div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-[#e8eaed]">{value}</div>
      <div className="text-[11px] tabular-nums text-[#7b828d]">{hint}</div>
    </div>
  );
}

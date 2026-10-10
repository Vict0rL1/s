// Piezas compartidas de la interfaz: picks. Partido de ui/index.tsx en la Fase 5 (ningún import cambia: index.tsx reexporta).
import { useState } from 'react';
import { INK, PROFIT_TEXT, LOSS_TEXT } from '../../lib/theme';
import { relativeTime, shortTime } from '../../lib/format';
import { StatusMark } from '../icons';
import { conNodos, localeDe, useI18n, type Clave, type Traducir } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

// Los nombres de mercado y selección son también claves de lib/picks (tasas base, orden): se
// traducen al pintarlos, no en los datos.
const MERCADO: Record<string, Clave> = {
  'Doble oportunidad': 'pick.mercado.dobleOportunidad',
  'Total de goles': 'pick.mercado.totalGoles',
  'Ambos marcan': 'pick.mercado.ambosMarcan',
  Ganador: 'pick.mercado.ganador',
  Hándicap: 'pick.mercado.handicap',
  'Línea de carreras': 'pick.mercado.lineaCarreras',
  'Total de puntos': 'pick.mercado.totalPuntos',
  'Total de carreras': 'pick.mercado.totalCarreras',
};
const mercadoPick = (t: Traducir, m: string) => (MERCADO[m] ? t(MERCADO[m]) : m);
function seleccionPick(t: Traducir, s: string): string {
  if (s === 'Empate') return t('fbc.empateBarra');
  if (s === 'Sí') return t('pick.sel.si');
  const doble = /^(.*) o empate$/.exec(s);
  return doble ? t('pick.sel.oEmpate', { nombre: doble[1] }) : s;
}
/**
 * "Lo que el modelo destacaría" — the ranked markets panel.
 *
 * WHY IT EXISTS. Each tab shows a card per match, which answers "what about this
 * game". It never answered the question a reader actually arrives with: of all
 * twenty of these, which ones is the model saying something UNUSUAL about? Finding
 * that meant reading every card, which is work the app should be doing.
 *
 * WHAT IT SHOWS AND WHY, in this order per row: the selection (the thing you would
 * write on a slip), the model's probability, the bookmaker's de-vigged one, and the
 * gap. Then the fair odds — the price at which the model considers the bet
 * break-even — because that is the one number a bookmaker never shows you and it is
 * the only way to tell a generous price from a mean one.
 *
 * WHAT IT REFUSES. Ranking is by disagreement with the market, never by the
 * model's confidence, whenever prices exist: "the favourite wins at 92 %" is a
 * price, not a finding. With no prices the panel says so out loud and switches to
 * confidence, which is a weaker claim and is labelled as one — see lib/picks.ts.
 *
 * And the caveat sits ABOVE the list, not under it. On the NFL tab that caveat says
 * the model does not beat the closing line, which is measured and true, and a
 * reader who scrolls straight to the numbers should hit it first.
 */
/**
 * La advertencia del panel de sugerencias: la primera frase a la vista, el resto a un clic.
 *
 * ===========================================================================
 * ERA UN MURO Y POR ESO NO LO LEÍA NADIE
 * ===========================================================================
 * Este texto es de lo más valioso de la app —dice contra qué se ha medido el modelo, con
 * cuántos partidos y qué NO demuestra— y estaba en un solo párrafo de hasta doce líneas,
 * en ámbar, encima de la tabla y antes de cualquier dato. En fútbol ocupaba media
 * pantalla. El resultado práctico de un muro de texto es que se salta entero, así que el
 * formato estaba consiguiendo lo contrario de lo que pretendía.
 *
 * No se recorta ni una palabra: se ordena. La PRIMERA FRASE queda a la vista, porque es
 * la que lleva el veredicto («este modelo NO le gana a la línea de cierre»), y el resto
 * —los números, los p-valores, las condiciones— se despliega. Quien quiera la evidencia
 * la tiene a un clic; quien solo quiera saber si fiarse, ya lo sabe.
 *
 * El desglose se corta por la primera frase completa, no por un número de caracteres:
 * cortar a mitad de frase produce un resumen que miente por omisión.
 */
function CaveatNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  // Busca el primer punto seguido de espacio y mayúscula. Un `.` dentro de «0.2115» o de
  // «p = 0,0005» no separa frases, y partir ahí dejaría a la vista media cifra.
  const corte = text.search(/\.\s+(?=[A-ZÁÉÍÓÚÑ¡¿«])/);
  const primera = corte > 0 ? text.slice(0, corte + 1) : text;
  const resto = corte > 0 ? text.slice(corte + 1).trim() : '';

  return (
    <div className="px-4 py-3">
      <p className="text-[13px] leading-relaxed text-amber-200/80">
        <StatusMark estado="aviso" color="#fcd34d" />
        {primera}
      </p>
      {resto && (
        <>
          {open && (
            <p className="mt-2 text-[13px] leading-relaxed text-amber-200/70">{resto}</p>
          )}
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-1.5 text-[12px] font-medium text-amber-200/60 underline-offset-2 hover:text-amber-200 hover:underline"
          >
            {open ? t('discrepancias.ocultar') : t('discrepancias.verMedido')}
          </button>
        </>
      )}
    </div>
  );
}

export function PicksPanel({
  picks,
  basis,
  caveat,
  demoOdds = false,
  confidenceReason,
  considered,
  stake,
  onStakeChange,
}: {
  picks: {
    id: string; when: string; match: string; market: string; selection: string;
    modelProb: number; marketProb: number | null; odds: number | null;
    edge: number | null; fairOdds: number;
  }[];
  /** 'edge' = ranked against real prices. 'confidence' = no prices to compare. */
  basis: 'edge' | 'confidence';
  caveat: string;
  /**
   * True when the only prices available were generated by this app from the model
   * itself (no API key).
   *
   * Worth its own flag rather than folding into `basis`, because "there is no
   * market" and "the market you see is our own model with a margin on it" send the
   * reader to two different actions: wait for a price, or go get an API key.
   */
  demoOdds?: boolean;
  /**
   * Why this list is ordered by probability rather than by edge, when the caller
   * knows a better reason than "there were no prices".
   *
   * The NFL has prices — the closing line, on every game — and still ranks by
   * probability, because the measurement says that line beats the model. Without
   * this the panel claimed "sin cuotas que comparar" while displaying a full market
   * column two centimetres to the right.
   */
  confidenceReason?: string;
  /**
   * Candidates before filtering. Zero means there was nothing to have an opinion
   * about, which is not the same as having one and agreeing — see rankPicks.
   */
  considered?: number;
  /** Stake used for the "devolvería" column, so the figure is in the reader's money. */
  stake: number;
  onStakeChange: (n: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const { t, idioma } = useI18n();
  // Nothing on the slate: say nothing. The message below is a claim ABOUT a model's
  // agreement with prices, and with no matches there is neither. The tab renders its
  // own explanation of why it is empty.
  if (considered === 0) return null;
  // "The model agrees with every price" is a finding, not a reason to render
  // nothing — an empty space where a panel was reads as a bug, and the reader is
  // left wondering whether it failed to load.
  if (picks.length === 0) {
    return (
      <p className="mb-6 rounded-xl border border-(--line) bg-(--tint) px-4 py-3 text-[14px] leading-relaxed text-(--ink-soft)">
        {conNodos(t('discrepancias.noDiscrepa'), { noDiscrepa: <strong className="font-semibold text-(--ink-body)">{t('discrepancias.noDiscrepaPalabras')}</strong> })}
      </p>
    );
  }

  const pct = (p: number) => `${pctF(p, 1)}`;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-(--line) bg-(--tint)">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-(--tint)"
      >
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold text-(--ink-strong)">
            {basis === 'edge' ? t('discrepancias.tituloEdge') : t('discrepancias.tituloConfianza')}
          </span>
          <span className="block text-[13px] text-(--ink-muted)">
            {basis === 'edge'
              ? t(picks.length === 1 ? 'discrepancias.mercados1' : 'discrepancias.mercadosN', { n: picks.length })
              : confidenceReason
                ? confidenceReason
                : demoOdds
                  ? t('discrepancias.demo')
                  : t('discrepancias.sinCuotas')}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-(--ink-muted)">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-(--line)">
          <CaveatNote text={caveat} />

          {/* Horizontal scroll on the table only, never the page — a wide row must
              not be able to push the whole layout sideways on a phone. */}
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[46rem] border-collapse text-[14px]">
              <thead>
                <tr className="border-y border-(--line) text-left text-[12px] uppercase tracking-[0.05em] text-(--ink-muted)">
                  <th className="px-4 py-2 font-medium">{t('discrepancias.partido')}</th>
                  <th className="px-3 py-2 font-medium">{t('discrepancias.apuesta')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('discrepancias.modelo')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('discrepancias.mercado')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('discrepancias.dif')}</th>
                  <th className="px-3 py-2 text-right font-medium" title={t('discrepancias.cuotaMinimaNota')}>
                    {t('discrepancias.cuotaMinima')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">{t('discrepancias.devolveria')}</th>
                </tr>
              </thead>
              <tbody>
                {picks.map((p, i) => (
                  <tr
                    key={`${p.id}-${p.market}-${p.selection}-${i}`}
                    className="border-b border-(--line) last:border-0"
                  >
                    <td className="max-w-[14rem] px-4 py-2.5">
                      <span className="block break-words text-(--ink-body)">{p.match}</span>
                      <span className="block text-[12px] text-(--ink-muted)">
                        {shortTime(p.when, idioma)} · {relativeTime(p.when, new Date(), idioma)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="block font-semibold text-(--ink-strong)">{seleccionPick(t, p.selection)}</span>
                      <span className="block text-[12px] text-(--ink-muted)">{mercadoPick(t, p.market)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-(--ink-strong)">
                      {pct(p.modelProb)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-(--ink-soft)">
                      {p.marketProb == null ? '—' : pct(p.marketProb)}
                    </td>
                    <td
                      className="px-3 py-2.5 text-right font-semibold tabular-nums"
                      // Una diferencia que REDONDEA A CERO no es una discrepancia, y
                      // pintarla de rojo la anuncia como un problema. La NFL enseñaba
                      // filas con «-0.0 pp» en rojo: el modelo y el precio coincidían
                      // hasta la décima, que es justo lo contrario de lo que el color
                      // grita. Por debajo de media décima, tinta neutra.
                      style={{
                        color:
                          p.edge == null
                            ? INK.muted
                            : Math.abs(p.edge) < 0.005
                              ? INK.muted
                              : p.edge > 0
                                ? PROFIT_TEXT
                                : LOSS_TEXT,
                      }}
                    >
                      {p.edge == null
                        ? '—'
                        : Math.abs(p.edge) < 0.005
                          ? '0,0 pp'
                          : `${p.edge > 0 ? '+' : ''}${numF(p.edge * 100, 1)} pp`}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-(--ink-body)">
                      {numF(p.fairOdds, 2)}
                      {p.odds != null && (
                        <span
                          className="ml-1.5 text-[12px]"
                          // Green means "the offered price is above what the model
                          // thinks it is worth". With demo odds — generated FROM the
                          // model — that comparison is circular, so the colour is
                          // withheld rather than flattering our own arithmetic.
                          style={{
                            color: !demoOdds && p.odds > p.fairOdds ? PROFIT_TEXT : INK.muted,
                          }}
                          title={t('discrepancias.cuotaOfrecida', { c: numF(p.odds, 2) })}
                        >
                          ({numF(p.odds, 2)})
                        </span>
                      )}
                    </td>
                    {/* Only at a REAL price. At the fair odds the return is
                        stake ÷ probability, which is break-even BY DEFINITION — so
                        printing it would be arithmetic dressed up as a forecast.
                        What is useful with no price is the minimum odds to look for,
                        and that is already in the column to the left. */}
                    <td className="px-4 py-2.5 text-right tabular-nums text-(--ink-body)">
                      {p.odds == null ? (
                        <span className="text-[13px] text-(--ink-muted)">
                          {t('discrepancias.busca', { c: numF(p.fairOdds, 2) })}
                        </span>
                      ) : (
                        (stake * p.odds).toLocaleString(localeDe(idioma), { maximumFractionDigits: 0 })
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-(--line) px-4 py-3">
            <label htmlFor="picks-stake" className="text-[13px] text-(--ink-soft)">
              {t('discrepancias.conApuesta')}
            </label>
            <input
              id="picks-stake"
              type="number"
              min={1}
              step={1}
              value={stake}
              onChange={(e) => onStakeChange(Math.max(1, Number(e.target.value) || 1))}
              className="w-28 rounded-lg bg-(--raised) px-2.5 py-1.5 text-right text-[14px] tabular-nums text-(--ink-strong) ring-1 ring-inset ring-(--line) focus:outline-none focus:ring-2 focus:ring-(--line-strong)"
            />
            <span className="text-[13px] text-(--ink-muted)">
              {t('discrepancias.noBeneficio')}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

// "Lo que el modelo destacaría": concrete markets, ranked.
//
// ===========================================================================
// WHAT THIS IS AND WHAT IT REFUSES TO BE
// ===========================================================================
// Every tab already shows a full card per match. What it did not show is the
// question a reader actually arrives with: OF ALL of these, which ones is the
// model saying something unusual about? Reading twenty cards to find out is work
// the app should be doing.
//
// So each pick is a named market on a named match, with the model's probability,
// the bookmaker's de-vigged probability, and the gap between them.
//
// Three rules it does not break:
//
//   1. NOTHING IS INVENTED. The markets here are the ones the models actually
//      produce. The betting slips this was built from also contain "total
//      córneres over 7.5" and "gana cualquier mitad" — this app holds no corner
//      counts and no half-time scores, so those markets are absent rather than
//      guessed. A plausible-looking number with nothing behind it is the worst
//      thing this file could output.
//
//   2. THE RANKING IS THE EDGE AGAINST THE MARKET, when there is a market. Not
//      the model's confidence. "Bayern beats a bottom club at 92 %" is not a
//      finding, it is a price. The only defensible ordering is where the model
//      and the bookmaker DISAGREE, because that is the only place the model can
//      be adding anything. With no odds to compare (demo fixtures, or a league
//      the feed does not price) the list says so in as many words and falls back
//      to confidence, which is a weaker thing and is labelled as one.
//
//   3. DEMO PRICES ARE NOT A MARKET. Without an API key the app invents fixture
//      odds BY TAKING THE MODEL'S OWN PROBABILITY and adding a bookmaker margin.
//      De-vigging those returns the model's number back, so the edge is zero by
//      construction — and a panel reporting "no disagreement" from that would be
//      reporting on its own arithmetic. So a synthetic price counts as NO price,
//      the panel falls back to confidence, and it says which.
//
//   4. AN EDGE IS NOT A PROFIT. A model that is 3 pp better calibrated than a
//      bookmaker still loses to the margin if it is 3 pp wrong in the other
//      direction, and the NFL backtest in this very repo says plainly that its
//      model does not beat the closing line. Each sport carries its own caveat
//      to the panel — see `CAVEATS` — and the UI prints it above the list, not
//      in a footnote.
//
// Partido en la Fase 7: el núcleo en picksNucleo.ts, las tablas en picksDatos.ts y cada deporte en
// picksDeportes.ts. Este fichero sigue siendo la puerta: nadie importa de las piezas.

export { MIN_EDGE, MAX_PICKS, realMarket, devig2, rankPicks, type Pick } from './picksNucleo';
export { CAVEATS } from './picksDatos';
export { footballPicks, baseballPicks, basketballPicks, nflPicks, nhlPicks, ufcPicks, tennisPicks } from './picksDeportes';

/**
 * The stake used for the "devolvería" column, shared by every tab.
 *
 * One number, not one per sport: somebody who stakes 200 on football stakes 200 on
 * baseball, and making them retype it on each tab would be the app forgetting
 * something it was just told. Persisted, because it is a fact about the reader
 * rather than about the page.
 */
export const STAKE_KEY = 'predictor.picks.stake';
export const DEFAULT_STAKE = 100;

export function readStake(): number {
  try {
    const n = Number(localStorage.getItem(STAKE_KEY));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STAKE;
  } catch {
    // Private browsing can throw on access, not just on write.
    return DEFAULT_STAKE;
  }
}

export function writeStake(n: number): void {
  try {
    localStorage.setItem(STAKE_KEY, String(n));
  } catch {
    // Nothing to do: the number still works for this session.
  }
}

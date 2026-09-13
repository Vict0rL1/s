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

/** One suggested market on one match. */
export interface Pick {
  /** Match id, so the UI can point back at the card. */
  id: string;
  /** ISO kick-off. */
  when: string;
  /** "Toluca vs Necaxa" */
  match: string;
  /**
   * La liga, cuando el deporte la tiene. Solo la usa `lift`, para elegir la tabla de
   * referencia del escalón correcto; los deportes sin escalones la dejan sin poner.
   */
  league?: string;
  /** "Total de goles", "Doble oportunidad", "Ganador"… */
  market: string;
  /** The selection: "Over 2.5", "Toluca o empate", "Ambos marcan: Sí". */
  selection: string;
  /** What the model gives it. */
  modelProb: number;
  /** The bookmaker's probability with the margin removed. Null = no price. */
  marketProb: number | null;
  /** Decimal odds offered, when known. */
  odds: number | null;
  /** modelProb − marketProb. Null when there is no market. */
  edge: number | null;
  /**
   * Decimal odds at which this selection would be a break-even bet according to
   * the model — 1/modelProb.
   *
   * The most useful single number here and the one no bookmaker shows you: if the
   * offered odds are ABOVE this, the model thinks the price is generous. It also
   * makes the comparison concrete in the unit the slip is priced in.
   */
  fairOdds: number;
}

/**
 * Below this, a disagreement is noise.
 *
 * Both models and de-vigged prices are estimates; two estimates of the same
 * quantity differ by a couple of points routinely. 4 pp is wide enough that the
 * list stays short and every row on it is worth reading — the failure mode to
 * avoid is twenty rows of +0.6 pp, which trains the reader to ignore the panel.
 */
export const MIN_EDGE = 0.04;

/**
 * Rows shown at once.
 *
 * Was 6. Raised because six is thin on a full Saturday — the football tab can have
 * sixty fixtures across ten leagues and was showing six lines about them.
 *
 * It is raised and NOT the per-match cap, which stays at one. Two suggestions from
 * the same match are two ways of saying the same forecast, and filling a longer list
 * with them would make it look like more information while adding none. Ten rows
 * from ten different matches is more; ten rows from four matches is not.
 */
export const MAX_PICKS = 10;

/**
 * What the reader has to know before acting on any of this, per sport.
 *
 * Written from the backtests in this repo, not from optimism. The NFL line is the
 * uncomfortable one and it is the most important one on the page.
 */
export const CAVEATS: Record<string, string> = {
  football:
    'Dixon-Coles jerárquico: ataque y defensa por equipo, ventaja de campo, decay de un año de ' +
    'semivida y priors que encogen a los equipos con pocos partidos hacia la media de su liga. ' +
    'Medido sobre 20.824 partidos de 14 ligas sin tocar el holdout: RPS 0.2007 en las primeras ' +
    'divisiones y 0.2177 en las segundas, frente a 0.2230 de la referencia, con el empate ' +
    'calibrado a ±1,4 pp. Contra el modelo de Elo anterior gana claramente en el MARCADOR EXACTO ' +
    '(p = 0,0005) y en el hándicap, pero NO de forma medible en el 1X2 (p = 0,054): la mejora está ' +
    'en la forma de la distribución de goles, no en acertar quién gana. En «ambos marcan» no ' +
    'cambia nada. Un equipo recién ascendido se predice con su Elo de Segunda más el salto de ' +
    'división medido en su país; la tarjeta lo dice y su banda es más ancha. La probabilidad que se ' +
    'publica pasa además por una calibración de Platt ajustada sobre predicciones históricas fuera ' +
    'de muestra (mejora el log loss en 0,0009, que es poco y no sobrevive a la corrección por ' +
    'comparaciones múltiples). NO se mezcla con el mercado: para ajustar ese peso hacen falta ' +
    'cuotas de partidos ya jugados y este archivo no las tiene, así que se deja apagado en vez de ' +
    'poner un número a ojo. Nunca se ha medido contra las cuotas de cierre, así que una diferencia ' +
    'con el mercado es una diferencia, no una ganancia demostrada. Los mercados de menos ' +
    'liquidez —mitades, córners, tarjetas y props de jugador— van en su propio panel porque ' +
    'NO están igual de calibrados: las mitades andan entre 0,05 y 3,2 pp de error medido ' +
    'sobre 3.634 partidos, con el de cada línea escrito al lado, y a los que cotizan pocas ' +
    'casas hay que exigirles dos o tres veces más ventaja porque el margen se la come antes.',
  baseball:
    'Medido sobre 36.235 partidos: Brier 0.2431 y over/under acertado el 54,9 %. El modelo no ' +
    'conoce el bullpen ni la alineación del día, que es justo lo que mueve una cuota a última hora.',
  basketball:
    'Medido sobre 85.562 partidos: acierto 68,1 % y Brier 0.2044, empatado con el modelo que ' +
    'publicaba FiveThirtyEight en los mismos partidos. El hándicap sale de una σ medida sobre las ' +
    'últimas temporadas, no de una constante. No se ha medido contra las cuotas de cierre.',
  nfl:
    'Este modelo NO le gana a la línea de cierre: 50,6 % contra el hándicap donde el punto de ' +
    'equilibrio está en 52,4 %, y la línea acierta más que él (Brier 0.2115 frente a 0.2180 en ' +
    '7.276 partidos). Así que la probabilidad que se publica aquí NO es la del modelo: es una ' +
    'mezcla en la que el backtest le da al modelo un peso de 0,10 y al precio el resto, y ese peso ' +
    'baja aún más cuando el modelo se aleja del precio. Con eso la mezcla queda en 0,6294 de log ' +
    'loss frente a 0,6270 del mercado solo — o sea, sigue sin mejorar la línea, solo deja de ' +
    'empeorarla. La tarjeta enseña las dos probabilidades para que se vea cuánto se ha movido. ' +
    'Cuando el modelo y el precio discrepen, la apuesta razonable es que se equivoque el modelo.',
  tennis:
    'Medido sobre 46.166 partidos ATP: acierto 67,0 % frente al 64,8 % de fiarse del ranking, y ' +
    'cuando discrepa del ranking acierta el 55,4 %. Las bajas de última hora y las retiradas —que ' +
    'en tenis deciden partidos enteros— no están dentro.',
};

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------
/**
 * A two-way market's probabilities with the bookmaker's margin removed.
 *
 * 1/odds sums to more than 1 — that excess IS the margin — so the pair is
 * normalised. Skipping this step makes every model look like it has found value,
 * because it would be compared against prices deliberately shaded against it.
 */
/**
 * Is this row's price an independent opinion, or our own model wearing a margin?
 *
 * `source: 'fixture'` means the app generated the odds from the model itself
 * because there was no API key. Comparing against those is circular, so they are
 * treated as absent.
 */
export function realMarket(source: string | undefined): boolean {
  return source !== 'fixture';
}

function devig2(oddsA: number, oddsB: number): [number, number] {
  const a = 1 / oddsA;
  const b = 1 / oddsB;
  const s = a + b;
  return [a / s, b / s];
}

function devig3(o1: number, oX: number, o2: number): [number, number, number] {
  const a = 1 / o1;
  const b = 1 / oX;
  const c = 1 / o2;
  const s = a + b + c;
  return [a / s, b / s, c / s];
}

interface Candidate {
  market: string;
  selection: string;
  modelProb: number;
  marketProb: number | null;
  odds: number | null;
}

function toPicks(
  id: string,
  when: string,
  match: string,
  candidates: Candidate[],
  league?: string,
): Pick[] {
  return candidates
    // A market at 0 or 1 is not a market — it is a rounding artefact or a bug, and
    // 1/0 would print Infinity as "fair odds".
    .filter((c) => c.modelProb > 0.02 && c.modelProb < 0.98)
    .map((c) => ({
      id,
      when,
      match,
      league,
      market: c.market,
      selection: c.selection,
      modelProb: c.modelProb,
      marketProb: c.marketProb,
      odds: c.odds,
      edge: c.marketProb == null ? null : c.modelProb - c.marketProb,
      fairOdds: 1 / c.modelProb,
    }));
}

/** At most one row per match: six rows about one game is a card, not a shortlist. */
const MAX_PER_MATCH = 1;

/**
 * How many rows one market may fill.
 *
 * Without a cap the list degenerates. Double chance is P(1)+P(X) — structurally
 * around 75 % in almost every fixture — so a ranking by probability filled all six
 * rows with double chances: six near-identical numbers on six different games, a
 * list whose rows differ only in the team name.
 *
 * But a FIXED cap is wrong in the other direction. Tennis produces exactly one
 * market, the winner, so a cap of two left that tab with two rows and four empty
 * slots — punishing the sport for having less to say instead of just saying it. So
 * the cap is derived from how many markets there actually are.
 */
function marketCap(distinctMarkets: number): number {
  return Math.max(2, Math.ceil(MAX_PICKS / Math.max(1, distinctMarkets)));
}

/**
 * How often each market comes true ON AVERAGE, measured over this repo's own archives.
 *
 * WHY THIS EXISTS. Without prices the list is ordered by the model's probability, and
 * that quietly ranks MARKETS instead of opinions: "doble oportunidad" is structurally
 * around 69 %, so it beat every straight winner pick and the football tab opened with
 * three double-chance rows and not one answer to "who wins". The model was not being
 * more confident about them — that market simply starts higher.
 *
 * So the confidence ordering uses the LIFT over the base rate: how much the model is
 * actually saying beyond what the market says on its own. Arsenal at 70.6 % is +27.3
 * over the 43.3 % a home side wins; a double chance at 88.7 % is +20.1 over 68.6 %.
 * The winner pick is the stronger claim and now sorts first.
 *
 * Measured 2026-08 over: fútbol 21.769 partidos, baloncesto (desde 2015) 46.6k,
 * béisbol 37.262, NFL 7.276. A market with no entry falls back to 0.5, which for a
 * two-way market is exactly right and for anything else is the conservative choice.
 */
// ---------------------------------------------------------------------------
// MEDIDAS SOBRE EL ARCHIVO, no constantes de manual. Remedidas sobre 30.321
// partidos tras completar las segundas divisiones.
//
// Y SEPARADAS POR ESCALÓN, porque los dos no juegan al mismo fútbol:
//
//                        1ª (17.880)   2ª (12.441)
//     gana el local         43.5 %        42.7 %
//     1X                    68.5 %        71.2 %
//     ambos marcan          53.8 %        51.1 %
//     más de 2.5 goles      53.0 %        46.3 %
//
// Seis puntos y medio en el over: en Segunda se marca bastante menos. Antes había
// una sola cifra global (50.3 %) para las dos, así que un «Over 2.5» de Segunda se
// comparaba contra una referencia inflada por la Primera y subía en la lista sin
// merecerlo, mientras que uno de Primera se comparaba contra una rebajada por la
// Segunda y bajaba. Con una lista de diez filas, eso decide qué se lee.
//
// Esto solo ORDENA; no se publica ninguna de estas cifras como probabilidad.
// ---------------------------------------------------------------------------

/** Las de segunda división. Los mercados que no dependen del escalón no están. */
const BASE_RATE_TIER2: Record<string, number> = {
  '1X2': 0.427,
  'Doble oportunidad': 0.712,
  'Ambos marcan': 0.511,
  'Total de goles': 0.463,
};

const BASE_RATE: Record<string, number> = {
  // Football, primera división
  '1X2': 0.435,               // el local gana
  'Doble oportunidad': 0.685, // 1X; X2 es 0.565, se usa la más común
  'Ambos marcan': 0.538,
  'Total de goles': 0.530,    // +2.5
  // Basketball / baseball / NFL winner markets, home side
  Ganador: 0.55,
  Hándicap: 0.5,              // una línea justa es 50/50 por construcción
  'Línea de carreras': 0.5,
  'Total de puntos': 0.5,
  'Total de carreras': 0.5,
};

/**
 * Las segundas divisiones que la app ingiere.
 *
 * Una lista explícita y no una heurística sobre el nombre: "Championship" no lleva
 * ningún "2" y "LaLiga Hypermotion" tampoco, así que cualquier regla por el texto
 * fallaría justo en las dos ligas con más partidos de este grupo.
 */
const TIER2 = new Set(['championship', 'laliga2', 'bundesliga2', 'serieb', 'ligue2']);

/** How much the model is saying beyond the market's own base rate. */
function lift(p: Pick): number {
  const table = p.league && TIER2.has(p.league) ? BASE_RATE_TIER2 : BASE_RATE;
  return p.modelProb - (table[p.market] ?? BASE_RATE[p.market] ?? 0.5);
}

/**
 * Rank, diversify and trim.
 *
 * Two regimes, and the caller is told which one it got. With prices, order by
 * edge and drop anything under the threshold. Without, order by the model's own
 * confidence — a weaker basis, so it is never mixed with the other: a list that
 * silently blends "the market disagrees" with "the model is sure" is two different
 * claims wearing one hat.
 *
 * Then the caps above, applied greedily down the sorted list, so the strongest row
 * always survives and the diversity comes out of the weaker ones.
 */
export function rankPicks(
  all: Pick[],
  now: number = Date.now(),
  opts: {
    /**
     * Force ranking by the model's own probability even when market prices exist.
     *
     * The NFL passes this, and it is not a preference — it is the measurement. On
     * that sport the closing line is a BETTER forecast than the model (Brier 0.2115
     * against 0.2180 over 7,276 games; the model wins no walk-forward cut and no
     * regime). Ranking by edge means ranking by "how far the model is from a more
     * accurate number", which puts the model's worst disagreements at the top of a
     * list headed "what the model sees as most likely". The market column is still
     * shown — the reader should see both — it just does not drive the order.
     */
    basis?: 'confidence';
  } = {},
): { picks: Pick[]; basis: 'edge' | 'confidence'; considered: number } {
  // A match that has already kicked off is not a suggestion. The schedule keeps
  // today's games on screen all day on purpose (see server/freshness.ts), which is
  // right for reading a RESULT and wrong for proposing a bet — the basketball tab
  // was topping this list with a game that had started 59 minutes earlier.
  const upcoming = all.filter((p) => Date.parse(p.when) > now);

  const priced = upcoming.filter((p) => p.edge != null);
  const basis: 'edge' | 'confidence' =
    opts.basis === 'confidence' ? 'confidence' : priced.length > 0 ? 'edge' : 'confidence';
  const sorted =
    basis === 'edge'
      ? priced.filter((p) => (p.edge ?? 0) >= MIN_EDGE).sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
      : [...upcoming].sort((a, b) => lift(b) - lift(a));

  const cap = marketCap(new Set(sorted.map((p) => p.market)).size);
  const perMatch = new Map<string, number>();
  const perMarket = new Map<string, number>();
  const picks: Pick[] = [];
  for (const p of sorted) {
    if (picks.length >= MAX_PICKS) break;
    if ((perMatch.get(p.id) ?? 0) >= MAX_PER_MATCH) continue;
    if ((perMarket.get(p.market) ?? 0) >= cap) continue;
    perMatch.set(p.id, (perMatch.get(p.id) ?? 0) + 1);
    perMarket.set(p.market, (perMarket.get(p.market) ?? 0) + 1);
    picks.push(p);
  }
  // `considered` is how many candidates existed BEFORE any filtering. The panel
  // needs it to tell two very different situations apart: "there were matches and
  // the model agreed with every price" — a real finding — and "there were no
  // matches at all", which is not a finding about anything. Without it the WTA tab,
  // which has zero players and zero fixtures, announced that the model did not
  // disagree with the market.
  return { picks, basis, considered: upcoming.length };
}

// ---------------------------------------------------------------------------
// Per-sport adapters
//
// Each takes what its tab already fetched and returns candidate markets. Reading
// from the same objects the cards render means the panel and the card underneath
// it cannot disagree about a number — there is only one source.
// ---------------------------------------------------------------------------

/** Football: 1X2, double chance, over/under 2.5, both teams to score. */
export function footballPicks(
  rows: {
    fixture: {
      id: string; commence_time: string; home_name: string; away_name: string;
      /** Elige la tabla de referencia del escalón. Ver BASE_RATE_TIER2. */
      league?: string;
      odds_home: number | null; odds_draw: number | null; odds_away: number | null;
      /** 'fixture' = this app invented the price from the model. See realMarket(). */
      source?: string;
    };
    prediction: {
      model: { home: number; draw: number; away: number };
      final: { home: number; draw: number; away: number };
      goals: { over25: number; under25: number; bothScore: number };
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const f = r.fixture;
    // El 1X2 usa la probabilidad PUBLICADA (calibrada, y mezclada con el mercado donde
    // hay peso ajustado): es la creencia de la app y es contra la que hay que medir una
    // cuota. Los mercados de goles siguen saliendo de la rejilla cruda, porque el
    // calibrador se ajustó sobre el 1X2 y solo sabe corregir el 1X2 — aplicarlo a la
    // rejilla sería usarlo fuera de donde se midió.
    const m = r.prediction.final;
    const g = r.prediction.goals;
    const match = `${f.home_name} vs ${f.away_name}`;
    const has =
      realMarket(f.source) && f.odds_home != null && f.odds_draw != null && f.odds_away != null;
    const [mh, mx, ma] = has ? devig3(f.odds_home!, f.odds_draw!, f.odds_away!) : [null, null, null];

    const c: Candidate[] = [
      { market: '1X2', selection: f.home_name, modelProb: m.home, marketProb: mh, odds: f.odds_home },
      { market: '1X2', selection: 'Empate', modelProb: m.draw, marketProb: mx, odds: f.odds_draw },
      { market: '1X2', selection: f.away_name, modelProb: m.away, marketProb: ma, odds: f.odds_away },
      // Double chance. Not a separate model output — it is the complement of the
      // third outcome, which is why it can be offered honestly: P(1 o X) = 1 − P(2).
      // The odds are not published for it here, so it carries the de-vigged
      // probability and no price, and the panel shows the fair odds instead.
      {
        market: 'Doble oportunidad',
        selection: `${f.home_name} o empate`,
        modelProb: m.home + m.draw,
        marketProb: mh == null || mx == null ? null : mh + mx,
        odds: null,
      },
      {
        market: 'Doble oportunidad',
        selection: `${f.away_name} o empate`,
        modelProb: m.away + m.draw,
        marketProb: ma == null || mx == null ? null : ma + mx,
        odds: null,
      },
      // Goals. The feed this app uses only prices 1X2, so there is no market
      // probability to compare against — stated as such rather than faked.
      { market: 'Total de goles', selection: 'Over 2.5', modelProb: g.over25, marketProb: null, odds: null },
      { market: 'Total de goles', selection: 'Under 2.5', modelProb: g.under25, marketProb: null, odds: null },
      { market: 'Ambos marcan', selection: 'Sí', modelProb: g.bothScore, marketProb: null, odds: null },
      { market: 'Ambos marcan', selection: 'No', modelProb: 1 - g.bothScore, marketProb: null, odds: null },
    ];
    out.push(...toPicks(f.id, f.commence_time, match, c, f.league));
  }
  return out;
}

/** Baseball: winner, the total on its own line, and the ±1.5 run line. */
export function baseballPicks(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null;
      source?: string;
    };
    prediction: {
      model: { home: number; away: number };
      runs: {
        totalLine: number; over: number; under: number;
        runLine: { homeCovers: number; awayCovers: number };
      };
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const match = `${g.away_name} @ ${g.home_name}`;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    const [mh, ma] = has ? devig2(g.odds_home!, g.odds_away!) : [null, null];
    const c: Candidate[] = [
      { market: 'Ganador', selection: g.home_name, modelProb: p.model.home, marketProb: mh, odds: g.odds_home },
      { market: 'Ganador', selection: g.away_name, modelProb: p.model.away, marketProb: ma, odds: g.odds_away },
      { market: 'Total de carreras', selection: `Over ${p.runs.totalLine}`, modelProb: p.runs.over, marketProb: null, odds: null },
      { market: 'Total de carreras', selection: `Under ${p.runs.totalLine}`, modelProb: p.runs.under, marketProb: null, odds: null },
      { market: 'Línea de carreras', selection: `${g.home_name} −1.5`, modelProb: p.runs.runLine.homeCovers, marketProb: null, odds: null },
      { market: 'Línea de carreras', selection: `${g.away_name} +1.5`, modelProb: p.runs.runLine.awayCovers, marketProb: null, odds: null },
    ];
    out.push(...toPicks(g.id, g.commence_time, match, c));
  }
  return out;
}

/**
 * Basketball: winner, the model's own handicap, and the total.
 *
 * A separate adapter from the NFL's rather than a shared "points sport" one,
 * because the two predictions genuinely differ in shape — basketball keeps its
 * spread and total inside `projection.distribution`, the NFL has them at the top
 * level with a push probability. Forcing one signature would mean a wrapper per
 * sport anyway, plus a lie about how alike they are.
 */
export function basketballPicks(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      home_odds: number | null; away_odds: number | null;
      source?: string;
    };
    prediction: {
      model: { probHome: number; probAway: number };
      projection: {
        distribution: {
          spreadLine: number; homeCovers: number;
          totalLine: number | null; over: number | null; under: number | null;
        };
      };
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const d = p.projection.distribution;
    const match = `${g.away_name} @ ${g.home_name}`;
    const has = realMarket(g.source) && g.home_odds != null && g.away_odds != null;
    const [mh, ma] = has ? devig2(g.home_odds!, g.away_odds!) : [null, null];
    const c: Candidate[] = [
      { market: 'Ganador', selection: g.home_name, modelProb: p.model.probHome, marketProb: mh, odds: g.home_odds },
      { market: 'Ganador', selection: g.away_name, modelProb: p.model.probAway, marketProb: ma, odds: g.away_odds },
      {
        market: 'Hándicap',
        selection: `${g.home_name} ${d.spreadLine > 0 ? '+' : ''}${d.spreadLine}`,
        modelProb: d.homeCovers,
        marketProb: null,
        odds: null,
      },
      {
        market: 'Hándicap',
        selection: `${g.away_name} ${-d.spreadLine > 0 ? '+' : ''}${-d.spreadLine}`,
        modelProb: 1 - d.homeCovers,
        marketProb: null,
        odds: null,
      },
    ];
    if (d.totalLine != null && d.over != null && d.under != null) {
      c.push(
        { market: 'Total de puntos', selection: `Over ${d.totalLine}`, modelProb: d.over, marketProb: null, odds: null },
        { market: 'Total de puntos', selection: `Under ${d.totalLine}`, modelProb: d.under, marketProb: null, odds: null },
      );
    }
    out.push(...toPicks(g.id, g.commence_time, match, c));
  }
  return out;
}

/**
 * The NFL: winner, handicap, total.
 *
 * The one sport whose handicap probabilities carry a PUSH — the margin landing
 * exactly on the line, which in this sport is common enough to matter (3 and 7 are
 * where margins pile up). `cover` here excludes the push, so it is already the
 * probability of the bet winning rather than not losing.
 */
export function nflPicks(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null;
      source?: string;
    };
    prediction: {
      model: { home: number; away: number; tie: number };
      final: { home: number; away: number };
      spread: { line: number; home: { cover: number }; away: { cover: number } };
      total: { line: number; over: number; under: number };
      // Derived from the closing handicap when there is no moneyline, which is the
      // normal case here — nflverse ships the line with the schedule.
      market?: { market: { home: number; away: number } | null } | null;
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const match = `${g.away_name} @ ${g.home_name}`;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    // Moneyline first when it exists; otherwise the probability read off the closing
    // line, which is the better forecast of the two on this sport and was being
    // thrown away — the column showed "—" on every row while the card had the number.
    const spreadMkt = p.market?.market ?? null;
    const [mh, ma] = has
      ? devig2(g.odds_home!, g.odds_away!)
      : spreadMkt
        ? [spreadMkt.home, spreadMkt.away]
        : [null, null];
    const c: Candidate[] = [
      // El ganador usa la probabilidad PUBLICADA, que en este deporte es la que más
      // cambia: el peso ajustado del modelo es 0,10 y el encogimiento se lleva incluso
      // eso cuando discrepa mucho del precio. Es justamente lo que hay que hacer con un
      // modelo que, medido, no le gana a la línea de cierre.
      { market: 'Ganador', selection: g.home_name, modelProb: p.final.home, marketProb: mh, odds: g.odds_home },
      { market: 'Ganador', selection: g.away_name, modelProb: p.final.away, marketProb: ma, odds: g.odds_away },
      {
        market: 'Hándicap',
        selection: `${g.home_name} ${p.spread.line > 0 ? '+' : ''}${p.spread.line}`,
        modelProb: p.spread.home.cover,
        marketProb: null,
        odds: null,
      },
      {
        market: 'Hándicap',
        selection: `${g.away_name} ${-p.spread.line > 0 ? '+' : ''}${-p.spread.line}`,
        modelProb: p.spread.away.cover,
        marketProb: null,
        odds: null,
      },
      { market: 'Total de puntos', selection: `Over ${p.total.line}`, modelProb: p.total.over, marketProb: null, odds: null },
      { market: 'Total de puntos', selection: `Under ${p.total.line}`, modelProb: p.total.under, marketProb: null, odds: null },
    ];
    out.push(...toPicks(g.id, g.commence_time, match, c));
  }
  return out;
}

/** Tennis: the winner. There is no second market the model produces. */
export function tennisPicks(
  rows: {
    match: {
      id: string; commence_time: string; p1_name: string; p2_name: string;
      p1_odds: number | null; p2_odds: number | null;
      source?: string;
    };
    prediction: { model: { prob1: number; prob2: number } } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const m = r.match;
    const has = realMarket(m.source) && m.p1_odds != null && m.p2_odds != null;
    const [q1, q2] = has ? devig2(m.p1_odds!, m.p2_odds!) : [null, null];
    out.push(
      ...toPicks(m.id, m.commence_time, `${m.p1_name} vs ${m.p2_name}`, [
        { market: 'Ganador', selection: m.p1_name, modelProb: r.prediction.model.prob1, marketProb: q1, odds: m.p1_odds },
        { market: 'Ganador', selection: m.p2_name, modelProb: r.prediction.model.prob2, marketProb: q2, odds: m.p2_odds },
      ]),
    );
  }
  return out;
}

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

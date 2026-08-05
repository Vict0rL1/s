// Build the full, explainable prediction for one American football game.
//
// Every figure the card shows is read off ONE distribution — the moneyline, the
// handicap at any line, the total, the margin bands, the likely final scores.
// That is what stops a card claiming the home team wins 62% of the time in one
// panel while pricing a pick'em handicap at 55% in the next, and it is what the
// audit checks.
//
// The markets exposed here are the three a sportsbook actually posts for an NFL
// game, in the order it posts them: SPREAD first (the headline market in this
// sport, unlike every other tab in this app), then TOTAL, then MONEYLINE.

import {
  buildDistribution,
  coverProbability,
  expectedPoints,
  likelyScorelines,
  marginBands,
  marginProb,
  conditionsTotalAdjustment,
  outcomeProbabilities,
  overProbability,
  ELO_PER_POINT,
  QB_CARRYOVER,
  MARGIN_KEY_WEIGHTS,
  MARGIN_SIGMA,
  TOTAL_SIGMA,
  type Distribution,
  type MarginBand,
  type Scoreline,
} from './model.ts';
import {
  getCurrentQb,
  getHeadToHead,
  getLatestSeason,
  getLeagueState,
  getRating,
  getTeam,
  getTeamInfo,
} from './repo.ts';
import { carryOver, SCORING_CARRYOVER, SEASON_CARRYOVER } from './model.ts';
import type { LeagueId, NafRecord } from './types.ts';

export const DISCLAIMER =
  'Estimación estadística basada en Elo por equipo, una ventaja de campo que la liga actualiza sola, ' +
  'los ritmos de anotación de cada equipo, el quarterback titular y una distribución de margen con ' +
  'los números clave del deporte (3 y 7). Da por titular a quien jugó el último partido: NO conoce ' +
  'las bajas de esta semana, ni el viento del día (no hay previsión en el calendario), ni el estado ' +
  'del campo. No es una certeza ni una recomendación para apostar.';

export type ReliabilityLevel = 'high' | 'medium' | 'low';

/**
 * Games of history that actually inform TODAY's rating.
 *
 * Capped at about two seasons. The archive holds 27 years and taken at face
 * value that would make every rating look known to a hair — the same trap the
 * baseball card fell into, where every game came out "high reliability ±0.8 pp".
 * What bounds the precision of an NFL rating is not how many games a franchise
 * ever played, it is how many describe the current roster; and with a 0.6 season
 * carryover the model itself says that is about two years.
 */
const EFFECTIVE_GAMES_CAP = 34;

/**
 * The uncertainty band, calibrated against the market — which only this sport
 * can do.
 *
 * In the other four tabs this constant is a judgement call: there is no
 * independent estimate of the truth to check a confidence interval against, so
 * the band is derived from sample size and left at a defensible guess. Here
 * there is one. Over the 5,295 games with a closing moneyline, the model's
 * probability sits this far from the market's:
 *
 *     mean 7.3 pp   ·   median 6.0 pp   ·   90th percentile 14.8 pp
 *
 * The closing line is not truth either, but it is the best available estimate of
 * it, so "how far the model typically is from the closing line" is the honest
 * width of the band. C is set so that a matchup with a full history comes out at
 * that 7.3 pp, rather than at the ±18.5 pp the constant inherited from the
 * baseball card produced — a figure that was both wrong and identical on every
 * single game, which is the giveaway that it was measuring nothing.
 */
const ELO_SIGMA_C = 74;

/**
 * Staleness is counted in SEASONS MISSED, not in months elapsed.
 *
 * The other four sports play most of the year, so "the archive ends six months
 * ago" means six months of games are missing and the ratings are genuinely out
 * of date. The NFL plays 18 weeks and then stops. In July the archive is five
 * months old BY DESIGN — it is completely up to date, because there is nothing
 * to be up to date about.
 *
 * The first version of this card counted months and returned "fiabilidad baja
 * ±59.5 pp" on a week-1 game with a spotless 27-season archive behind it. What
 * actually costs a rating its accuracy here is a season the model never saw, so
 * that is what gets counted; the off-season regression above already handles the
 * roster turnover that a crossed winter implies.
 */
const STALE_SIGMA_PER_SEASON = 26;
const STALE_SIGMA_CAP = 78;
const MIN_GAMES_FOR_ANY_CONFIDENCE = 8;
const GAMES_FOR_HIGH = 32;
/**
 * Tier boundaries, from the same measured distribution: the median gap to the
 * closing line is 6.0 pp and the 90th percentile 14.8.
 *
 * A consequence worth stating plainly rather than hiding: with a complete
 * 27-season archive every NFL franchise is equally well established, so every
 * game in this tab comes out at the same ±7.3 pp and the same "media" tier. That
 * is not a broken indicator, it is the honest reading — the tier only moves when
 * something is genuinely missing (a league with no archive, an expansion team, a
 * season the ingest never fetched).
 *
 * A week-of-season term was measured and rejected. The gap to the market is 8.0
 * pp in week 1, 6.8 in weeks 9-13 and 7.6 from week 14 — real, small, and not
 * monotonic, so a "September is less certain" adjustment would be fitting the
 * shape of the schedule rather than anything about the teams.
 */
const MARGIN_HIGH_MAX = 6;
const MARGIN_LOW_MIN = 12;

export const VALUE_THRESHOLD = 0.05;

export interface NafSide {
  id: string;
  name: string;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  pf: number | null;
  pa: number | null;
  pythagorean: number | null;
  record: NafRecord;
  venueRecord: NafRecord;
  last5: ('W' | 'D' | 'L')[];
  expectedPoints: number;
}

export interface NafReliability {
  level: ReliabilityLevel;
  label: string;
  marginPp: number;
  reasons: string[];
  gamesBehind: { home: number; away: number };
}

export interface NafMarket {
  odds: { home: number; away: number };
  /** De-vigged two-way probabilities. */
  home: number;
  away: number;
  overround: number;
}

export interface NafMarketComparison {
  market: NafMarket | null;
  edge: { home: number; away: number } | null;
  verdict: 'value_home' | 'value_away' | 'agree' | 'no_market';
}

export interface NafSpreadQuote {
  line: number;
  cover: number;
  push: number;
  fail: number;
  /** Wording a reader can check against a betting slip. */
  label: string;
}

/**
 * The starting quarterback the forecast assumed, and what he is worth.
 *
 * Surfaced rather than buried because it is the one model input a reader can
 * check and correct from the news: if the app says it assumed Stidham and the
 * reader knows Maye is back, the reader now knows the forecast is stale in a
 * specific, quantified way instead of vaguely mistrusting it.
 */
export interface NafQbInfo {
  name: string | null;
  /** Elo points relative to a league-average starter. */
  adjustment: number;
  /** Points of expected margin the offset is worth. */
  points: number;
  starts: number;
  /** True when the assumption is "whoever played last", which it always is. */
  assumed: boolean;
}

export interface NafPrediction {
  league: LeagueId;
  teams: { home: NafSide; away: NafSide };
  quarterbacks: { home: NafQbInfo | null; away: NafQbInfo | null };
  /** How the roof moved the expected total, in points. Null when unknown. */
  conditions: { roof: string | null; totalAdjustment: number } | null;
  /** Moneyline probabilities. `tie` is small but real, and never folded away. */
  model: { home: number; away: number; tie: number };
  spread: {
    /** The model's own number: how much the home team is expected to win by. */
    expectedMargin: number;
    label: string;
    /** The market's line if there is one, otherwise the model's own, rounded. */
    line: number;
    home: NafSpreadQuote;
    away: NafSpreadQuote;
    fromMarket: boolean;
    /** The two lines that matter most in this sport, always priced. */
    keyLines: NafSpreadQuote[];
  };
  total: {
    expected: number;
    line: number;
    over: number;
    push: number;
    under: number;
    fromMarket: boolean;
  };
  points: { home: number; away: number };
  bands: MarginBand[];
  scorelines: Scoreline[];
  /** P(the margin lands exactly on a key number) — the reason this model exists. */
  keyNumbers: { margin: number; probability: number }[];
  h2h: {
    total: number;
    homeWins: number;
    awayWins: number;
    ties: number;
    recent: {
      date: string;
      season: number;
      week: number;
      homeId: string;
      awayId: string;
      homePoints: number;
      awayPoints: number;
    }[];
  };
  market: NafMarketComparison;
  reasoning: {
    text: string;
    factors: { key: string; label: string; pointsForHome: number }[];
  };
  reliability: NafReliability;
  verdict: { label: string; close: boolean; marginPp: number };
  summary: { headline: string; bullets: string[] };
  context: { homeAdvantageElo: number; homeAdvantagePoints: number; leagueTotal: number };
  disclaimer: string;
}

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** "Seattle Seahawks" → "Seahawks". The nickname is how the team is spoken of. */
const shortName = (name: string): string => name.split(' ').slice(-1)[0] ?? name;
const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}`;

/** Decimal odds → implied probability, with the bookmaker's margin removed. */
function deVig(oddsHome: number | null, oddsAway: number | null): NafMarket | null {
  if (!oddsHome || !oddsAway || oddsHome <= 1 || oddsAway <= 1) return null;
  const rawH = 1 / oddsHome;
  const rawA = 1 / oddsAway;
  const sum = rawH + rawA;
  if (sum <= 0) return null;
  return {
    odds: { home: oddsHome, away: oddsAway },
    home: rawH / sum,
    away: rawA / sum,
    overround: sum,
  };
}

/**
 * The handicap the card quotes.
 *
 * A whole number is deliberately NOT rounded away: −3 and −3.5 are different
 * bets in this sport, because a 3-point margin happens in one game in seven and
 * a whole-number line pushes on it. Quoting −3 with its push probability is more
 * honest than quietly moving it to −3.5 to make the arithmetic tidy.
 */
function spreadQuote(d: Distribution, line: number, homeName: string, awayName: string): {
  home: NafSpreadQuote;
  away: NafSpreadQuote;
} {
  const h = coverProbability(d, line, 'home');
  const a = coverProbability(d, -line, 'away');
  const fmt = (team: string, l: number) =>
    l === 0 ? `${team} sin hándicap` : `${team} ${l > 0 ? '+' : ''}${l}`;
  return {
    home: { line, cover: h.cover, push: h.push, fail: h.fail, label: fmt(homeName, line) },
    away: { line: -line, cover: a.cover, push: a.push, fail: a.fail, label: fmt(awayName, -line) },
  };
}

function reliabilityOf(
  homeGames: number,
  awayGames: number,
  seasonsMissed: number,
  probMargin: number,
): NafReliability {
  const reasons: string[] = [];
  const eff = (g: number) => Math.min(g, EFFECTIVE_GAMES_CAP);
  const sigma =
    ELO_SIGMA_C / Math.sqrt(Math.max(eff(homeGames), 1)) +
    ELO_SIGMA_C / Math.sqrt(Math.max(eff(awayGames), 1)) +
    Math.min(seasonsMissed * STALE_SIGMA_PER_SEASON, STALE_SIGMA_CAP);

  // Turn the Elo uncertainty into a probability band the same way the other
  // sports do: shift the rating by ±sigma and see how far the answer moves.
  const p = (diff: number) => 1 / (1 + 10 ** (-diff / 400));
  const marginPp = Math.round((p(sigma) - p(-sigma)) * 100 * 10) / 10;

  const thin = Math.min(homeGames, awayGames);
  let level: ReliabilityLevel = 'medium';
  if (thin < MIN_GAMES_FOR_ANY_CONFIDENCE) {
    level = 'low';
    reasons.push(`Solo ${thin} partidos detrás del Elo más flojo de los dos.`);
  } else if (thin >= GAMES_FOR_HIGH && marginPp <= MARGIN_HIGH_MAX && seasonsMissed === 0) {
    level = 'high';
  } else if (marginPp >= MARGIN_LOW_MIN || seasonsMissed >= 2) {
    level = 'low';
  }
  if (seasonsMissed >= 1) {
    reasons.push(
      `Falta${seasonsMissed > 1 ? 'n' : ''} ${seasonsMissed} temporada${seasonsMissed > 1 ? 's' : ''} ` +
        'en el historial: los Elo no describen a las plantillas de hoy.',
    );
  }
  if (probMargin < 0.06) reasons.push('Partido muy igualado: el favorito lo es por poco.');

  const label =
    level === 'high' ? 'fiabilidad alta' : level === 'medium' ? 'fiabilidad media' : 'fiabilidad baja';
  return { level, label, marginPp, reasons, gamesBehind: { home: homeGames, away: awayGames } };
}

export interface PredictInput {
  league: LeagueId;
  homeId: string;
  awayId: string;
  neutral?: boolean;
  oddsHome?: number | null;
  oddsAway?: number | null;
  spreadLine?: number | null;
  totalLine?: number | null;
  /** Season the game belongs to. Drives the off-season regression below. */
  season?: number | null;
  /**
   * "dome", "closed", "outdoors", "open". Published for scheduled games, and the
   * only conditions field that is — there is no weather forecast, so wind cannot
   * inform a prediction even though it informs the replay.
   */
  roof?: string | null;
}

/**
 * Age a rating across an off-season the archive has not seen yet.
 *
 * THE BUG THIS EXISTS TO FIX. The replay regresses every rating toward 1500 when
 * it crosses a season boundary, because NFL rosters turn over hard — the measured
 * carryover is 0.6, the lowest of the five sports. But that regression happens on
 * encountering the FIRST GAME of the new season, and in September there are no
 * new-season games in the archive yet. So a week-1 forecast was being made from
 * February's ratings at full strength, and the model was quoting last January's
 * Seahawks as if nothing had happened since: 7.3 points against a market line of
 * 3.5, a disagreement that was the model's error rather than an edge.
 *
 * Applying the same 0.6 the replay would have applied, once per season crossed,
 * puts the prediction path back in step with the training path.
 */
function ageAcrossOffseasons(elo: number, seasonsAhead: number): number {
  let out = elo;
  for (let i = 0; i < seasonsAhead; i++) out = carryOver(out, SEASON_CARRYOVER);
  return out;
}

function ageScoring(rate: number, leagueHalf: number, seasonsAhead: number): number {
  let out = rate;
  for (let i = 0; i < seasonsAhead; i++) out = leagueHalf + (out - leagueHalf) * SCORING_CARRYOVER;
  return out;
}

/** Shape one side's quarterback for the card. */
function qbInfo(
  qb: { name: string | null; adjustment: number; starts: number } | null,
  agedAdjustment: number,
): NafQbInfo | null {
  if (!qb) return null;
  return {
    name: qb.name,
    adjustment: Math.round(agedAdjustment),
    points: Number((agedAdjustment / ELO_PER_POINT).toFixed(1)),
    starts: qb.starts,
    assumed: true,
  };
}

export function buildPrediction(input: PredictInput): NafPrediction | null {
  const { league, homeId, awayId } = input;
  const home = getTeam(league, homeId);
  const away = getTeam(league, awayId);
  if (!home || !away) return null;

  const homeInfo = getTeamInfo(league, homeId);
  const awayInfo = getTeamInfo(league, awayId);
  if (!homeInfo || !awayInfo) return null;

  const hr = getRating(league, homeId);
  const ar = getRating(league, awayId);
  const state = getLeagueState(league);

  // How many off-seasons stand between the archive and this game.
  const latestSeason = getLatestSeason(league);
  const seasonsAhead =
    input.season != null && latestSeason != null
      ? Math.max(0, Math.min(input.season - latestSeason, 4))
      : 0;

  const half = state.leagueTotal / 2;
  const homeElo = ageAcrossOffseasons(hr.elo, seasonsAhead);
  const awayElo = ageAcrossOffseasons(ar.elo, seasonsAhead);
  const homePf = ageScoring(hr.pf ?? half, half, seasonsAhead);
  const homePa = ageScoring(hr.pa ?? half, half, seasonsAhead);
  const awayPf = ageScoring(ar.pf ?? half, half, seasonsAhead);
  const awayPa = ageScoring(ar.pa ?? half, half, seasonsAhead);

  // --- who is playing quarterback ------------------------------------------
  // The starter each side used most recently, because the schedule never names
  // one in advance. The offsets are aged with the same off-season regression as
  // the team ratings, so a February forecast for September does not assume a
  // quarterback is exactly as good as his last game said.
  const homeQb = getCurrentQb(league, homeId);
  const awayQb = getCurrentQb(league, awayId);
  const homeQbAdj = homeQb ? homeQb.adjustment * QB_CARRYOVER ** seasonsAhead : 0;
  const awayQbAdj = awayQb ? awayQb.adjustment * QB_CARRYOVER ** seasonsAhead : 0;

  // --- the two numbers the distribution is built from -----------------------
  const edge = input.neutral ? 0 : state.homeAdvantage;
  const eloDiff = homeElo + homeQbAdj - (awayElo + awayQbAdj) + edge;
  const expectedMargin = eloDiff / ELO_PER_POINT;

  // Conditions move the total, never the margin. There is no weather forecast in
  // the schedule, so `wind` is null here and only the roof can contribute.
  const conditionsAdj = conditionsTotalAdjustment(input.roof, null);
  const expectedTotal = (homePf + awayPa) / 2 + (awayPf + homePa) / 2 + conditionsAdj;

  const dist = buildDistribution(expectedMargin, expectedTotal);
  const outcome = outcomeProbabilities(dist);

  // --- spread ---------------------------------------------------------------
  // Prefer the market's line: quoting the model against the line a reader can
  // actually bet is more useful than quoting it against a line of our own.
  const fromMarket = input.spreadLine != null && Number.isFinite(input.spreadLine);
  const line = fromMarket
    ? (input.spreadLine as number)
    : Math.round(expectedMargin * 2) / 2 || 0;
  const quotes = spreadQuote(dist, line, home.name, away.name);

  // ±3 and ±7 are priced whatever the line is, because they are the two numbers
  // this sport's whole handicap market is built around.
  const keyLineValues = [3, -3, 7, -7].map((v) => (expectedMargin >= 0 ? -Math.abs(v) : Math.abs(v)));
  const keyLines = [...new Set([-3, -7, 3, 7])]
    .sort((a, b) => a - b)
    .map((l) => spreadQuote(dist, l, home.name, away.name).home);
  void keyLineValues;

  // --- total ----------------------------------------------------------------
  const totalFromMarket = input.totalLine != null && Number.isFinite(input.totalLine);
  const totalLine = totalFromMarket
    ? (input.totalLine as number)
    : Math.round(expectedTotal * 2) / 2;
  const ou = overProbability(dist, totalLine);

  // --- market ---------------------------------------------------------------
  const market = deVig(input.oddsHome ?? null, input.oddsAway ?? null);
  // The moneyline is a two-way price and a tie voids it, so the model's numbers
  // are renormalised onto the same two outcomes before being compared. Without
  // that the model looks 0.2pp short against every book it is measured on.
  const twoWayHome = outcome.home / (outcome.home + outcome.away);
  const edgeHome = market ? twoWayHome - market.home : null;
  const comparison: NafMarketComparison = {
    market,
    edge: market ? { home: edgeHome as number, away: -(edgeHome as number) } : null,
    verdict: !market
      ? 'no_market'
      : (edgeHome as number) > VALUE_THRESHOLD
        ? 'value_home'
        : (edgeHome as number) < -VALUE_THRESHOLD
          ? 'value_away'
          : 'agree',
  };

  // --- reasoning ------------------------------------------------------------
  //
  // THE FACTORS MUST ADD UP TO THE HEADLINE. Every line here is a term of the
  // expected margin and nothing else is, so the reader can check the card's
  // arithmetic by adding the column. The audit enforces it.
  //
  // Two things were wrong before that rule was applied. The Elo line used the
  // RAW ratings while the model used the regressed ones, so a card headlined
  // "Seahawks −5.2" listed factors totalling 7.3. And an "attack and defence"
  // line sat among them worth another 4.9 points, which was not part of the
  // margin at all — team scoring rates drive the TOTAL, not who wins. Three
  // numbers that looked like an explanation and were not one.
  const rawEloPoints = (hr.elo - ar.elo) / ELO_PER_POINT;
  const agedEloPoints = (homeElo - awayElo) / ELO_PER_POINT;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const edgePoints = round1(edge / ELO_PER_POINT);

  const factors = [
    { key: 'elo', label: 'Elo (nivel del equipo)', pointsForHome: round1(rawEloPoints) },
  ];
  if (seasonsAhead > 0) {
    factors.push({
      key: 'offseason',
      label: `Regresión de pretemporada (×${SEASON_CARRYOVER}${seasonsAhead > 1 ? `, ${seasonsAhead} veces` : ''})`,
      pointsForHome: round1(agedEloPoints - rawEloPoints),
    });
  }
  // The quarterback line only appears when there is something to say: two
  // league-average starters cancel to 0.0 and an empty row is worse than none.
  const qbPoints = round1((homeQbAdj - awayQbAdj) / ELO_PER_POINT);
  if (qbPoints !== 0) {
    const named = [homeQb?.name, awayQb?.name].filter(Boolean).join(' vs ');
    factors.push({
      key: 'qb',
      label: named ? `Quarterback titular (${named})` : 'Quarterback titular',
      pointsForHome: qbPoints,
    });
  }
  factors.push({
    key: 'home',
    label: input.neutral ? 'Campo neutral' : 'Ventaja de campo (la que mide la liga hoy)',
    pointsForHome: edgePoints,
  });

  const eloPoints = round1(agedEloPoints);
  const favourite = expectedMargin >= 0 ? home.name : away.name;
  const offseasonNote =
    seasonsAhead > 0
      ? ` Los Elo vienen regresados hacia la media porque de por medio hay ${
          seasonsAhead > 1 ? `${seasonsAhead} pretemporadas` : 'una pretemporada'
        }: en la NFL solo sobrevive el ${Math.round(SEASON_CARRYOVER * 100)}% de la diferencia entre dos equipos.`
      : '';
  const reasoningText =
    (input.neutral
      ? `${favourite} llega mejor valorado (${Math.abs(eloPoints)} puntos de diferencia por Elo) y se juega en campo neutral.`
      : `${favourite} llega mejor valorado (${Math.abs(eloPoints)} puntos por Elo) y ${
          edgePoints >= 0 ? `jugar en casa vale ${edgePoints} puntos más` : 'el campo no lo compensa'
        }.`) + offseasonNote;

  // --- reliability ----------------------------------------------------------
  // Seasons the archive is missing, which for a game in the season right after
  // the archive ends is zero: that is the normal, fully up-to-date case here.
  const now = new Date();
  const currentSeason = now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const seasonsMissed = latestSeason != null ? Math.max(0, currentSeason - 1 - latestSeason) : 0;
  const reliability = reliabilityOf(
    hr.games_played,
    ar.games_played,
    seasonsMissed,
    Math.abs(outcome.home - outcome.away),
  );

  // --- verdict --------------------------------------------------------------
  const marginPp = Math.abs(outcome.home - outcome.away) * 100;
  const close = marginPp < 10;
  const winner = outcome.home >= outcome.away ? home.name : away.name;
  const verdict = {
    label: `Gana ${winner}`,
    close,
    marginPp: Math.round(marginPp * 10) / 10,
  };

  const points = expectedPoints(expectedMargin, expectedTotal);
  const scorelines = likelyScorelines(dist, 6);
  const bands = marginBands(dist);

  const keyNumbers = [3, 7, 10, 14].map((m) => ({
    margin: m,
    probability: marginProb(dist, m) + marginProb(dist, -m),
  }));

  const h2h = getHeadToHead(league, homeId, awayId);

  const bullets: string[] = [
    `Margen esperado: ${signed(expectedMargin)} para ${home.name} (${points.home.toFixed(1)}-${points.away.toFixed(1)}).`,
    `El marcador más probable es ${scorelines[0]?.label ?? '—'} (${pct(scorelines[0]?.probability ?? 0)}).`,
    `El margen cae justo en 3 o en 7 puntos el ${pct(
      keyNumbers[0].probability + keyNumbers[1].probability,
    )} de las veces: son los dos números alrededor de los que se mueve todo el mercado de hándicap.`,
    `Total: ${expectedTotal.toFixed(1)} puntos esperados · over ${totalLine} al ${pct(ou.over)}. ` +
      `Sale de los ritmos de anotación de los dos equipos (${homePf.toFixed(1)} y ${awayPf.toFixed(1)} ` +
      `a favor, ${homePa.toFixed(1)} y ${awayPa.toFixed(1)} en contra), que mueven el total pero no el margen.`,
    `Ventaja de campo actual de la liga: ${(edge / ELO_PER_POINT).toFixed(1)} puntos${
      input.neutral ? ', pero este partido es en campo neutral' : ''
    }.`,
  ];
  if (market) {
    bullets.push(
      `El mercado da ${pct(market.home)} al local (cuotas ${market.odds.home} / ${market.odds.away}, margen ${(
        (market.overround - 1) * 100
      ).toFixed(1)}%).`,
    );
  }
  if (h2h.total > 0) {
    bullets.push(`Historial directo: ${h2h.homeWins}-${h2h.awayWins}${h2h.ties ? `-${h2h.ties}` : ''} en ${h2h.total} partidos.`);
  }

  const side = (info: typeof homeInfo, expected: number): NafSide => ({
    id: info.id,
    name: info.name,
    elo: info.elo,
    eloRank: info.eloRank,
    gamesInDb: info.gamesInDb,
    pf: info.pf,
    pa: info.pa,
    pythagorean: info.pythagorean,
    record: info.record,
    venueRecord: info.id === homeId ? info.homeRecord : info.awayRecord,
    last5: info.form.slice(0, 5).map((f) => f.result),
    expectedPoints: Number(expected.toFixed(1)),
  });

  return {
    league,
    teams: { home: side(homeInfo, points.home), away: side(awayInfo, points.away) },
    quarterbacks: {
      home: qbInfo(homeQb, homeQbAdj),
      away: qbInfo(awayQb, awayQbAdj),
    },
    conditions: input.roof
      ? { roof: input.roof, totalAdjustment: Number(conditionsAdj.toFixed(2)) }
      : null,
    model: { home: outcome.home, away: outcome.away, tie: outcome.tie },
    spread: {
      expectedMargin: Number(expectedMargin.toFixed(1)),
      // Short enough for a stat tile: "SEA −5.2", not "Seattle Seahawks −5.2",
      // which truncated to "Seattle Seahawks …" and lost the actual number.
      label: `${shortName(expectedMargin >= 0 ? home.name : away.name)} ${(-Math.abs(expectedMargin)).toFixed(1)}`,
      line,
      home: quotes.home,
      away: quotes.away,
      fromMarket,
      keyLines,
    },
    total: {
      expected: Number(expectedTotal.toFixed(1)),
      line: totalLine,
      over: ou.over,
      push: ou.push,
      under: ou.under,
      fromMarket: totalFromMarket,
    },
    points: { home: Number(points.home.toFixed(1)), away: Number(points.away.toFixed(1)) },
    bands,
    scorelines,
    keyNumbers,
    h2h: {
      total: h2h.total,
      homeWins: h2h.homeWins,
      awayWins: h2h.awayWins,
      ties: h2h.ties,
      recent: h2h.recent.map((r) => ({
        date: r.game_date,
        season: r.season,
        week: r.week,
        homeId: r.home_id,
        awayId: r.away_id,
        homePoints: r.home_points,
        awayPoints: r.away_points,
      })),
    },
    market: comparison,
    reasoning: { text: reasoningText, factors },
    reliability,
    verdict,
    summary: {
      headline: `Lo más probable: gana ${winner} (${pct(Math.max(outcome.home, outcome.away))}), ${
        scorelines[0]?.label ?? '—'
      } el marcador más repetido.`,
      bullets,
    },
    context: {
      homeAdvantageElo: Math.round(state.homeAdvantage),
      homeAdvantagePoints: Number((state.homeAdvantage / ELO_PER_POINT).toFixed(2)),
      leagueTotal: Number(state.leagueTotal.toFixed(1)),
    },
    disclaimer: DISCLAIMER,
  };
}

export { MARGIN_KEY_WEIGHTS, MARGIN_SIGMA, TOTAL_SIGMA };

// Build the full, explainable prediction for one baseball game.
//
// Like football, everything comes out of ONE run distribution — the winner, the
// total, the run line, the likely scores — so the figures cannot contradict each
// other. Unlike football, the biggest single input is a named individual, so the
// breakdown has to say who is pitching and what the model thinks that is worth.

import {
  expectedRuns,
  expectedTotalRuns,
  gridForDisplay,
  impliedFromMoneyline,
  marginDistribution,
  overProbability,
  pythagorean,
  runDistribution,
  runLine,
  topScorelines,
  winProbability,
  HOME_ADVANTAGE,
  RUN_SENSITIVITY,
  type MarketProbabilities,
  type RunMargin,
  type ScoreLine,
} from './model.ts';
import {
  getEloRank,
  getLeagueLatestDate,
  getMeetings,
  getPitcher,
  getRating,
  getRecentGames,
  getRecords,
  getRotation,
  getTeam,
} from './repo.ts';
import { getHomePark, getParkFactor } from './parkFactors.ts';
import { getLeagueRunsPerGame } from './ratings.ts';
import type { BsbRecord, LeagueId } from './types.ts';

export const DISCLAIMER =
  'Estimación estadística basada en Elo con ventaja de campo, el lanzador abridor anunciado, ' +
  'el factor del estadio y una distribución binomial negativa de carreras, comparada con las ' +
  'cuotas del mercado. NO conoce el bullpen, ni la alineación, ni las lesiones de última hora, ' +
  'ni el clima del día. No es una certeza ni una recomendación para apostar.';

/** The over/under line the app quotes when the market doesn't supply one. */
export const DEFAULT_TOTAL_LINE = 8.5;

export type ReliabilityLevel = 'high' | 'medium' | 'low';

const ELO_SIGMA_C = 200;
/**
 * Games of history that actually inform TODAY's rating.
 *
 * Capped at roughly one season. The database holds sixteen years, and taken at
 * face value that makes every Elo look known to within a hair — the badge came
 * out "fiabilidad alta ±0.8 pp" for every MLB game, which is both wrong and
 * useless. What limits the precision of a rating is not how many games were ever
 * played, it is how many of them describe the current roster; a 2011 Brewers game
 * says nothing about the 2025 Brewers. So the sample that counts is bounded.
 */
const EFFECTIVE_GAMES_CAP = 162;
const STALE_SIGMA_PER_MONTH = 25;
const STALE_SIGMA_CAP = 150;
const MIN_GAMES_FOR_ANY_CONFIDENCE = 30;
const GAMES_FOR_HIGH = 200;
const MARGIN_HIGH_MAX = 3;
const MARGIN_LOW_MIN = 7;

export interface BsbStarter {
  id: string | null;
  name: string | null;
  starts: number;
  /** Runs allowed per start, raw. */
  runsPerStart: number | null;
  /** Opponent-adjusted run-suppression ratio; below 1 = better than average. */
  rating: number | null;
  /** How this starter multiplies the runs the OTHER team is expected to score. */
  runFactor: number;
  /** Plain wording for the card. */
  label: string;
}

export interface BsbSide {
  id: string;
  name: string;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  rs: number | null;
  ra: number | null;
  pythagorean: number | null;
  record: BsbRecord;
  venueRecord: BsbRecord;
  last10: ('W' | 'L')[];
  expectedRuns: number;
  starter: BsbStarter;
}

export interface BsbReliability {
  level: ReliabilityLevel;
  label: string;
  marginPp: number;
  reasons: string[];
  gamesBehind: { home: number; away: number };
}

export interface BsbMarketComparison {
  market: (MarketProbabilities & { odds: { home: number; away: number } }) | null;
  edge: { home: number; away: number } | null;
  verdict: 'value_home' | 'value_away' | 'agree' | 'no_market';
}

export const VALUE_THRESHOLD = 0.05;

export interface BsbPrediction {
  league: LeagueId;
  teams: { home: BsbSide; away: BsbSide };
  model: { home: number; away: number };
  runs: {
    expectedHome: number;
    expectedAway: number;
    expectedTotal: number;
    totalLine: number;
    over: number;
    under: number;
    /** Home team wins by 2+ / everything else. Baseball's fixed ±1.5 handicap. */
    runLine: { homeCovers: number; awayCovers: number };
    /** Probability the nine innings end level. */
    extraInnings: number;
    scorelines: (ScoreLine & { label: string })[];
    grid: { cells: number[][]; maxRuns: number; tail: number };
    margins: RunMargin[];
  };
  /**
   * The ballpark, when it is known.
   *
   * On the prediction and not just inside the arithmetic, because this app's whole
   * claim is that every signal is visible. A reader who sees "202 carreras
   * esperadas" at Coors deserves to know that 23 % of it is the altitude, not the
   * two line-ups.
   */
  park: {
    site: string;
    name: string;
    factor: number;
    games: number;
    /** Runs the stadium adds or removes versus a neutral one, for this matchup. */
    runsVsNeutral: number;
  } | null;
  market: BsbMarketComparison;
  h2h: {
    total: number;
    homeWins: number;
    awayWins: number;
    recent: { date: string; homeId: string; awayId: string; homeRuns: number; awayRuns: number }[];
  };
  reasoning: {
    factors: { key: 'rating' | 'home' | 'pitching'; label: string; pointsForHome: number }[];
    text: string;
  };
  reliability: BsbReliability;
  summary: { headline: string; bullets: string[] };
  verdict: { outcome: 'home' | 'away'; label: string; probability: number; close: boolean };
  disclaimer: string;
}

const pct1 = (p: number) => (p * 100).toFixed(1);
const round2 = (n: number) => Math.round(n * 100) / 100;

function sigmaFor(games: number, monthsStale: number): number {
  const sample = ELO_SIGMA_C / Math.sqrt(games + 1);
  const stale = Math.min(monthsStale * STALE_SIGMA_PER_MONTH, STALE_SIGMA_CAP);
  return Math.sqrt(sample * sample + stale * stale);
}

function humanGap(days: number): string {
  if (days < 60) return `${days} días`;
  const months = Math.round(days / 30);
  if (months < 24) return `~${months} meses`;
  const years = Math.round(days / 365);
  return years === 1 ? '~1 año' : `~${years} años`;
}

function describeStarter(rating: number | null, starts: number): string {
  if (rating == null || starts === 0) return 'sin datos: se supone un abridor medio';
  const pctBetter = Math.round((1 - rating) * 100);
  if (Math.abs(pctBetter) < 4) return `en la media (${starts} aperturas)`;
  return pctBetter > 0
    ? `permite ~${pctBetter}% menos carreras de lo esperado (${starts} aperturas)`
    : `permite ~${-pctBetter}% más carreras de lo esperado (${starts} aperturas)`;
}

function buildStarter(league: LeagueId, id: string | null, weightApplied: number): BsbStarter {
  const row = id ? getPitcher(league, id) : null;
  const rating = row?.rating ?? null;
  return {
    id: id ?? null,
    name: row?.name ?? null,
    starts: row?.starts ?? 0,
    runsPerStart: row?.runs_per_9 ?? null,
    rating,
    runFactor: weightApplied,
    label: describeStarter(rating, row?.starts ?? 0),
  };
}

function buildSide(league: LeagueId, id: string, isHome: boolean): BsbSide {
  const team = getTeam(league, id);
  const rating = getRating(league, id);
  const rec = getRecords(league, id);
  return {
    id,
    name: team?.name ?? id,
    elo: rating.elo,
    eloRank: getEloRank(league, id),
    gamesInDb: rating.games_played,
    rs: rating.rs,
    ra: rating.ra,
    pythagorean: rating.rs != null && rating.ra != null ? pythagorean(rating.rs, rating.ra) : null,
    record: rec.overall,
    venueRecord: isHome ? rec.home : rec.away,
    last10: getRecentGames(league, id, 10).map((g) => g.result),
    expectedRuns: 0,
    starter: { id: null, name: null, starts: 0, runsPerStart: null, rating: null, runFactor: 1, label: '' },
  };
}

/**
 * Fall back to a team's most-used starter when the probables feed is silent.
 *
 * Better than assuming an average arm — a rotation's number one starts about a
 * fifth of the games and is a genuinely better guess than nobody — but it is a
 * GUESS, and the card says so rather than presenting it as an announcement.
 */
function guessStarter(league: LeagueId, teamId: string): string | null {
  const rotation = getRotation(league, teamId, 1);
  return rotation[0]?.id ?? null;
}

export function buildBaseballPrediction(
  league: LeagueId,
  homeId: string,
  awayId: string,
  market: { oddsHome: number | null; oddsAway: number | null } = { oddsHome: null, oddsAway: null },
  opts: {
    homeStarter?: string | null;
    awayStarter?: string | null;
    /** Fill unknown starters with the team's most-used arm. */
    guessStarters?: boolean;
    totalLine?: number;
  } = {},
): BsbPrediction {
  const home = buildSide(league, homeId, true);
  const away = buildSide(league, awayId, false);
  const leagueRuns = getLeagueRunsPerGame(league);
  const totalLine = opts.totalLine ?? DEFAULT_TOTAL_LINE;

  const guess = opts.guessStarters !== false;
  const homeSpId = opts.homeStarter ?? (guess ? guessStarter(league, homeId) : null);
  const awaySpId = opts.awayStarter ?? (guess ? guessStarter(league, awayId) : null);
  const homeSp = getPitcher(league, homeSpId ?? '')?.rating ?? null;
  const awaySp = getPitcher(league, awaySpId ?? '')?.rating ?? null;

  // The ballpark. Read from the home team's recent schedule rather than
  // configured, so a club that changed stadium is followed automatically.
  const park = getParkFactor(league, getHomePark(league, homeId));

  const lambda = expectedRuns(home.elo, away.elo, leagueRuns, {
    homePitcher: homeSp,
    awayPitcher: awaySp,
    parkFactor: park?.factor ?? null,
  });
  home.expectedRuns = round2(lambda.home);
  away.expectedRuns = round2(lambda.away);
  // A starter's factor lands on the OPPOSITION's runs, so the number shown next
  // to a pitcher is how much he suppresses what the other side scores.
  home.starter = buildStarter(league, homeSpId, round2(lambda.away / lambda.baseAway));
  away.starter = buildStarter(league, awaySpId, round2(lambda.home / lambda.baseHome));

  const dist = runDistribution(lambda.home, lambda.away);
  // Named once and used everywhere it is quoted, so the total on the card, the
  // park's contribution and the bullet text cannot come from different bases.
  const expectedTotal = round2(expectedTotalRuns(dist));
  const win = winProbability(dist);
  const over = overProbability(dist, totalLine);
  const line = runLine(dist);
  const scorelines = topScorelines(dist, 6).map((s) => ({ ...s, label: `${s.home}-${s.away}` }));

  // ---- market ----
  let marketComparison: BsbMarketComparison = { market: null, edge: null, verdict: 'no_market' };
  if (market.oddsHome && market.oddsAway) {
    const implied = impliedFromMoneyline(market.oddsHome, market.oddsAway);
    if (implied) {
      const edge = { home: win.home - implied.home, away: win.away - implied.away };
      const best = edge.home >= edge.away ? 'home' : 'away';
      marketComparison = {
        market: { ...implied, odds: { home: market.oddsHome, away: market.oddsAway } },
        edge,
        verdict: edge[best] > VALUE_THRESHOLD ? (`value_${best}` as 'value_home' | 'value_away') : 'agree',
      };
    }
  }

  // ---- head to head ----
  const meetings = getMeetings(league, homeId, awayId, 8);
  let hw = 0;
  let aw = 0;
  for (const m of meetings) {
    const homeIsSubject = m.homeId === homeId;
    const rf = homeIsSubject ? m.homeRuns : m.awayRuns;
    const ra = homeIsSubject ? m.awayRuns : m.homeRuns;
    if (rf > ra) hw++;
    else if (rf < ra) aw++;
  }

  // ---- reliability ----
  const latest = getLeagueLatestDate(league);
  const staleMonths = (lastDate: string | null): number => {
    if (!lastDate || !latest) return 0;
    const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    return Math.max(0, (d(latest) - d(lastDate)) / 86_400_000 / 30);
  };
  const homeStale = staleMonths(getRating(league, homeId).last_date);
  const awayStale = staleMonths(getRating(league, awayId).last_date);
  const effective = (games: number) => Math.min(games, EFFECTIVE_GAMES_CAP);
  const sigmaGap = Math.sqrt(
    sigmaFor(effective(home.gamesInDb), homeStale) ** 2 +
      sigmaFor(effective(away.gamesInDb), awayStale) ** 2,
  );
  const pTop = Math.max(win.home, win.away);
  const slope = (Math.LN10 * pTop * (1 - pTop)) / 400;
  const marginPp = Math.round(Math.min(sigmaGap * slope * 100, 20) * 10) / 10;

  const reasons: string[] = [];
  for (const [side, stale] of [
    [home, homeStale],
    [away, awayStale],
  ] as [BsbSide, number][]) {
    if (side.gamesInDb < MIN_GAMES_FOR_ANY_CONFIDENCE) {
      reasons.push(`${side.name} tiene solo ${side.gamesInDb} partidos en el historial.`);
    }
    if (stale >= 5) {
      reasons.push(
        `${side.name} no juega desde hace ${humanGap(Math.round(stale * 30))}: su Elo describe a la plantilla de entonces.`,
      );
    }
  }
  for (const side of [home, away]) {
    if (!side.starter.id) {
      reasons.push(
        `No se conoce el abridor de ${side.name}: se asume uno medio, y en béisbol eso es mucha incertidumbre.`,
      );
    } else if (side.starter.starts < 10) {
      reasons.push(
        `${side.starter.name} tiene solo ${side.starter.starts} aperturas: su valoración aún pesa poco.`,
      );
    }
  }
  const worstGames = Math.min(home.gamesInDb, away.gamesInDb);
  const worstStale = Math.max(homeStale, awayStale);
  const unknownStarter = !home.starter.id || !away.starter.id;
  const level: ReliabilityLevel =
    worstGames < MIN_GAMES_FOR_ANY_CONFIDENCE || marginPp >= MARGIN_LOW_MIN || worstStale >= 5
      ? 'low'
      : worstGames >= GAMES_FOR_HIGH && marginPp <= MARGIN_HIGH_MAX && worstStale < 2 && !unknownStarter
        ? 'high'
        : 'medium';
  const reliability: BsbReliability = {
    level,
    label: level === 'high' ? 'fiabilidad alta' : level === 'medium' ? 'fiabilidad media' : 'fiabilidad baja',
    marginPp,
    reasons,
    gamesBehind: { home: home.gamesInDb, away: away.gamesInDb },
  };

  // ---- verdict ----
  const outcome: 'home' | 'away' = win.home >= win.away ? 'home' : 'away';
  const outcomeProb = outcome === 'home' ? win.home : win.away;
  const outcomeLabel = outcome === 'home' ? `Gana ${home.name}` : `Gana ${away.name}`;
  // Baseball is a coin flip far more often than the other three sports. Anything
  // under 55% deserves to be called what it is rather than dressed up as a pick.
  const close = outcomeProb < 0.55;

  // ---- reasoning ----
  const ratingGap = Math.round((home.elo - away.elo) * 10) / 10;
  // The pitching matchup expressed in Elo points, by inverting the Elo→runs
  // conversion, so it sits on the same scale as the other two factors.
  const pitchRatio = (lambda.home / lambda.baseHome) / (lambda.away / lambda.baseAway);
  const pitchingElo = Math.round((Math.log10(pitchRatio) * 400) / RUN_SENSITIVITY);
  const factors: BsbPrediction['reasoning']['factors'] = [
    { key: 'rating', label: 'Elo (nivel del equipo)', pointsForHome: ratingGap },
    { key: 'home', label: 'Ventaja de campo', pointsForHome: HOME_ADVANTAGE },
  ];
  if (Math.abs(pitchingElo) >= 1) {
    factors.push({ key: 'pitching', label: 'Duelo de abridores', pointsForHome: pitchingElo });
  }
  const reasoningText =
    Math.abs(ratingGap) < 20
      ? `Los dos equipos están muy igualados en Elo; el duelo de abridores y la ventaja de campo deciden.`
      : ratingGap > 0
        ? `${home.name} es mejor equipo según el Elo (${Math.abs(ratingGap)} puntos) y juega en casa.`
        : `${away.name} es mejor equipo según el Elo (${Math.abs(ratingGap)} puntos), aunque juega fuera.`;

  // ---- summary ----
  const top = scorelines[0];
  const headline = close
    ? `Partido muy igualado: ${outcomeLabel} es solo ligeramente favorito (${pct1(outcomeProb)}%).`
    : `Lo más probable: ${outcomeLabel} (${pct1(outcomeProb)}%), con ${top.label} como marcador más probable (${pct1(top.probability)}%).`;

  const bullets: string[] = [];
  bullets.push(
    `Ganador: ${home.name} ${pct1(win.home)}% · ${away.name} ${pct1(win.away)}%. ` +
      `El béisbol es el deporte más igualado de los cuatro: el mejor equipo de la liga pierde ~60 partidos al año.`,
  );
  bullets.push(
    `Abridores: ${home.name} ${home.starter.name ?? 'sin anunciar'} (${home.starter.label}) · ` +
      `${away.name} ${away.starter.name ?? 'sin anunciar'} (${away.starter.label}).`,
  );
  bullets.push(
    `Carreras esperadas: ${home.name} ${home.expectedRuns} – ${away.expectedRuns} ${away.name} ` +
      `(total ${round2(expectedTotalRuns(dist))}).`,
  );
  bullets.push(
    `Más de ${totalLine} carreras: ${pct1(over)}% · menos: ${pct1(1 - over)}%. ` +
      `Línea de carreras: ${home.name} −1.5 al ${pct1(line.homeCovers)}%.`,
  );
  if (park && Math.abs(park.factor - 1) >= 0.02) {
    const pct = Math.round((park.factor - 1) * 100);
    const runs = round2(expectedTotal - expectedTotal / park.factor);
    bullets.push(
      `Estadio: ${park.name} ${pct > 0 ? 'sube' : 'baja'} el total un ${Math.abs(pct)}% ` +
        `(${runs > 0 ? '+' : ''}${runs} carreras) sobre un estadio neutro, medido en ${park.games} partidos allí. ` +
        `Ya está dentro de las carreras esperadas.`,
    );
  }
  bullets.push(
    `Probabilidad de entradas extra: ${pct1(dist.extraInnings)}% (en MLB ocurre en ~8-9% de los partidos).`,
  );
  bullets.push(
    `Elo: ${home.name} ${Math.round(home.elo)} (#${home.eloRank}) vs ${away.name} ${Math.round(away.elo)} (#${away.eloRank}).`,
  );
  bullets.push(
    `Balance: ${home.name} ${home.record.wins}-${home.record.losses} ` +
      `(${home.venueRecord.wins}-${home.venueRecord.losses} en casa); ` +
      `${away.name} ${away.record.wins}-${away.record.losses} ` +
      `(${away.venueRecord.wins}-${away.venueRecord.losses} fuera).`,
  );
  if (home.pythagorean != null && away.pythagorean != null) {
    bullets.push(
      `Pitagórico (lo que dicen sus carreras): ${home.name} ${pct1(home.pythagorean)}% · ` +
        `${away.name} ${pct1(away.pythagorean)}%. La diferencia con el balance real es la parte de suerte.`,
    );
  }
  if (home.last10.length && away.last10.length) {
    bullets.push(`Últimos 10: ${home.name} ${home.last10.join('')} · ${away.name} ${away.last10.join('')}.`);
  }
  if (meetings.length > 0) {
    bullets.push(
      `Historial directo reciente: ${home.name} ${hw}-${aw} ${away.name} en ${meetings.length} partidos. ` +
        `No entra en la probabilidad: el Elo ya recoge el nivel de ambos.`,
    );
  }
  if (marketComparison.market) {
    const m = marketComparison.market;
    if (marketComparison.verdict === 'agree') {
      bullets.push(`Las casas coinciden a grandes rasgos (${pct1(m.home)}% / ${pct1(m.away)}%).`);
    } else {
      const which = marketComparison.verdict === 'value_home' ? home.name : away.name;
      const diff = marketComparison.verdict === 'value_home' ? marketComparison.edge!.home : marketComparison.edge!.away;
      bullets.push(`El modelo da ${(diff * 100).toFixed(1)} pp más a ${which} que el mercado: posible value.`);
    }
  } else {
    bullets.push('Sin cuotas disponibles para comparar con el mercado.');
  }
  if (reliability.level !== 'high') {
    bullets.push(
      `⚠️ ${reliability.label.charAt(0).toUpperCase() + reliability.label.slice(1)}: ` +
        `tómalo como un rango (±${reliability.marginPp} pp).` +
        (reliability.reasons.length ? ` ${reliability.reasons[0]}` : ''),
    );
  }

  return {
    league,
    teams: { home, away },
    model: {
      home: Math.round(win.home * 100000) / 100000,
      away: Math.round(win.away * 100000) / 100000,
    },
    runs: {
      expectedHome: home.expectedRuns,
      expectedAway: away.expectedRuns,
      expectedTotal,
      totalLine,
      over: Math.round(over * 100000) / 100000,
      under: Math.round((1 - over) * 100000) / 100000,
      runLine: {
        homeCovers: Math.round(line.homeCovers * 100000) / 100000,
        awayCovers: Math.round(line.awayCovers * 100000) / 100000,
      },
      extraInnings: Math.round(dist.extraInnings * 100000) / 100000,
      scorelines,
      grid: gridForDisplay(dist),
      margins: marginDistribution(dist),
    },
    park: park
      ? {
          site: park.site,
          name: park.name,
          factor: park.factor,
          games: park.games,
          // What the factor is WORTH here, in runs — the unit the over/under is
          // priced in. A percentage is not actionable; "+1.9 carreras" is.
          //
          // Derived from expectedTotal and NOT from the raw lambdas, even though the
          // factor was applied to the lambdas: the distribution is truncated, so its
          // mean sits a little under their sum. Using the lambdas made the card claim
          // "+2.00 carreras" next to a total that had only moved 1.93 — two numbers
          // on one card computed from two different bases. The audit caught it.
          runsVsNeutral: round2(expectedTotal - expectedTotal / park.factor),
        }
      : null,
    market: marketComparison,
    h2h: { total: meetings.length, homeWins: hw, awayWins: aw, recent: meetings },
    reasoning: { factors, text: reasoningText },
    reliability,
    summary: { headline, bullets },
    verdict: { outcome, label: outcomeLabel, probability: outcomeProb, close },
    disclaimer: DISCLAIMER,
  };
}

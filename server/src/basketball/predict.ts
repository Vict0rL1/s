// ===========================================================================
// BASKETBALL PREDICTION = how the signals combine
// ===========================================================================
// Same principle as the tennis side: every signal is expressed in Elo points, so
// the number shown can be traced back through the breakdown. For each game:
//
//   rating_home  = Elo_home + rest_home
//   rating_away  = Elo_away + rest_away
//   P(home wins) = expectedScore(rating_home + HOME_COURT, rating_away)
//
// and three quantities a basketball bettor actually looks at come out of it:
//
//   • the moneyline probability,
//   • the expected MARGIN (comparable to a bookmaker's spread), from the Elo gap
//     at ~28 Elo per point,
//   • the expected TOTAL, from both teams' scoring and conceding rates.
//
// Everything is compared against the vig-free market probability, exactly as in
// tennis, and every figure comes with how much evidence sits behind it.
// ===========================================================================

import {
  calibratedHomeWinProbability,
  coverProbability,
  expectedMargin,
  expectedPoints,
  marginBands,
  overProbability,
  restAdjustment,
  HOME_ADVANTAGE,
  LONG_LAYOFF_DAYS,
  TOTAL_SIGMA,
  type MarginBand,
} from './elo.ts';
import {
  compareToMarket,
  impliedProbabilities,
  VALUE_THRESHOLD,
  type MarketComparison,
  type MarketProbabilities,
} from '../model/market.ts';
import {
  getEloRank,
  getLastGameDate,
  getLeagueAverageScore,
  getLeagueLatestDate,
  getMarginSigma,
  getMeetings,
  getRating,
  getRecentGames,
  getRecords,
  getTeam,
  type RecentGame,
} from './repo.ts';
import { daysBetween } from './ratings.ts';
import type { LeagueId, TeamRecord } from './types.ts';

export const DISCLAIMER =
  'Estimación estadística basada en Elo con ventaja de campo, margen de puntos, descanso y ' +
  'odds de mercado. NO considera lesiones ni bajas de última hora, rotaciones, minutos de ' +
  'descanso a estrellas ni partidos sin importancia al final de temporada. ' +
  'No es una certeza ni una recomendación para apostar.';

export type ConfidenceTier = 'toss_up' | 'slight' | 'clear' | 'strong';
export type ReliabilityLevel = 'high' | 'medium' | 'low';

/** Elo noise for a team with one game behind it; shrinks as C/√n. */
const ELO_SIGMA_C = 220;
/** Extra noise per month of staleness (an idle team's rating describes the past). */
const STALE_SIGMA_PER_MONTH = 25;
const STALE_SIGMA_CAP = 120;
const MIN_GAMES_FOR_ANY_CONFIDENCE = 10;
const GAMES_FOR_HIGH = 40;
const MARGIN_HIGH_MAX = 4;
const MARGIN_LOW_MIN = 9;

export interface Reliability {
  level: ReliabilityLevel;
  label: string;
  marginPp: number;
  range: { low: number; high: number };
  reasons: string[];
  gamesBehind: { home: number; away: number };
}

export interface TeamSide {
  id: string;
  name: string;
  abbreviation: string | null;
  logo: string | null;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  ppg: number | null;
  papg: number | null;
  record: TeamRecord;
  /** Record at this venue: home record for the home team, away for the away. */
  venueRecord: TeamRecord;
  /** Days since this team's previous game (null when unknown). */
  daysRest: number | null;
  /** True when the team played the day before — the classic fatigue case. */
  backToBack: boolean;
  /** Elo points this team gains or loses from its rest situation. */
  restAdjustment: number;
  last10: { won: boolean; pts: number; oppPts: number; home: boolean }[];
}

export interface ReasoningFactor {
  key: 'rating' | 'home' | 'rest';
  label: string;
  /** Elo points in favour of the HOME team (signed). */
  pointsForHome: number;
}

export interface HeadToHead {
  total: number;
  homeWins: number;
  awayWins: number;
  /** Average margin from the home team's perspective across all meetings. */
  averageMargin: number | null;
  /**
   * The same tally restricted to recent seasons. An all-time NBA head-to-head can
   * span 60 years and two different franchises' worth of players, so it says very
   * little about tonight; the recent window is the informative one.
   */
  recentSeasons: { seasons: number; homeWins: number; awayWins: number } | null;
  recent: {
    date: string;
    homeId: string;
    awayId: string;
    homePts: number;
    awayPts: number;
    isPlayoff: boolean;
  }[];
}

export interface ScoreProjection {
  /** Expected margin for the home team; negative means the away team is favoured. */
  margin: number;
  /** How the app would phrase a spread, e.g. "Celtics -6.5". */
  spreadLabel: string;
  home: number | null;
  away: number | null;
  total: number | null;
  /**
   * The spread and the total as PROBABILITIES rather than point estimates.
   *
   * "Celtics −6.5" says how much; it does not say how likely, and those are the
   * two markets people actually bet. The margin residual is close to normal
   * (sd 11.7, ±1σ within 2 pp of textbook over 58k games), so a normal is an
   * honest way to answer the second question.
   *
   * NOTE THE ABSENCE OF A WIN PROBABILITY HERE, on purpose. Integrating this
   * normal above zero gives ~72% where the Elo curve gives ~76% for the same
   * game: the two mappings (Elo→probability, and Elo→margin→probability) are
   * calibrated separately and are not forced to agree, and the normal
   * under-states big favourites because its tail is thinner than the logistic's.
   * The Elo probability is the one that was MEASURED against 58k results
   * (calibration within 0.7 pp in every band), so it stays the single answer to
   * "who wins" and this distribution answers only the two questions it was
   * measured for: covering the handicap (Brier 0.2495) and the total. Publishing
   * both would put two different numbers for one question on the same card.
   */
  distribution: {
    marginSigma: number;
    totalSigma: number;
    /** The line the app quotes: the projected margin rounded to a half point. */
    spreadLine: number;
    /** Probability the home team covers `spreadLine`. */
    homeCovers: number;
    totalLine: number | null;
    over: number | null;
    under: number | null;
    bands: MarginBand[];
  };
}

export interface GamePrediction {
  league: LeagueId;
  neutral: boolean;
  teams: { home: TeamSide; away: TeamSide };
  model: { probHome: number; probAway: number };
  projection: ScoreProjection;
  market: MarketComparison;
  h2h: HeadToHead;
  reasoning: { factors: ReasoningFactor[]; topFactor: ReasoningFactor | null; text: string };
  reliability: Reliability;
  summary: { headline: string; bullets: string[] };
  verdict: {
    favored: 'home' | 'away' | null;
    favoredName: string | null;
    confidence: ConfidenceTier;
    marginPct: number;
  };
  disclaimer: string;
}

function confidenceTier(prob: number): ConfidenceTier {
  const gap = Math.abs(prob - 0.5);
  if (gap < 0.05) return 'toss_up';
  if (gap < 0.12) return 'slight';
  if (gap < 0.25) return 'clear';
  return 'strong';
}

/** A gap in the largest unit that reads naturally ("~4 años", not "1489 días"). */
function humanGap(days: number): string {
  if (days < 60) return `${days} días`;
  const months = Math.round(days / 30);
  if (months < 24) return `~${months} meses`;
  const years = Math.round(days / 365);
  return years === 1 ? '~1 año' : `~${years} años`;
}

function sigmaFor(games: number, monthsStale: number): number {
  const sample = ELO_SIGMA_C / Math.sqrt(games + 1);
  const stale = Math.min(monthsStale * STALE_SIGMA_PER_MONTH, STALE_SIGMA_CAP);
  return Math.sqrt(sample * sample + stale * stale);
}

/**
 * How much evidence backs this probability. Same reasoning as the tennis version:
 * a first-order error propagation with a hand-set noise scale, honest about being
 * a heuristic, whose ORDER is what the backtest can validate.
 */
function computeReliability(
  probHome: number,
  home: { games: number; monthsStale: number; name: string },
  away: { games: number; monthsStale: number; name: string },
): Reliability {
  const s1 = sigmaFor(home.games, home.monthsStale);
  const s2 = sigmaFor(away.games, away.monthsStale);
  const sigmaGap = Math.sqrt(s1 * s1 + s2 * s2);
  // Slope of the Elo curve at this probability: how much one Elo point is worth.
  const slope = (Math.LN10 * probHome * (1 - probHome)) / 400;
  const marginPp = Math.round(Math.min(sigmaGap * slope * 100, 25) * 10) / 10;

  const reasons: string[] = [];
  for (const t of [home, away]) {
    if (t.games < MIN_GAMES_FOR_ANY_CONFIDENCE) {
      reasons.push(`${t.name} tiene solo ${t.games} partido(s) en el historial.`);
    } else if (t.games < GAMES_FOR_HIGH) {
      reasons.push(`Pocos partidos de ${t.name} (${t.games}): su Elo aún no es estable.`);
    }
    if (t.monthsStale >= 4) {
      reasons.push(
        `${t.name} no tiene partidos desde hace ${humanGap(Math.round(t.monthsStale * 30))}: ` +
          `su Elo describe a la plantilla de entonces, no necesariamente a la actual.`,
      );
    }
  }

  const worstGames = Math.min(home.games, away.games);
  const worstStale = Math.max(home.monthsStale, away.monthsStale);
  let level: ReliabilityLevel;
  if (worstGames < MIN_GAMES_FOR_ANY_CONFIDENCE || marginPp >= MARGIN_LOW_MIN || worstStale >= 4) {
    level = 'low';
  } else if (worstGames >= GAMES_FOR_HIGH && marginPp <= MARGIN_HIGH_MAX && worstStale < 2) {
    level = 'high';
  } else {
    level = 'medium';
  }

  return {
    level,
    label:
      level === 'high' ? 'fiabilidad alta' : level === 'medium' ? 'fiabilidad media' : 'fiabilidad baja',
    marginPp,
    range: {
      low: clamp01(probHome - marginPp / 100),
      high: clamp01(probHome + marginPp / 100),
    },
    reasons,
    gamesBehind: { home: home.games, away: away.games },
  };
}

function buildSide(
  league: LeagueId,
  id: string,
  isHome: boolean,
  referenceDate: string | null,
): TeamSide {
  const team = getTeam(league, id);
  const rating = getRating(league, id);
  const records = getRecords(league, id);
  const lastDate = getLastGameDate(league, id);
  // Rest is measured against the newest game in the LEAGUE, not today's date, so
  // a stale download isn't mistaken for a team that stopped playing — the same
  // choice the tennis side makes, and for the same reason.
  const rest = referenceDate ? daysBetween(lastDate, referenceDate) : null;
  const recent: RecentGame[] = getRecentGames(league, id, 10);
  return {
    id,
    name: team?.name ?? id,
    abbreviation: team?.abbreviation ?? null,
    logo: team?.logo ?? null,
    elo: rating.elo,
    eloRank: getEloRank(league, id),
    gamesInDb: rating.games_played,
    ppg: rating.ppg,
    papg: rating.papg,
    record: records.overall,
    venueRecord: isHome ? records.home : records.away,
    daysRest: rest,
    backToBack: rest === 0,
    restAdjustment: round1(restAdjustment(rest)),
    last10: recent.map((g) => ({ won: g.won, pts: g.pts, oppPts: g.oppPts, home: g.home })),
  };
}

const H2H_RECENT_SEASONS = 3;

function buildH2H(league: LeagueId, homeId: string, awayId: string): HeadToHead {
  const meetings = getMeetings(league, homeId, awayId);
  const latestSeason = meetings.length ? Math.max(...meetings.map((m) => m.season)) : 0;
  const cutoff = latestSeason - (H2H_RECENT_SEASONS - 1);
  let homeWins = 0;
  let awayWins = 0;
  let marginSum = 0;
  let recentHome = 0;
  let recentAway = 0;
  for (const m of meetings) {
    // Express every meeting from the CURRENT home team's point of view, whichever
    // side hosted back then — otherwise the tally silently mixes perspectives.
    const homeIsSubject = m.homeId === homeId;
    const subjectPts = homeIsSubject ? m.homePts : m.awayPts;
    const otherPts = homeIsSubject ? m.awayPts : m.homePts;
    const subjectWon = subjectPts > otherPts;
    if (subjectWon) homeWins++;
    else awayWins++;
    marginSum += subjectPts - otherPts;
    if (m.season >= cutoff) {
      if (subjectWon) recentHome++;
      else recentAway++;
    }
  }
  return {
    total: meetings.length,
    homeWins,
    awayWins,
    averageMargin: meetings.length ? round1(marginSum / meetings.length) : null,
    recentSeasons:
      recentHome + recentAway > 0
        ? { seasons: H2H_RECENT_SEASONS, homeWins: recentHome, awayWins: recentAway }
        : null,
    recent: meetings.slice(0, 6),
  };
}

const pct1 = (p: number) => (p * 100).toFixed(1);
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function clamp01(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100000) / 100000;
}

/** Spread label in the form bettors read: favourite first, negative number. */
function spreadLabel(margin: number, homeName: string, awayName: string): string {
  if (Math.abs(margin) < 0.25) return 'sin favorito claro (pick’em)';
  const fav = margin > 0 ? homeName : awayName;
  return `${fav} ${(-Math.abs(margin)).toFixed(1)}`;
}

function describeRest(side: TeamSide): string | null {
  if (side.daysRest == null) return null;
  if (side.backToBack) return `${side.name} juega en back-to-back (jugó el día anterior)`;
  if (side.daysRest === 1) return null; // the normal case; not worth a bullet
  // Past a week the gap is no longer "rest" but a layoff of unknown cause — most
  // often that the results simply end there. Saying "llega con 4064 días de
  // descanso" would be technically true and completely misleading.
  if (side.daysRest >= LONG_LAYOFF_DAYS) {
    return (
      `${side.name} no aparece con partidos desde hace ${humanGap(side.daysRest)} en los datos ` +
      `disponibles (no se aplica ajuste de descanso)`
    );
  }
  return `${side.name} llega con ${side.daysRest} días de descanso`;
}

/** Build the full, explainable prediction for one game. */
export function buildGamePrediction(
  league: LeagueId,
  homeId: string,
  awayId: string,
  market: { homeOdds: number | null; awayOdds: number | null } = { homeOdds: null, awayOdds: null },
  opts: { neutral?: boolean; gameDate?: string | null } = {},
): GamePrediction {
  // Rest is days from each team's previous game to THIS game. For a scheduled
  // fixture that is its own date; without one, fall back to the newest game on
  // record, which keeps a stale download from looking like an idle team.
  const reference = opts.gameDate ?? getLeagueLatestDate(league);
  const home = buildSide(league, homeId, true, reference);
  const away = buildSide(league, awayId, false, reference);
  const neutral = !!opts.neutral;

  const homeAdj = home.elo + home.restAdjustment;
  const awayAdj = away.elo + away.restAdjustment;

  // Round once and derive the complement, so the two sides always sum to exactly
  // 100.0% at the precision shown.
  const probHome = round5(
    calibratedHomeWinProbability(homeAdj, awayAdj, { neutral, homeAdvantage: HOME_ADVANTAGE }),
  );
  const probAway = round5(1 - probHome);

  const margin = round1(
    expectedMargin(homeAdj, awayAdj, { neutral, homeAdvantage: HOME_ADVANTAGE }),
  );
  const leagueAvg = getLeagueAverageScore(league);
  const points = expectedPoints(
    { ppg: home.ppg, papg: home.papg },
    { ppg: away.ppg, papg: away.papg },
    leagueAvg,
  );
  // Keep the projected score consistent with the projected margin: the Elo gap is
  // the better-measured quantity (MAE 9.2 points, zero bias in the backtest), so
  // the totals are re-centred on it rather than left to disagree.
  let projHome: number | null = null;
  let projAway: number | null = null;
  if (points) {
    const total = points.total;
    projHome = round1(total / 2 + margin / 2);
    projAway = round1(total / 2 - margin / 2);
  }

  // A half-point line never pushes, which is why books use them.
  const spreadLine = -(Math.round(margin * 2) / 2 + (Number.isInteger(margin * 2) ? 0.5 : 0));
  const totalLine =
    projHome != null && projAway != null
      ? Math.round((projHome + projAway) * 2) / 2 + 0.5
      : null;
  // Measured from recent seasons, not the frozen constant — and read ONCE, so the
  // handicap, the bands and the σ printed on the card can never describe three
  // different distributions.
  const marginSigma = getMarginSigma(league);
  const distribution = {
    // Reported EXACTLY as used, not rounded again: the stored value already carries
    // two decimals, and re-rounding to 14.1 here while `coverProbability` below runs
    // on 14.14 would publish a σ that does not reproduce the probabilities beside it.
    marginSigma,
    totalSigma: TOTAL_SIGMA,
    spreadLine: round1(spreadLine),
    homeCovers: round5(coverProbability(margin, spreadLine, marginSigma)),
    totalLine,
    over: totalLine != null ? round5(overProbability(projHome! + projAway!, totalLine)) : null,
    under: totalLine != null ? round5(1 - overProbability(projHome! + projAway!, totalLine)) : null,
    bands: marginBands(margin, marginSigma),
  };

  let marketProbs: MarketProbabilities | null = null;
  if (market.homeOdds && market.awayOdds) {
    marketProbs = impliedProbabilities(market.homeOdds, market.awayOdds);
  }
  const marketComparison = compareToMarket(probHome, marketProbs);

  const ratingGap = round1(home.elo - away.elo);
  const homeCourt = neutral ? 0 : HOME_ADVANTAGE;
  const restGap = round1(home.restAdjustment - away.restAdjustment);
  const factors: ReasoningFactor[] = [
    { key: 'rating', label: 'Elo (nivel del equipo)', pointsForHome: ratingGap },
    { key: 'home', label: neutral ? 'Cancha neutral' : 'Ventaja de campo', pointsForHome: homeCourt },
    { key: 'rest', label: 'Descanso', pointsForHome: restGap },
  ];
  const ranked = [...factors].sort((a, b) => Math.abs(b.pointsForHome) - Math.abs(a.pointsForHome));
  const top = ranked[0] ?? null;
  const favoredIsHome = probHome >= 0.5;
  const favName = favoredIsHome ? home.name : away.name;
  const dogName = favoredIsHome ? away.name : home.name;

  let reasoningText: string;
  if (!top || Math.abs(top.pointsForHome) < 1) {
    reasoningText = 'Los dos equipos están muy igualados en todas las señales.';
  } else {
    const driver = top.pointsForHome >= 0 ? home.name : away.name;
    reasoningText =
      driver === favName
        ? `El modelo favorece a ${favName}; lo que más pesa es ${top.label.toLowerCase()}.`
        : `El modelo favorece a ${favName}, aunque en ${top.label.toLowerCase()} la ventaja es de ${driver}.`;
  }

  const monthsStale = (d: number | null) => (d == null ? 0 : d / 30);
  const reliability = computeReliability(
    probHome,
    { games: home.gamesInDb, monthsStale: monthsStale(home.daysRest), name: home.name },
    { games: away.gamesInDb, monthsStale: monthsStale(away.daysRest), name: away.name },
  );

  const h2h = buildH2H(league, homeId, awayId);
  const confidence = confidenceTier(probHome);

  // ---------------- Plain-Spanish summary ----------------
  // Everything below restates figures computed above; no new modelling, so the
  // prose can never disagree with the numbers next to it.
  const favProb = pct1(Math.max(probHome, probAway));
  const headline =
    confidence === 'toss_up'
      ? `Partido muy parejo: ligerísima ventaja para ${favName} (${favProb}%). Cualquiera puede ganar.`
      : `Lo más probable: gana ${favName} (${favProb}%)` +
        (Math.abs(margin) >= 0.5
          ? `, por unos ${Math.abs(margin).toFixed(1)} puntos.`
          : ', en un partido muy ajustado.');

  const bullets: string[] = [];

  bullets.push(
    neutral
      ? `Cancha neutral: no se aplica ventaja de campo.`
      : `${home.name} juega en casa, lo que vale ${HOME_ADVANTAGE} puntos de Elo ` +
        `(en la NBA el local gana ~60% de los partidos).`,
  );

  bullets.push(
    `Elo: ${home.name} ${Math.round(home.elo)} (#${home.eloRank}) vs ` +
      `${away.name} ${Math.round(away.elo)} (#${away.eloRank}).`,
  );

  if (projHome != null && projAway != null) {
    bullets.push(
      `Marcador estimado: ${home.name} ${Math.round(projHome)} – ${Math.round(projAway)} ${away.name} ` +
        `(total ~${Math.round(projHome + projAway)} puntos).`,
    );
  }

  bullets.push(
    `Diferencia esperada: ${spreadLabel(margin, home.name, away.name)}. ` +
      `Ojo: el error típico de esta estimación es ~9 puntos, así que trátala como el centro de un rango amplio.`,
  );

  // Records, split by venue because that's the relevant one for each side.
  bullets.push(
    `Balance: ${home.name} ${home.record.wins}–${home.record.losses} ` +
      `(${home.venueRecord.wins}–${home.venueRecord.losses} en casa); ` +
      `${away.name} ${away.record.wins}–${away.record.losses} ` +
      `(${away.venueRecord.wins}–${away.venueRecord.losses} fuera).`,
  );

  const formOf = (s: TeamSide) => {
    const last = s.last10.slice(0, 5);
    if (last.length === 0) return null;
    const w = last.filter((g) => g.won).length;
    return `${s.name} ${w}–${last.length - w} en sus últimos ${last.length}`;
  };
  const f1 = formOf(home);
  const f2 = formOf(away);
  if (f1 && f2) bullets.push(`Forma reciente: ${f1}; ${f2}.`);

  const restNotes = [describeRest(home), describeRest(away)].filter(Boolean) as string[];
  if (restNotes.length) {
    bullets.push(
      `Descanso: ${restNotes.join('; ')}. ` +
        `El segundo partido de un back-to-back cuesta ~35 puntos de Elo (medido, no supuesto).`,
    );
  }

  if (h2h.total > 0) {
    const rs = h2h.recentSeasons;
    bullets.push(
      (rs
        ? `Historial directo reciente (${rs.seasons} temporadas): ` +
          `${home.name} ${rs.homeWins}–${rs.awayWins} ${away.name}. ` +
          `Histórico completo: ${h2h.homeWins}–${h2h.awayWins} en ${h2h.total} partidos`
        : `Historial directo: ${home.name} ${h2h.homeWins}–${h2h.awayWins} ${away.name} ` +
          `en ${h2h.total} enfrentamientos`) +
        (h2h.averageMargin != null
          ? `, diferencia media ${h2h.averageMargin > 0 ? '+' : ''}${h2h.averageMargin} para ${home.name}.`
          : '.') +
        ` No entra en la probabilidad: el Elo ya recoge el nivel de ambos.`,
    );
  } else {
    bullets.push('No hay enfrentamientos previos en el historial disponible.');
  }

  if (marketComparison.market) {
    const mFav = favoredIsHome
      ? marketComparison.market.implied1
      : marketComparison.market.implied2;
    const gapPp = (Math.max(probHome, probAway) - mFav) * 100;
    const mFavPct = pct1(mFav);
    if (Math.abs(gapPp) < VALUE_THRESHOLD * 100) {
      bullets.push(`Las casas coinciden (${mFavPct}% para ${favName}).`);
    } else if (gapPp > 0) {
      bullets.push(
        `El modelo es más optimista con ${favName} (${favProb}%) que el mercado (${mFavPct}%): posible value en ${favName}.`,
      );
    } else {
      bullets.push(
        `El mercado ve a ${favName} más favorito (${mFavPct}%) que el modelo (${favProb}%): el valor estaría en ${dogName}.`,
      );
    }
  } else {
    bullets.push('Sin cuotas disponibles para comparar con el mercado.');
  }

  if (reliability.level !== 'high') {
    bullets.push(
      `⚠️ ${reliability.label.charAt(0).toUpperCase() + reliability.label.slice(1)}: ` +
        `tómalo como un rango (${favProb}% ± ${reliability.marginPp} pp) más que como una cifra exacta.` +
        (reliability.reasons.length ? ` ${reliability.reasons[0]}` : ''),
    );
  }

  return {
    league,
    neutral,
    teams: { home, away },
    model: { probHome, probAway },
    projection: {
      margin,
      spreadLabel: spreadLabel(margin, home.name, away.name),
      home: projHome,
      away: projAway,
      total: projHome != null && projAway != null ? round1(projHome + projAway) : null,
      distribution,
    },
    market: marketComparison,
    h2h,
    reasoning: { factors, topFactor: top, text: reasoningText },
    reliability,
    summary: { headline, bullets },
    verdict: {
      favored: probHome === 0.5 ? null : favoredIsHome ? 'home' : 'away',
      favoredName: probHome === 0.5 ? null : favName,
      confidence,
      marginPct: Math.round(Math.abs(probHome - 0.5) * 1000) / 10,
    },
    disclaimer: DISCLAIMER,
  };
}

function round5(n: number): number {
  return Math.round(n * 100000) / 100000;
}

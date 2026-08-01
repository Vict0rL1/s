// Build the full, explainable prediction for one football fixture.
//
// Everything a user sees comes out of ONE score distribution (see model.ts), so
// the 1X2 probabilities, the over/under, both-teams-to-score and the likely
// scorelines are guaranteed to agree with each other. That is the main structural
// difference from the other two sports, where the win probability is the primary
// object and the scoreline is derived from it.

import {
  bothTeamsScoreProbability,
  expectedGoals,
  expectedTotalGoals,
  impliedFrom1X2,
  outcomeProbabilities,
  overProbability,
  scoreDistribution,
  topScorelines,
  HOME_ADVANTAGE,
  type MarketProbabilities1X2,
  type ScoreLine,
} from './model.ts';
import {
  getEloRank,
  getLeagueLatestDate,
  getMeetings,
  getRating,
  getRecentMatches,
  getRecords,
  getTeam,
} from './repo.ts';
import { getLeagueGoalsPerMatch } from './ratings.ts';
import type { FbRecord, LeagueId } from './types.ts';

export const DISCLAIMER =
  'Estimación estadística basada en Elo con ventaja de campo, goles esperados y odds de mercado. ' +
  'NO considera lesiones, alineaciones, sanciones, rotaciones por competición europea ni partidos ' +
  'sin nada en juego. No es una certeza ni una recomendación para apostar.';

export type ReliabilityLevel = 'high' | 'medium' | 'low';

const ELO_SIGMA_C = 240;
const STALE_SIGMA_PER_MONTH = 20;
const STALE_SIGMA_CAP = 120;
const MIN_MATCHES_FOR_ANY_CONFIDENCE = 8;
const MATCHES_FOR_HIGH = 40;
const MARGIN_HIGH_MAX = 4;
const MARGIN_LOW_MIN = 9;
/** Head-to-head only informs when it is recent; older meetings are other squads. */
const H2H_RECENT_SEASONS = 5;

export interface FbSide {
  id: string;
  name: string;
  elo: number;
  eloRank: number;
  matchesInDb: number;
  gf: number | null;
  ga: number | null;
  record: FbRecord;
  venueRecord: FbRecord;
  last5: ('W' | 'D' | 'L')[];
  /** Expected goals for this side in THIS fixture. */
  expectedGoals: number;
}

export interface FbReliability {
  level: ReliabilityLevel;
  label: string;
  marginPp: number;
  reasons: string[];
  matchesBehind: { home: number; away: number };
}

export interface FbHeadToHead {
  total: number;
  homeWins: number;
  draws: number;
  awayWins: number;
  recentSeasons: { seasons: number; homeWins: number; draws: number; awayWins: number } | null;
  recent: { date: string; homeId: string; awayId: string; homeGoals: number; awayGoals: number }[];
}

export interface FbMarketComparison {
  market: (MarketProbabilities1X2 & { overround: number; odds: { home: number; draw: number; away: number } }) | null;
  /** Model minus market, in probability points, per outcome. */
  edge: { home: number; draw: number; away: number } | null;
  verdict: 'value_home' | 'value_draw' | 'value_away' | 'agree' | 'no_market';
}

/** Flagged when the model rates an outcome this much higher than the market. */
export const VALUE_THRESHOLD = 0.05;

export interface FbPrediction {
  league: LeagueId;
  neutral: boolean;
  teams: { home: FbSide; away: FbSide };
  /** The three-way outcome probabilities. Always sum to 1. */
  model: MarketProbabilities1X2;
  goals: {
    expectedHome: number;
    expectedAway: number;
    expectedTotal: number;
    over25: number;
    under25: number;
    bothScore: number;
    /** Most likely exact scores, highest first. */
    scorelines: (ScoreLine & { label: string })[];
  };
  market: FbMarketComparison;
  h2h: FbHeadToHead;
  reasoning: {
    factors: { key: 'rating' | 'home'; label: string; pointsForHome: number }[];
    text: string;
  };
  reliability: FbReliability;
  summary: { headline: string; bullets: string[] };
  verdict: {
    outcome: 'home' | 'draw' | 'away';
    label: string;
    probability: number;
    /** True when no outcome clears 40% — genuinely open matches. */
    open: boolean;
  };
  disclaimer: string;
}

function sigmaFor(matches: number, monthsStale: number): number {
  const sample = ELO_SIGMA_C / Math.sqrt(matches + 1);
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

function buildSide(league: LeagueId, id: string, isHome: boolean): FbSide {
  const team = getTeam(league, id);
  const rating = getRating(league, id);
  const rec = getRecords(league, id);
  const recent = getRecentMatches(league, id, 5);
  return {
    id,
    name: team?.name ?? id,
    elo: rating.elo,
    eloRank: getEloRank(league, id),
    matchesInDb: rating.matches_played,
    gf: rating.gf,
    ga: rating.ga,
    record: rec.overall,
    venueRecord: isHome ? rec.home : rec.away,
    last5: recent.map((m) => m.result),
    expectedGoals: 0, // filled once the distribution is built
  };
}

const pct1 = (p: number) => (p * 100).toFixed(1);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build the prediction for a fixture between two teams of the same league. */
export function buildFootballPrediction(
  league: LeagueId,
  homeId: string,
  awayId: string,
  market: { oddsHome: number | null; oddsDraw: number | null; oddsAway: number | null } = {
    oddsHome: null,
    oddsDraw: null,
    oddsAway: null,
  },
  opts: { neutral?: boolean } = {},
): FbPrediction {
  const neutral = !!opts.neutral;
  const home = buildSide(league, homeId, true);
  const away = buildSide(league, awayId, false);
  const leagueGoals = getLeagueGoalsPerMatch(league);

  const lambda = expectedGoals(home.elo, away.elo, leagueGoals, { neutral });
  home.expectedGoals = round2(lambda.home);
  away.expectedGoals = round2(lambda.away);

  const dist = scoreDistribution(lambda.home, lambda.away);
  const probs = outcomeProbabilities(dist);
  const over25 = overProbability(dist, 2.5);
  const bts = bothTeamsScoreProbability(dist);
  const scorelines = topScorelines(dist, 6).map((s) => ({
    ...s,
    label: `${s.home}-${s.away}`,
  }));

  // ---- market ----
  let marketComparison: FbMarketComparison = { market: null, edge: null, verdict: 'no_market' };
  if (market.oddsHome && market.oddsDraw && market.oddsAway) {
    const implied = impliedFrom1X2(market.oddsHome, market.oddsDraw, market.oddsAway);
    if (implied) {
      const edge = {
        home: probs.home - implied.home,
        draw: probs.draw - implied.draw,
        away: probs.away - implied.away,
      };
      const best = (['home', 'draw', 'away'] as const).reduce((a, b) =>
        edge[a] >= edge[b] ? a : b,
      );
      marketComparison = {
        market: {
          ...implied,
          odds: { home: market.oddsHome, draw: market.oddsDraw, away: market.oddsAway },
        },
        edge,
        verdict:
          edge[best] > VALUE_THRESHOLD
            ? (`value_${best}` as 'value_home' | 'value_draw' | 'value_away')
            : 'agree',
      };
    }
  }

  // ---- head to head ----
  const meetings = getMeetings(league, homeId, awayId);
  const latestSeason = meetings.length ? Math.max(...meetings.map((m) => m.season)) : 0;
  const cutoff = latestSeason - (H2H_RECENT_SEASONS - 1);
  let hw = 0;
  let hd = 0;
  let ha = 0;
  let rw = 0;
  let rd = 0;
  let ra = 0;
  for (const m of meetings) {
    // Always from the CURRENT home team's point of view, whoever hosted then.
    const subjectIsHome = m.homeId === homeId;
    const gf = subjectIsHome ? m.homeGoals : m.awayGoals;
    const ga = subjectIsHome ? m.awayGoals : m.homeGoals;
    const res = gf > ga ? 'w' : gf === ga ? 'd' : 'a';
    if (res === 'w') hw++;
    else if (res === 'd') hd++;
    else ha++;
    if (m.season >= cutoff) {
      if (res === 'w') rw++;
      else if (res === 'd') rd++;
      else ra++;
    }
  }
  const h2h: FbHeadToHead = {
    total: meetings.length,
    homeWins: hw,
    draws: hd,
    awayWins: ha,
    recentSeasons:
      rw + rd + ra > 0
        ? { seasons: H2H_RECENT_SEASONS, homeWins: rw, draws: rd, awayWins: ra }
        : null,
    recent: meetings.slice(0, 6),
  };

  // ---- reliability ----
  const latest = getLeagueLatestDate(league);
  const staleMonths = (lastDate: string | null): number => {
    if (!lastDate || !latest) return 0;
    const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    return Math.max(0, (d(latest) - d(lastDate)) / 86_400_000 / 30);
  };
  const homeStale = staleMonths(getRating(league, homeId).last_date);
  const awayStale = staleMonths(getRating(league, awayId).last_date);
  const sigmaGap = Math.sqrt(
    sigmaFor(home.matchesInDb, homeStale) ** 2 + sigmaFor(away.matchesInDb, awayStale) ** 2,
  );
  // Slope of the outcome probability with respect to the rating gap, at the
  // most likely outcome — how much one Elo point is worth here.
  const pTop = Math.max(probs.home, probs.draw, probs.away);
  const slope = (Math.LN10 * pTop * (1 - pTop)) / 400;
  const marginPp = Math.round(Math.min(sigmaGap * slope * 100, 25) * 10) / 10;

  const reasons: string[] = [];
  for (const [side, stale] of [
    [home, homeStale],
    [away, awayStale],
  ] as [FbSide, number][]) {
    if (side.matchesInDb < MIN_MATCHES_FOR_ANY_CONFIDENCE) {
      reasons.push(
        `${side.name} tiene solo ${side.matchesInDb} partido(s) en el historial ` +
          `(recién ascendido o liga sin datos suficientes).`,
      );
    } else if (side.matchesInDb < MATCHES_FOR_HIGH) {
      reasons.push(`Pocos partidos de ${side.name} (${side.matchesInDb}): su Elo aún no es estable.`);
    }
    if (stale >= 4) {
      reasons.push(
        `${side.name} no tiene partidos desde hace ${humanGap(Math.round(stale * 30))}: ` +
          `su Elo describe a la plantilla de entonces.`,
      );
    }
  }
  const worstMatches = Math.min(home.matchesInDb, away.matchesInDb);
  const worstStale = Math.max(homeStale, awayStale);
  const level: ReliabilityLevel =
    worstMatches < MIN_MATCHES_FOR_ANY_CONFIDENCE || marginPp >= MARGIN_LOW_MIN || worstStale >= 4
      ? 'low'
      : worstMatches >= MATCHES_FOR_HIGH && marginPp <= MARGIN_HIGH_MAX && worstStale < 2
        ? 'high'
        : 'medium';
  const reliability: FbReliability = {
    level,
    label:
      level === 'high' ? 'fiabilidad alta' : level === 'medium' ? 'fiabilidad media' : 'fiabilidad baja',
    marginPp,
    reasons,
    matchesBehind: { home: home.matchesInDb, away: away.matchesInDb },
  };

  // ---- verdict ----
  const outcome: 'home' | 'draw' | 'away' =
    probs.home >= probs.draw && probs.home >= probs.away
      ? 'home'
      : probs.draw >= probs.away
        ? 'draw'
        : 'away';
  const outcomeProb = outcome === 'home' ? probs.home : outcome === 'draw' ? probs.draw : probs.away;
  const outcomeLabel =
    outcome === 'home' ? `Gana ${home.name}` : outcome === 'draw' ? 'Empate' : `Gana ${away.name}`;
  // Football is genuinely open far more often than the other two sports: with
  // three outcomes, a "favourite" at 38% is not a favourite in any useful sense.
  const open = outcomeProb < 0.4;

  // ---- reasoning ----
  const ratingGap = Math.round((home.elo - away.elo) * 10) / 10;
  const homeCourt = neutral ? 0 : HOME_ADVANTAGE;
  const factors = [
    { key: 'rating' as const, label: 'Elo (nivel del equipo)', pointsForHome: ratingGap },
    {
      key: 'home' as const,
      label: neutral ? 'Campo neutral' : 'Ventaja de campo',
      pointsForHome: homeCourt,
    },
  ];
  const reasoningText =
    Math.abs(ratingGap) < 15
      ? `Los dos equipos están muy igualados en Elo${neutral ? '' : '; la ventaja de campo inclina la balanza'}.`
      : ratingGap > 0
        ? `${home.name} es mejor equipo según el Elo (${Math.abs(ratingGap)} puntos)${neutral ? '' : ', y además juega en casa'}.`
        : `${away.name} es mejor equipo según el Elo (${Math.abs(ratingGap)} puntos)${neutral ? '' : ', aunque juega fuera'}.`;

  // ---- summary ----
  const top = scorelines[0];
  // Never lowercase the label: it contains a club name, and "gana manchester
  // city fc" reads like a bug even though the number is right.
  const headline = open
    ? `Partido abierto: ninguna opción llega al 40%. La más probable es «${outcomeLabel}» (${pct1(outcomeProb)}%).`
    : `Lo más probable: ${outcomeLabel} (${pct1(outcomeProb)}%), con ${top.label} como marcador más probable (${pct1(top.probability)}%).`;

  const bullets: string[] = [];
  bullets.push(
    `1X2: ${home.name} ${pct1(probs.home)}% · empate ${pct1(probs.draw)}% · ${away.name} ${pct1(probs.away)}%.` +
      ` El empate se lleva ~1 de cada 4 partidos en el fútbol, por eso siempre aparece como opción real.`,
  );
  bullets.push(
    `Goles esperados: ${home.name} ${home.expectedGoals} – ${away.expectedGoals} ${away.name} ` +
      `(total ${round2(expectedTotalGoals(dist))}).`,
  );
  bullets.push(
    `Más de 2.5 goles: ${pct1(over25)}% · menos de 2.5: ${pct1(1 - over25)}% · ambos marcan: ${pct1(bts)}%.`,
  );
  bullets.push(
    `Marcadores más probables: ${scorelines.slice(0, 3).map((s) => `${s.label} (${pct1(s.probability)}%)`).join(', ')}.`,
  );
  bullets.push(
    neutral
      ? 'Campo neutral: no se aplica ventaja de campo.'
      : `${home.name} juega en casa (+${HOME_ADVANTAGE} puntos de Elo).`,
  );
  bullets.push(
    `Elo: ${home.name} ${Math.round(home.elo)} (#${home.eloRank}) vs ${away.name} ${Math.round(away.elo)} (#${away.eloRank}).`,
  );
  bullets.push(
    `Balance: ${home.name} ${home.record.wins}G-${home.record.draws}E-${home.record.losses}P ` +
      `(${home.venueRecord.wins}-${home.venueRecord.draws}-${home.venueRecord.losses} en casa); ` +
      `${away.name} ${away.record.wins}-${away.record.draws}-${away.record.losses} ` +
      `(${away.venueRecord.wins}-${away.venueRecord.draws}-${away.venueRecord.losses} fuera).`,
  );
  if (home.last5.length && away.last5.length) {
    bullets.push(`Forma (últimos 5): ${home.name} ${home.last5.join('')} · ${away.name} ${away.last5.join('')}.`);
  }
  if (h2h.total > 0) {
    const rs = h2h.recentSeasons;
    bullets.push(
      (rs
        ? `Historial directo reciente (${rs.seasons} temporadas): ${home.name} ${rs.homeWins}-${rs.draws}-${rs.awayWins} ${away.name}. Histórico: ${hw}-${hd}-${ha}`
        : `Historial directo: ${home.name} ${hw}-${hd}-${ha} ${away.name}`) +
        ` en ${h2h.total} partidos. No entra en la probabilidad: el Elo ya recoge el nivel de ambos.`,
    );
  }
  if (marketComparison.market) {
    const m = marketComparison.market;
    const e = marketComparison.edge!;
    if (marketComparison.verdict === 'agree') {
      bullets.push(
        `Las casas coinciden a grandes rasgos (${pct1(m.home)}% / ${pct1(m.draw)}% / ${pct1(m.away)}%).`,
      );
    } else {
      const which =
        marketComparison.verdict === 'value_home'
          ? home.name
          : marketComparison.verdict === 'value_away'
            ? away.name
            : 'el empate';
      const diff =
        marketComparison.verdict === 'value_home' ? e.home : marketComparison.verdict === 'value_away' ? e.away : e.draw;
      bullets.push(
        `El modelo da ${(diff * 100).toFixed(1)} pp más a ${which} que el mercado: posible value.`,
      );
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
    neutral,
    teams: { home, away },
    model: {
      home: Math.round(probs.home * 100000) / 100000,
      draw: Math.round(probs.draw * 100000) / 100000,
      away: Math.round(probs.away * 100000) / 100000,
    },
    goals: {
      expectedHome: home.expectedGoals,
      expectedAway: away.expectedGoals,
      expectedTotal: round2(expectedTotalGoals(dist)),
      over25: Math.round(over25 * 100000) / 100000,
      under25: Math.round((1 - over25) * 100000) / 100000,
      bothScore: Math.round(bts * 100000) / 100000,
      scorelines,
    },
    market: marketComparison,
    h2h,
    reasoning: { factors, text: reasoningText },
    reliability,
    summary: { headline, bullets },
    verdict: { outcome, label: outcomeLabel, probability: outcomeProb, open },
    disclaimer: DISCLAIMER,
  };
}

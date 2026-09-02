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
  gridForDisplay,
  impliedFrom1X2,
  marginDistribution,
  outcomeProbabilities,
  overProbability,
  scoreDistribution,
  topScorelines,
  GOAL_SENSITIVITY,
  HOME_ADVANTAGE,
  DIXON_COLES_RHO,
  type GoalMargin,
  type MarketProbabilities1X2,
  type ScoreLine,
} from './model.ts';
import {
  describeAvailability,
  hasSquadData,
  squadAvailability,
  NEUTRAL_AVAILABILITY,
  type SquadAvailability,
} from './players.ts';
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
import { getPromotionGap } from './promotion.ts';
import { expectedGoalsDc } from './bayes/dixonColes.ts';
import { getDcParams, dcKnowsTeam } from './bayes/repo.ts';
import type { FbRecord, LeagueId } from './types.ts';

export const DISCLAIMER =
  'Estimación estadística basada en Elo con ventaja de campo, goles esperados y odds de mercado. ' +
  'En la Premier League tiene en cuenta las bajas conocidas (lesiones y sanciones) y las que marques ' +
  'tú; en el resto de ligas no hay datos de plantilla, así que supone alineaciones habituales. ' +
  'Nunca sabe la alineación real hasta que se publica, ni si el partido no vale nada. ' +
  'No es una certeza ni una recomendación para apostar.';

export type ReliabilityLevel = 'high' | 'medium' | 'low';

/**
 * Mismo recorte que aplica el camino del Elo, por la misma razón.
 *
 * Una media de Poisson por debajo de 0.15 o por encima de 5 produce distribuciones de
 * marcador que ningún partido de liga ha tenido nunca. Con el Dixon-Coles pasa menos
 * —los priors ya encogen— pero puede pasar con un equipo de muy pocos partidos, y el
 * recorte cuesta una línea.
 */
const clampLambda = (x: number): number => Math.min(5, Math.max(0.15, x));

/**
 * Escala del error de estimación del Elo: σ(n) = C / √(n + 1), en puntos Elo.
 *
 * ===========================================================================
 * MEDIDO, YA NO PUESTO A MANO  (`npm run study:sigma`)
 * ===========================================================================
 * Esto valía 240 y nadie lo había medido nunca, cuando es el número que fija el
 * «± X pp» de TODAS las tarjetas de fútbol y, con él, si una tarjeta dice fiabilidad
 * alta o baja. La NFL sí tenía su sigma calibrada contra la línea de cierre.
 *
 * El Elo verdadero de un equipo no se observa, así que no hay nada contra lo que
 * comparar el estimado. Lo que sí se puede es descomponer la varianza de lo que sí se
 * ve. Para cada partido, el residuo entre la puntuación esperada y la real tiene dos
 * fuentes independientes: el azar propio del fútbol —que se CALCULA con las
 * probabilidades a tres bandas del modelo, no se estima— y el error del Elo. Restando
 * la primera queda la segunda, y ahí vive C.
 *
 * Sobre 30.321 partidos:
 *
 *     C = 82 Elo,  IC 95 % por bootstrap [55, 104]
 *
 * y la prueba que no depende de la regresión, comparando el error cuadrático medio
 * observado con el que predice cada valor de C:
 *
 *     partidos jugados   observado   predice C=240   predice C=82
 *     0–4                  0.00779       0.07470        0.00867
 *     5–9                  0.00264       0.02138        0.00248
 *     20–39               -0.00096       0.00572        0.00066
 *
 * En el tramo de pocos partidos —donde la señal es más fuerte y menos ambigua— 240
 * predice DIEZ VECES el error que realmente se observa. La banda publicada llevaba
 * todo este tiempo siendo unas tres veces más ancha de lo que los datos sostienen: un
 * partido entre dos equipos con 20 jornadas salía «±10.7 pp, fiabilidad baja» cuando
 * lo medido son ±4.7.
 *
 * ===========================================================================
 * POR QUÉ 105 Y NO 82
 * ===========================================================================
 * Se toma el EXTREMO ALTO del intervalo, no el valor central, y a propósito. El
 * estimador es ruidoso —el término que busca vale un 3 % de la varianza total— y los
 * dos errores posibles no cuestan lo mismo: una banda demasiado ancha hace que la app
 * parezca insegura de cosas que sabe, pero una demasiado estrecha le hace prometer
 * una precisión que no tiene, y eso es lo que no puede pasar. 105 sigue siendo 2,3
 * veces más ajustado que 240 sin apoyarse en la parte optimista de la medición.
 */
const ELO_SIGMA_C = 105;
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
  /**
   * Set when this club has never played in this division and its Elo was carried
   * up from the one below with that country's measured promotion gap. The card
   * says so, and the reliability band uses the gap's own error instead of the
   * "brand new team" default — see football/promotion.ts.
   */
  seededFrom: string | null;
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
    /**
     * The complete probability of every scoreline, `cells[home][away]`.
     *
     * Not a separate calculation: it is the object the 1X2, the over/under and
     * everything else above are sums of. `tail` is the mass beyond the printed
     * grid, so the cells plus the tail add up to 1.
     */
    grid: { cells: number[][]; maxGoals: number; tail: number };
    /** Probability of each winning margin, +N down to −N. */
    margins: GoalMargin[];
  };
  /**
   * Squad availability, where the league has player data. `null` means there is
   * none for this competition — which is a different thing from "everyone is
   * fit", and the interface says which.
   */
  squads: {
    home: SquadAvailability | null;
    away: SquadAvailability | null;
  };
  market: FbMarketComparison;
  h2h: FbHeadToHead;
  reasoning: {
    factors: { key: 'rating' | 'home' | 'squad'; label: string; pointsForHome: number }[];
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
    /**
     * La mejor doble oportunidad (1X o X2) con su probabilidad.
     *
     * Está aquí porque en un partido abierto es LO ÚNICO que se puede afirmar con
     * confianza, y la tarjeta se estaba callando justo ahí. Medido sobre los 30.321
     * partidos del archivo: 5.465 son abiertos (18,0 %) y en 4.491 de ellos —el
     * 82,2 %— una doble oportunidad pasa del 65 %. Decir «ninguna opción llega al
     * 40 %» y parar es esconder un 70 % detrás de tres treintaipicos.
     */
    doubleChance: { outcome: '1X' | 'X2'; label: string; probability: number };
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
    seededFrom: rating.seeded_from ?? null,
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

/**
 * Express the net effect of both sides' absences as Elo points for the home team.
 *
 * The absences multiply expected goals; the other two factors in the breakdown
 * are Elo points. Inverting the Elo→goals conversion (`tilt = 10^(gap·sens/400)`)
 * puts them on one scale, so a reader can see at a glance that a missing striker
 * was worth less than home advantage — which is the whole point of showing the
 * three side by side.
 */
function availabilityAsElo(
  homeSquad: SquadAvailability | null,
  awaySquad: SquadAvailability | null,
): number {
  if (!homeSquad && !awaySquad) return 0;
  const h = homeSquad ?? NEUTRAL_AVAILABILITY;
  const a = awaySquad ?? NEUTRAL_AVAILABILITY;
  // Net multiplier on the home side's goals relative to the away side's.
  const ratio = (h.attack * a.defence) / (a.attack * h.defence);
  return (Math.log10(ratio) * 400) / GOAL_SENSITIVITY;
}

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
  opts: { neutral?: boolean; outHome?: string[]; outAway?: string[] } = {},
): FbPrediction {
  const neutral = !!opts.neutral;
  const home = buildSide(league, homeId, true);
  const away = buildSide(league, awayId, false);
  const leagueGoals = getLeagueGoalsPerMatch(league);

  // Squad availability, where the league has player data at all. Absences the
  // source already knows about (injuries, suspensions) are applied automatically;
  // outHome/outAway are what the caller adds on top, which is how the user tells
  // the model something it cannot know — the published lineup.
  const squadsKnown = hasSquadData(league);
  const homeSquad = squadsKnown ? squadAvailability(league, homeId, opts.outHome ?? []) : null;
  const awaySquad = squadsKnown ? squadAvailability(league, awayId, opts.outAway ?? []) : null;

  // ===========================================================================
  // DE DÓNDE SALEN LAS DOS λ
  // ===========================================================================
  // Del Dixon-Coles jerárquico (bayes/dixonColes.ts) siempre que el ajuste conozca a
  // los dos equipos. Ataque y defensa estimados por separado sobre los goles, con
  // decay temporal y encogimiento hacia la media de la liga.
  //
  // Medido en la temporada de validación, 4.479 partidos, contra el camino anterior
  // (Elo → λ con un reparto fijo entre ataque y defensa):
  //
  //     marcador exacto   2.88894 → 2.87171   −0.01722  p = 0.0005
  //     hándicap −1       0.48410 → 0.47505   −0.00906  p = 0.0005
  //     más de 2.5 goles  0.68855 → 0.68241   −0.00615  p = 0.0195
  //     ambos marcan      0.69081 → 0.69014   −0.00067  p = 0.73
  //     1X2               1.01351 → 1.00925   −0.00426  p = 0.054
  //
  // El patrón dice exactamente qué se ganó: NADA en el 1X2 y bastante en la FORMA de
  // la distribución. Tiene sentido — el signo de la diferencia de goles ya lo capturaba
  // el Elo; lo que no podía capturar es que dos equipos con el mismo rating repartan
  // sus goles de formas distintas, y de esa forma dependen el over, el hándicap y el
  // marcador exacto. Los dos primeros pasan el listón de Bonferroni de la familia.
  //
  // EL CAMINO ANTIGUO SIGUE VIVO Y NO ES PEREZA. Un equipo que el ajuste no conoce
  // —el recién ascendido, que no ha jugado ni un partido en esta división— recibiría
  // ataque 0 y defensa 0, que aquí significa «exactamente la media de la liga». Y un
  // recién ascendido no es un equipo medio de su nueva categoría. Eso lo resuelve el
  // Elo con el salto de división medido en promotion.ts, así que para esos partidos se
  // usa aquel camino, que es el que tiene la respuesta buena.
  const dc = getDcParams(league);
  const useDc = dcKnowsTeam(dc, homeId) && dcKnowsTeam(dc, awayId);
  const availability = (a: SquadAvailability | null): { attack: number; defence: number } =>
    a ? { attack: a.attack, defence: a.defence } : { attack: 1, defence: 1 };

  let lambda: { home: number; away: number };
  let rho = DIXON_COLES_RHO;
  if (useDc && dc) {
    const base = expectedGoalsDc(dc, homeId, awayId, { neutral });
    // Las bajas siguen aplicándose igual y por fuera del ajuste: son información de
    // HOY que el histórico no puede contener, y mezclarlas con el ataque aprendido
    // haría imposible decir en la tarjeta qué parte del número es el equipo y qué
    // parte es que le falta el delantero.
    const ha = availability(homeSquad);
    const aa = availability(awaySquad);
    lambda = {
      home: clampLambda(base.home * ha.attack * aa.defence),
      away: clampLambda(base.away * aa.attack * ha.defence),
    };
    // ρ también sale del ajuste: es un parámetro más, estimado sobre esta liga en vez
    // de la constante −0.1 que valía para todas.
    rho = dc.rho;
  } else {
    lambda = expectedGoals(home.elo, away.elo, leagueGoals, {
      neutral,
      homeAvailability: homeSquad ?? NEUTRAL_AVAILABILITY,
      awayAvailability: awaySquad ?? NEUTRAL_AVAILABILITY,
    });
  }
  home.expectedGoals = round2(lambda.home);
  away.expectedGoals = round2(lambda.away);

  const dist = scoreDistribution(lambda.home, lambda.away, rho);
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
  /**
   * A club whose rating was carried up from the division below is NOT an unknown
   * team. Feeding its zero matches into sigmaFor would return 240 Elo — the "we
   * know nothing" value — and produce a ±25 pp band, when the transplant's own
   * error has been measured: 38 Elo in Spain, 77 in England (promotion.ts).
   *
   * So the measured spread is used instead. It is bigger than a settled club's and
   * smaller than a blank one's, which is exactly what is true about it.
   */
  const sideSigma = (side: FbSide, stale: number): number => {
    if (!side.seededFrom) return sigmaFor(side.matchesInDb, stale);
    const gap = getPromotionGap(league);
    return gap ? Math.max(gap.sd, 30) : sigmaFor(side.matchesInDb, stale);
  };
  const sigmaGap = Math.sqrt(sideSigma(home, homeStale) ** 2 + sideSigma(away, awayStale) ** 2);
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
    if (side.seededFrom) {
      reasons.push(
        `${side.name} acaba de subir: su Elo viene de ${side.seededFrom} con el salto de ` +
          `división medido para esta liga, no de partidos jugados aquí.`,
      );
    } else if (side.matchesInDb < MIN_MATCHES_FOR_ANY_CONFIDENCE) {
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
  // A promoted club has zero matches HERE and that is not the same as knowing
  // nothing about it: its rating came from a full season below plus a gap measured
  // on clubs that made the same jump, and that uncertainty is already inside
  // `marginPp`. Counting it a second time as "too few matches" produced a ±4.2 pp
  // band labelled "fiabilidad baja", which contradicts the app's own thresholds
  // two lines down. It is capped at "media" instead: better than a blank, never
  // presented as settled.
  const seeded = !!home.seededFrom || !!away.seededFrom;
  const settledMatches = [
    home.seededFrom ? Infinity : home.matchesInDb,
    away.seededFrom ? Infinity : away.matchesInDb,
  ];
  const worstMatches = Math.min(...settledMatches);
  const worstStale = Math.max(homeStale, awayStale);
  const level: ReliabilityLevel =
    worstMatches < MIN_MATCHES_FOR_ANY_CONFIDENCE || marginPp >= MARGIN_LOW_MIN || worstStale >= 4
      ? 'low'
      : seeded
        ? 'medium'
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
  //
  // EL EMPATE NUNCA SALE POR AQUÍ, y conviene saberlo: en los 30.321 partidos del
  // archivo el empate no es la opción más probable ni una sola vez. No es casualidad
  // ni un fallo, es aritmética. La probabilidad de empate más alta que este modelo
  // llega a producir es 32,1 %, así que para que el empate ganase harían falta las
  // otras dos por debajo de eso — y entre las dos tienen que sumar el 67,9 % restante,
  // que no cabe en dos números menores de 32,1.
  //
  // La rama se queda porque es la lectura correcta de «el más probable» y porque el
  // día que el modelo de goles cambie dejará de ser inalcanzable. Lo que NO puede
  // quedarse es una tarjeta que, en un partido igualado, solo sepa decir cuál de tres
  // treintaipicos es el mayor. Para eso está la doble oportunidad de abajo.
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

  const pHomeDraw = probs.home + probs.draw;
  const pDrawAway = probs.draw + probs.away;
  const doubleChance =
    pHomeDraw >= pDrawAway
      ? {
          outcome: '1X' as const,
          label: `${home.name} o empate`,
          probability: pHomeDraw,
        }
      : {
          outcome: 'X2' as const,
          label: `Empate o ${away.name}`,
          probability: pDrawAway,
        };

  // ---- reasoning ----
  const ratingGap = Math.round((home.elo - away.elo) * 10) / 10;
  const homeCourt = neutral ? 0 : HOME_ADVANTAGE;
  const factors: FbPrediction['reasoning']['factors'] = [
    { key: 'rating', label: 'Elo (nivel del equipo)', pointsForHome: ratingGap },
    {
      key: 'home',
      label: neutral ? 'Campo neutral' : 'Ventaja de campo',
      pointsForHome: homeCourt,
    },
  ];
  // Absences act on goals, not on the rating, so there is no Elo number to show.
  // Converting the goal effect back to the Elo points that would have produced it
  // puts it on the same scale as the other two factors, which is the only way the
  // breakdown reads as one thing rather than two.
  const squadElo = availabilityAsElo(homeSquad, awaySquad);
  if (Math.abs(squadElo) >= 1) {
    factors.push({ key: 'squad', label: 'Bajas y lesiones', pointsForHome: Math.round(squadElo) });
  }
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
    ? `Partido abierto: ninguna opción llega al 40%. Lo más sólido que se puede decir ` +
      `es «${doubleChance.label}» (${pct1(doubleChance.probability)}%); la opción suelta ` +
      `más probable es «${outcomeLabel}» (${pct1(outcomeProb)}%).`
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
  const homeAbsences = homeSquad ? describeAvailability(homeSquad, home.name) : null;
  const awayAbsences = awaySquad ? describeAvailability(awaySquad, away.name) : null;
  if (homeAbsences) bullets.push(homeAbsences);
  if (awayAbsences) bullets.push(awayAbsences);
  if (squadsKnown && !homeAbsences && !awayAbsences) {
    bullets.push(
      'Sin bajas conocidas en ninguno de los dos: la predicción supone las alineaciones habituales. ' +
        'Si sabes quién no juega, márcalo y los números se recalculan.',
    );
  }
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
      grid: gridForDisplay(dist),
      margins: marginDistribution(dist),
    },
    squads: { home: homeSquad, away: awaySquad },
    market: marketComparison,
    h2h,
    reasoning: { factors, text: reasoningText },
    reliability,
    summary: { headline, bullets },
    verdict: { outcome, label: outcomeLabel, probability: outcomeProb, open, doubleChance },
    disclaimer: DISCLAIMER,
  };
}

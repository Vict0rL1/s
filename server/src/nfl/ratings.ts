// Replay games chronologically to produce team ratings, scoring rates, and the
// two quantities this sport insists on tracking rather than assuming: the
// league's home-field advantage and the league's points per game.
//
// One replay, shared by the app and the backtest — the same arrangement as the
// other four sports and for the same reason. A backtest with its own copy of the
// update rules drifts, and then the accuracy it reports describes a model nobody
// is running. The callback hands over the pre-game state AND the expected margin
// and total the model itself computed, so the backtest scores the shipped
// arithmetic instead of a reimplementation of it.

import {
  carryOver,
  conditionsTotalAdjustment,
  eloExpectation,
  movMultiplier,
  BYE_WEEK_ELO,
  DIVISION_HOME_SCALE,
  ELO_PER_POINT,
  QB_CARRYOVER,
  QB_SPLIT,
  HOME_ADVANTAGE_ALPHA,
  HOME_ADVANTAGE_START,
  INITIAL_ELO,
  K_FACTOR,
  LEAGUE_TOTAL_ALPHA,
  LEAGUE_TOTAL_START,
  REST_ELO_PER_DAY,
  SCORING_ALPHA,
  SCORING_CARRYOVER,
  SEASON_CARRYOVER,
} from './model.ts';

export interface ReplayGame {
  season: number;
  week: number;
  game_date: string; // YYYYMMDD
  home_id: string;
  away_id: string;
  home_points: number;
  away_points: number;
  neutral: number;
  playoff: number;
  home_rest: number | null;
  away_rest: number | null;
  /**
   * Starting quarterback. nflverse fills these for every played game; a game
   * without them still replays, the quarterback split just has nothing to credit.
   */
  home_qb_id?: string | null;
  away_qb_id?: string | null;
  home_qb_name?: string | null;
  away_qb_name?: string | null;
  /** Conditions. `wind` and `temp` are null indoors and before a game is played. */
  roof?: string | null;
  wind?: number | null;
  /** Kick-off temperature in °F, as nflverse reports it. */
  temp?: number | null;
}

export interface NafTeamState {
  elo: number;
  games: number;
  lastDate: string | null;
  lastSeason: number | null;
  lastWeek: number | null;
  wins: number;
  losses: number;
  ties: number;
  homeWins: number;
  homeLosses: number;
  homeTies: number;
  awayWins: number;
  awayLosses: number;
  awayTies: number;
  /** EWMA of points scored / allowed per game. null until a team has played. */
  pointsFor: number | null;
  pointsAgainst: number | null;
  /** Running totals, for the record panel (not the model). */
  totalFor: number;
  totalAgainst: number;
}

/**
 * What the replay learns about one quarterback.
 *
 * `adjustment` is Elo points added to whatever team he starts for, so it is
 * directly comparable across teams: +40 is a quarterback worth two points of
 * margin more than a league-average starter.
 */
export interface NafQbState {
  id: string;
  name: string | null;
  adjustment: number;
  starts: number;
  lastSeason: number | null;
  lastDate: string | null;
}

export interface ReplayOptions {
  k?: number;
  carryover?: number;
  eloPerPoint?: number;
  /** Share of each result credited to the quarterback. 0 disables the split. */
  qbSplit?: number;
  qbCarryover?: number;
  /** false ignores roof and wind, for the measurement in docs/NFL.md. */
  conditions?: boolean;
  /** Fix the home advantage instead of tracking it. Used by the backtest. */
  homeAdvantage?: number;
  homeAdvantageStart?: number;
  /** 0 freezes the home-advantage tracker at its starting value. */
  homeAdvantageAlpha?: number;
  restEloPerDay?: number;
  byeWeekElo?: number;
  divisionHomeScale?: number;
  scoringAlpha?: number;
  scoringCarryover?: number;
  leagueTotalStart?: number;
  leagueTotalAlpha?: number;
  /** 0 turns the margin-of-victory multiplier off. */
  mov?: boolean;
  onGame?: (info: {
    game: ReplayGame;
    home: NafTeamState;
    away: NafTeamState;
    /** Everything the model believed BEFORE this game was played. */
    expectedMargin: number;
    expectedTotal: number;
    eloDiff: number;
    homeAdvantage: number;
    leagueTotal: number;
    /** The quarterback offsets that went into `eloDiff`, for the "why" panel. */
    homeQbAdjustment: number;
    awayQbAdjustment: number;
    /** Points the conditions moved the expected total by. */
    conditionsAdjustment: number;
  }) => void;
}

function freshTeam(): NafTeamState {
  return {
    elo: INITIAL_ELO,
    games: 0,
    lastDate: null,
    lastSeason: null,
    lastWeek: null,
    wins: 0,
    losses: 0,
    ties: 0,
    homeWins: 0,
    homeLosses: 0,
    homeTies: 0,
    awayWins: 0,
    awayLosses: 0,
    awayTies: 0,
    pointsFor: null,
    pointsAgainst: null,
    totalFor: 0,
    totalAgainst: 0,
  };
}

export interface ReplayResult {
  teams: Map<string, NafTeamState>;
  /** Every quarterback who started a game, with his offset. */
  qbs: Map<string, NafQbState>;
  /**
   * The quarterback who most recently started for each team.
   *
   * The prediction path needs this because nflverse names the starter for played
   * games but NOT for scheduled ones — so "who is playing quarterback next
   * Sunday" has to be answered with "whoever played last Sunday".
   */
  currentQb: Map<string, string>;
  /** Where the trackers ended up. The prediction path needs both. */
  homeAdvantage: number;
  leagueTotal: number;
}

/**
 * The home advantage, in Elo points, applied to one game.
 *
 * Neutral sites (London, the Super Bowl) get none — that is not a modelling
 * choice, it is what "neutral" means, and nflverse marks them.
 */
function homeEdgeFor(
  g: ReplayGame,
  tracked: number,
  restWeight: number,
  byeElo: number,
  divScale: number,
): number {
  if (g.neutral) return 0;
  let edge = tracked * (1 + (divScale || 0));
  if (restWeight && g.home_rest != null && g.away_rest != null) {
    edge += restWeight * (g.home_rest - g.away_rest);
  }
  if (byeElo) {
    if ((g.home_rest ?? 0) >= 10) edge += byeElo;
    if ((g.away_rest ?? 0) >= 10) edge -= byeElo;
  }
  return edge;
}

export function replayGames(games: ReplayGame[], opts: ReplayOptions = {}): ReplayResult {
  const k = opts.k ?? K_FACTOR;
  const carry = opts.carryover ?? SEASON_CARRYOVER;
  const perPoint = opts.eloPerPoint ?? ELO_PER_POINT;
  const restWeight = opts.restEloPerDay ?? REST_ELO_PER_DAY;
  const byeElo = opts.byeWeekElo ?? BYE_WEEK_ELO;
  const divScale = opts.divisionHomeScale ?? DIVISION_HOME_SCALE;
  const scoringAlpha = opts.scoringAlpha ?? SCORING_ALPHA;
  const scoringCarry = opts.scoringCarryover ?? SCORING_CARRYOVER;
  const totalAlpha = opts.leagueTotalAlpha ?? LEAGUE_TOTAL_ALPHA;
  const useMov = opts.mov !== false;

  // A fixed home advantage is available for the backtest to compare against, and
  // it is how the measurement in docs/NFL.md was made.
  const fixedEdge = opts.homeAdvantage;
  const edgeAlpha = fixedEdge != null ? 0 : (opts.homeAdvantageAlpha ?? HOME_ADVANTAGE_ALPHA);
  let homeEdge = fixedEdge ?? opts.homeAdvantageStart ?? HOME_ADVANTAGE_START;
  let leagueTotal = opts.leagueTotalStart ?? LEAGUE_TOTAL_START;

  const qbSplit = opts.qbSplit ?? QB_SPLIT;
  const qbCarry = opts.qbCarryover ?? QB_CARRYOVER;
  const useConditions = opts.conditions !== false;

  const teams = new Map<string, NafTeamState>();
  const team = (id: string) => {
    let s = teams.get(id);
    if (!s) teams.set(id, (s = freshTeam()));
    return s;
  };

  const qbs = new Map<string, NafQbState>();
  const currentQb = new Map<string, string>();
  /**
   * A quarterback nobody has seen starts at 0 — assumed league-average for his
   * team until results say otherwise, which is the right prior for a rookie and
   * for a backup alike.
   */
  const qb = (id: string, name: string | null | undefined): NafQbState => {
    let s = qbs.get(id);
    if (!s) {
      qbs.set(id, (s = { id, name: name ?? null, adjustment: 0, starts: 0, lastSeason: null, lastDate: null }));
    }
    if (name && !s.name) s.name = name;
    return s;
  };

  let season = games[0]?.season ?? 0;

  for (const g of games) {
    if (g.season !== season) {
      for (const s of teams.values()) {
        s.elo = carryOver(s.elo, carry);
        // Scoring rates regress toward the league too. A team that scored 30 a
        // game last year is not a 30-a-game team in September; it is a team the
        // league has had a winter to plan for.
        if (s.pointsFor != null) {
          s.pointsFor = leagueTotal / 2 + (s.pointsFor - leagueTotal / 2) * scoringCarry;
        }
        if (s.pointsAgainst != null) {
          s.pointsAgainst = leagueTotal / 2 + (s.pointsAgainst - leagueTotal / 2) * scoringCarry;
        }
      }
      // Quarterbacks regress on their own, slower schedule: a roster is rebuilt
      // every spring, an arm is not.
      for (const q of qbs.values()) q.adjustment *= qbCarry;
      season = g.season;
    }

    const home = team(g.home_id);
    const away = team(g.away_id);

    // The starting quarterback is part of how good a side is today, so his offset
    // goes into the rating gap alongside the team's own Elo.
    const homeQb = qbSplit > 0 && g.home_qb_id ? qb(g.home_qb_id, g.home_qb_name) : null;
    const awayQb = qbSplit > 0 && g.away_qb_id ? qb(g.away_qb_id, g.away_qb_name) : null;
    const homeQbAdj = homeQb?.adjustment ?? 0;
    const awayQbAdj = awayQb?.adjustment ?? 0;

    const edge = homeEdgeFor(g, homeEdge, restWeight, byeElo, divScale);
    const eloDiff = home.elo + homeQbAdj - (away.elo + awayQbAdj) + edge;
    const expectedMargin = eloDiff / perPoint;

    // The total is a matchup of two offences against two defences, each an EWMA
    // of points per game, with the league average standing in for a team that
    // has not played yet.
    const half = leagueTotal / 2;
    // Conditions move the total, never the margin: wind blows on both offences.
    const conditions = useConditions ? conditionsTotalAdjustment(g.roof, g.wind) : 0;
    const expectedTotal =
      ((home.pointsFor ?? half) + (away.pointsAgainst ?? half)) / 2 +
      ((away.pointsFor ?? half) + (home.pointsAgainst ?? half)) / 2 +
      conditions;

    opts.onGame?.({
      game: g,
      home,
      away,
      expectedMargin,
      expectedTotal,
      eloDiff,
      homeAdvantage: edge,
      leagueTotal,
      homeQbAdjustment: homeQbAdj,
      awayQbAdjustment: awayQbAdj,
      conditionsAdjustment: conditions,
    });

    // ---- update ----
    const expected = eloExpectation(eloDiff);
    const margin = g.home_points - g.away_points;
    const actual = margin > 0 ? 1 : margin === 0 ? 0.5 : 0;
    // The multiplier damps blowouts by teams already rated far ahead: the same
    // 30-point win says less about a team that was a 10-point favourite.
    const mult = useMov ? movMultiplier(Math.abs(margin), actual > 0.5 ? eloDiff : -eloDiff) : 1;
    const shift = k * mult * (actual - expected);

    // The home-field tracker reads the part of the result the RATINGS did not
    // explain, which is why it is computed against the post-update difference:
    // whatever home edge is left after both teams have been credited for the
    // game is the league's, not theirs.
    // The shift is SPLIT, not applied twice: whatever share the quarterbacks take
    // is share the teams do not, so one result still moves the league by exactly
    // one result's worth.
    const qbShare = homeQb && awayQb ? qbSplit : 0;
    const teamShift = shift * (1 - qbShare);

    const preDiff = home.elo - away.elo;
    home.elo += teamShift;
    away.elo -= teamShift;
    if (qbShare > 0 && homeQb && awayQb) {
      homeQb.adjustment += shift * qbShare;
      awayQb.adjustment -= shift * qbShare;
    }
    for (const [q, side] of [[homeQb, g.home_id], [awayQb, g.away_id]] as const) {
      if (!q) continue;
      q.starts++;
      q.lastSeason = g.season;
      q.lastDate = g.game_date;
      currentQb.set(side, q.id);
    }
    if (edgeAlpha > 0 && !g.neutral) {
      const unexplained = (margin - preDiff / perPoint) * perPoint;
      homeEdge = homeEdge * (1 - edgeAlpha) + edgeAlpha * unexplained;
    }

    home.games++;
    away.games++;
    home.lastDate = g.game_date;
    away.lastDate = g.game_date;
    home.lastSeason = g.season;
    away.lastSeason = g.season;
    home.lastWeek = g.week;
    away.lastWeek = g.week;

    if (margin > 0) {
      home.wins++;
      home.homeWins++;
      away.losses++;
      away.awayLosses++;
    } else if (margin < 0) {
      home.losses++;
      home.homeLosses++;
      away.wins++;
      away.awayWins++;
    } else {
      home.ties++;
      home.homeTies++;
      away.ties++;
      away.awayTies++;
    }

    home.totalFor += g.home_points;
    home.totalAgainst += g.away_points;
    away.totalFor += g.away_points;
    away.totalAgainst += g.home_points;

    const ewma = (prev: number | null, x: number) =>
      prev == null ? x : prev * (1 - scoringAlpha) + scoringAlpha * x;
    home.pointsFor = ewma(home.pointsFor, g.home_points);
    home.pointsAgainst = ewma(home.pointsAgainst, g.away_points);
    away.pointsFor = ewma(away.pointsFor, g.away_points);
    away.pointsAgainst = ewma(away.pointsAgainst, g.home_points);

    if (totalAlpha > 0) {
      leagueTotal = leagueTotal * (1 - totalAlpha) + totalAlpha * (g.home_points + g.away_points);
    }
  }

  return { teams, qbs, currentQb, homeAdvantage: homeEdge, leagueTotal };
}

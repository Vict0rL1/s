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
  eloExpectation,
  movMultiplier,
  BYE_WEEK_ELO,
  DIVISION_HOME_SCALE,
  ELO_PER_POINT,
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

export interface ReplayOptions {
  k?: number;
  carryover?: number;
  eloPerPoint?: number;
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

  const teams = new Map<string, NafTeamState>();
  const team = (id: string) => {
    let s = teams.get(id);
    if (!s) teams.set(id, (s = freshTeam()));
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
      season = g.season;
    }

    const home = team(g.home_id);
    const away = team(g.away_id);

    const edge = homeEdgeFor(g, homeEdge, restWeight, byeElo, divScale);
    const eloDiff = home.elo - away.elo + edge;
    const expectedMargin = eloDiff / perPoint;

    // The total is a matchup of two offences against two defences, each an EWMA
    // of points per game, with the league average standing in for a team that
    // has not played yet.
    const half = leagueTotal / 2;
    const expectedTotal =
      ((home.pointsFor ?? half) + (away.pointsAgainst ?? half)) / 2 +
      ((away.pointsFor ?? half) + (home.pointsAgainst ?? half)) / 2;

    opts.onGame?.({
      game: g,
      home,
      away,
      expectedMargin,
      expectedTotal,
      eloDiff,
      homeAdvantage: edge,
      leagueTotal,
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
    const preDiff = home.elo - away.elo;
    home.elo += shift;
    away.elo -= shift;
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

  return { teams, homeAdvantage: homeEdge, leagueTotal };
}

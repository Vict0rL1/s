// Typed client for the basketball half of the API (/api/basketball/*).
//
// Kept in its own module, mirroring the server split: nothing here shares a type
// with the tennis client, so a game can never be rendered by a match component or
// vice versa.

export interface BbLeague {
  id: string;
  name: string;
  label: string;
  country: string;
  games: number;
  teams: number;
  hasUpcoming: boolean;
  upcomingCount: number;
  /** False when the league has no results feed: market prices only, no Elo. */
  hasModel: boolean;
}

export interface BbTeamRecord {
  wins: number;
  losses: number;
}

export interface BbTeamSide {
  id: string;
  name: string;
  abbreviation: string | null;
  logo: string | null;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  ppg: number | null;
  papg: number | null;
  record: BbTeamRecord;
  venueRecord: BbTeamRecord;
  daysRest: number | null;
  backToBack: boolean;
  restAdjustment: number;
  last10: { won: boolean; pts: number; oppPts: number; home: boolean }[];
}

export interface BbReasoningFactor {
  key: 'rating' | 'home' | 'rest';
  label: string;
  pointsForHome: number;
}

export interface BbReliability {
  level: 'high' | 'medium' | 'low';
  label: string;
  marginPp: number;
  range: { low: number; high: number };
  reasons: string[];
  gamesBehind: { home: number; away: number };
}

export interface BbMarketProbabilities {
  odds1: number;
  odds2: number;
  implied1: number;
  implied2: number;
  overround: number;
}

export interface BbMarketComparison {
  market: BbMarketProbabilities | null;
  edge1: number | null;
  verdict: 'value_p1' | 'value_p2' | 'agree' | 'no_market';
}

export interface BbHeadToHead {
  total: number;
  homeWins: number;
  awayWins: number;
  averageMargin: number | null;
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

export interface BbMarginBand {
  from: number; to: number; label: string; probability: number;
}

export interface BbDistribution {
  marginSigma: number;
  totalSigma: number;
  spreadLine: number;
  homeCovers: number;
  totalLine: number | null;
  over: number | null;
  under: number | null;
  bands: BbMarginBand[];
}

export interface BbProjection {
  margin: number;
  spreadLabel: string;
  home: number | null;
  away: number | null;
  total: number | null;
  /** The spread and the total as probabilities, not just point estimates. */
  distribution: BbDistribution;
}

export interface BbPrediction {
  league: string;
  neutral: boolean;
  teams: { home: BbTeamSide; away: BbTeamSide };
  model: { probHome: number; probAway: number };
  projection: BbProjection;
  market: BbMarketComparison;
  h2h: BbHeadToHead;
  reasoning: {
    factors: BbReasoningFactor[];
    topFactor: BbReasoningFactor | null;
    text: string;
  };
  reliability: BbReliability;
  summary: { headline: string; bullets: string[] };
  verdict: {
    favored: 'home' | 'away' | null;
    favoredName: string | null;
    confidence: 'toss_up' | 'slight' | 'clear' | 'strong';
    marginPct: number;
  };
  disclaimer: string;
}

export interface BbUpcomingGame {
  id: string;
  league: string;
  commence_time: string;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  home_odds: number | null;
  away_odds: number | null;
  books: number;
  source: 'live' | 'fixture';
}

export interface BbTeamInfo {
  id: string;
  league: string;
  name: string;
  abbreviation: string | null;
  conference: string | null;
  division: string | null;
  logo: string | null;
  elo: number;
  eloRank: number;
  gamesInDb: number;
  record: BbTeamRecord;
  homeRecord: BbTeamRecord;
  awayRecord: BbTeamRecord;
  ppg: number | null;
  papg: number | null;
  form: {
    date: string;
    opponentId: string;
    opponentName: string | null;
    home: boolean;
    won: boolean;
    pts: number;
    oppPts: number;
  }[];
}

export interface BbGameWithPrediction {
  game: BbUpcomingGame;
  prediction: BbPrediction | null;
  marketOnly: BbMarketProbabilities | null;
  teams: { home: BbTeamInfo | null; away: BbTeamInfo | null };
}

export interface BbMeta {
  dataSource: string;
  updatedAt: string | null;
  oddsSource: string | null;
  oddsRefreshedAt: string | null;
  hasOddsKey: boolean;
  autoRefreshMinutes: number;
  counts: { teams: number; games: number };
  leagues: {
    id: string;
    name: string;
    label: string;
    games: number;
    teams: number;
    historyThrough: string | null;
    hasModel: boolean;
    hasResultsSource: boolean;
  }[];
}

export interface BbPowerTeam {
  id: string;
  name: string;
  abbreviation: string | null;
  elo: number;
  games: number;
  ppg: number | null;
  papg: number | null;
}

export interface BbTrackRecord {
  resolved: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  /** Mean absolute error of the predicted margin, in points. */
  marginMae: number | null;
  marginBias: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  byReliability: { level: string; n: number; accuracy: number | null; brier: number | null }[];
  vsMarket: {
    n: number;
    modelAccuracy: number | null;
    marketAccuracy: number | null;
    modelBrier: number | null;
    marketBrier: number | null;
    disagreements: number;
    modelRightOnDisagreement: number | null;
  } | null;
  recent: {
    league: string;
    date: string | null;
    home: string | null;
    away: string | null;
    probHome: number;
    predictedMargin: number | null;
    homePts: number | null;
    awayPts: number | null;
    hit: boolean;
    reliability: string | null;
  }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/basketball${path}`);
  if (!res.ok) throw new Error(`API basketball${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(`/api/basketball${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API basketball${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const bbApi = {
  meta: () => get<BbMeta>('/meta'),
  leagues: () => get<BbLeague[]>('/leagues'),
  upcoming: (league?: string) =>
    get<BbGameWithPrediction[]>(
      `/games/upcoming${league ? `?league=${encodeURIComponent(league)}` : ''}`,
    ),
  team: (league: string, id: string) =>
    get<BbTeamInfo>(`/teams/${encodeURIComponent(league)}/${encodeURIComponent(id)}`),
  power: (league: string, limit = 40) =>
    get<{ league: string; teams: BbPowerTeam[] }>(
      `/power?league=${encodeURIComponent(league)}&limit=${limit}`,
    ),
  trackRecord: (league?: string) =>
    get<BbTrackRecord>(`/track-record${league ? `?league=${encodeURIComponent(league)}` : ''}`),
  refresh: () => post<{ ok: boolean; source: string; count: number }>('/refresh'),
};

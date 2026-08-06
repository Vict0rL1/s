// Typed client for the baseball half of the API (/api/baseball/*).

import type { MatchOutcome } from './outcome';

export interface BsbLeague {
  id: string; name: string; label: string; country: string;
  games: number; teams: number; hasUpcoming: boolean; upcomingCount: number;
  /** False when the league has no results archive: market prices only, no model. */
  hasModel: boolean;
}

export interface BsbRecord { wins: number; losses: number }

export interface BsbStarter {
  id: string | null;
  name: string | null;
  starts: number;
  runsPerStart: number | null;
  /** Below 1 = suppresses runs relative to an average starter. */
  rating: number | null;
  runFactor: number;
  label: string;
}

export interface BsbSide {
  id: string; name: string; elo: number; eloRank: number; gamesInDb: number;
  rs: number | null; ra: number | null; pythagorean: number | null;
  record: BsbRecord; venueRecord: BsbRecord;
  last10: ('W' | 'L')[];
  expectedRuns: number;
  starter: BsbStarter;
}

export interface BsbReliability {
  level: 'high' | 'medium' | 'low';
  label: string; marginPp: number; reasons: string[];
  gamesBehind: { home: number; away: number };
}

export interface BsbMoneyline { home: number; away: number }

export interface BsbMarket {
  market: (BsbMoneyline & { overround: number; odds: BsbMoneyline }) | null;
  edge: BsbMoneyline | null;
  verdict: 'value_home' | 'value_away' | 'agree' | 'no_market';
}

export interface BsbRunMargin { margin: number; probability: number }

export interface BsbPrediction {
  league: string;
  teams: { home: BsbSide; away: BsbSide };
  model: BsbMoneyline;
  runs: {
    expectedHome: number; expectedAway: number; expectedTotal: number;
    totalLine: number; over: number; under: number;
    runLine: { homeCovers: number; awayCovers: number };
    extraInnings: number;
    scorelines: { home: number; away: number; probability: number; label: string }[];
    /** cells[homeRuns][awayRuns]; cells + tail sum to 1. */
    grid: { cells: number[][]; maxRuns: number; tail: number };
    margins: BsbRunMargin[];
  };
  /** The ballpark, when the archive knows it. Null = unknown, NOT "neutral". */
  park: {
    site: string; name: string; factor: number; games: number; runsVsNeutral: number;
  } | null;
  market: BsbMarket;
  h2h: {
    total: number; homeWins: number; awayWins: number;
    recent: { date: string; homeId: string; awayId: string; homeRuns: number; awayRuns: number }[];
  };
  reasoning: { factors: { key: string; label: string; pointsForHome: number }[]; text: string };
  reliability: BsbReliability;
  summary: { headline: string; bullets: string[] };
  verdict: { outcome: 'home' | 'away'; label: string; probability: number; close: boolean };
  disclaimer: string;
}

export interface BsbGame {
  id: string; league: string; commence_time: string;
  home_name: string; away_name: string;
  home_id: string | null; away_id: string | null;
  home_sp: string | null; away_sp: string | null;
  odds_home: number | null; odds_away: number | null;
  books: number; source: 'live' | 'fixture';
}

export interface BsbPitcher {
  id: string; league: string; name: string; team_id: string | null;
  starts: number; outs: number; runs_allowed: number;
  runs_per_9: number | null; rating: number | null;
  last_date: string | null; season: number | null;
}

export interface BsbTeamInfo {
  id: string; league: string; name: string; elo: number; eloRank: number; gamesInDb: number;
  record: BsbRecord; homeRecord: BsbRecord; awayRecord: BsbRecord;
  rs: number | null; ra: number | null; pythagorean: number | null;
  form: {
    date: string; opponentId: string; opponentName: string | null; home: boolean;
    result: 'W' | 'L'; runsFor: number; runsAgainst: number;
  }[];
  rotation: { id: string; name: string; starts: number; runsPer9: number | null; rating: number | null }[];
}

export interface BsbGameWithPrediction {
  outcome: MatchOutcome;
  game: BsbGame;
  prediction: BsbPrediction | null;
  marketOnly: (BsbMoneyline & { overround: number; odds: BsbMoneyline }) | null;
  teams: { home: BsbTeamInfo | null; away: BsbTeamInfo | null };
  /** True when a probables feed named both starters, false when they were guessed. */
  startersAnnounced: boolean;
}

export interface BsbMeta {
  dataSource: string; updatedAt: string | null;
  oddsSource: string | null; oddsRefreshedAt: string | null;
  probables: number;
  hasOddsKey: boolean; autoRefreshMinutes: number;
  counts: { teams: number; games: number };
  leagues: {
    id: string; name: string; label: string; games: number; teams: number;
    historyThrough: string | null; hasModel: boolean; hasResultsSource: boolean;
  }[];
}

export interface BsbPowerTeam {
  id: string; name: string | null; elo: number; games: number;
  rs: number | null; ra: number | null;
}

export interface BsbTrackRecord {
  resolved: number; pending: number;
  accuracy: number | null; brier: number | null; logLoss: number | null;
  totalMae: number | null; totalBias: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  byReliability: { level: string; n: number; accuracy: number | null; brier: number | null }[];
  byStarterKnown: { known: boolean; n: number; accuracy: number | null; brier: number | null }[];
  vsMarket: {
    n: number; modelAccuracy: number | null; marketAccuracy: number | null;
    modelBrier: number | null; marketBrier: number | null;
  } | null;
  recent: {
    league: string; date: string | null; home: string | null; away: string | null;
    probHome: number; homeRuns: number | null; awayRuns: number | null;
    hit: boolean; reliability: string | null;
  }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/baseball${path}`);
  if (!res.ok) throw new Error(`API baseball${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
async function post<T>(path: string): Promise<T> {
  const res = await fetch(`/api/baseball${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API baseball${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const bsbApi = {
  meta: () => get<BsbMeta>('/meta'),
  leagues: () => get<BsbLeague[]>('/leagues'),
  upcoming: (league?: string) =>
    get<BsbGameWithPrediction[]>(
      `/games/upcoming${league ? `?league=${encodeURIComponent(league)}` : ''}`,
    ),
  /** Re-predict a game with the starting pitchers the user picked. */
  game: (id: string, starters: { home?: string | null; away?: string | null } = {}) => {
    const q = new URLSearchParams();
    if (starters.home !== undefined) q.set('homeStarter', starters.home ?? '');
    if (starters.away !== undefined) q.set('awayStarter', starters.away ?? '');
    const qs = q.toString();
    return get<BsbGameWithPrediction>(`/games/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`);
  },
  rotation: (league: string, teamId: string) =>
    get<{ league: string; teamId: string; pitchers: BsbPitcher[] }>(
      `/rotation/${encodeURIComponent(league)}/${encodeURIComponent(teamId)}`,
    ),
  team: (league: string, id: string) =>
    get<BsbTeamInfo>(`/teams/${encodeURIComponent(league)}/${encodeURIComponent(id)}`),
  power: (league: string, limit = 40) =>
    get<{ league: string; teams: BsbPowerTeam[] }>(
      `/power?league=${encodeURIComponent(league)}&limit=${limit}`,
    ),
  trackRecord: (league?: string) =>
    get<BsbTrackRecord>(`/track-record${league ? `?league=${encodeURIComponent(league)}` : ''}`),
  refresh: () => post<{ ok: boolean; source: string; count: number; withStarters: number }>('/refresh'),
};

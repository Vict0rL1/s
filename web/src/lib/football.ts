// Typed client for the football half of the API (/api/football/*).

export interface FbLeague {
  id: string; name: string; label: string; country: string; tier: number;
  matches: number; teams: number; hasUpcoming: boolean; upcomingCount: number;
  /** False when the league has no results feed: market prices only, no Elo. */
  hasModel: boolean;
}

export interface FbRecord { wins: number; draws: number; losses: number }

export interface FbSide {
  id: string; name: string; elo: number; eloRank: number; matchesInDb: number;
  gf: number | null; ga: number | null;
  record: FbRecord; venueRecord: FbRecord;
  last5: ('W' | 'D' | 'L')[];
  expectedGoals: number;
}

export interface FbReliability {
  level: 'high' | 'medium' | 'low';
  label: string; marginPp: number; reasons: string[];
  matchesBehind: { home: number; away: number };
}

export interface Fb1X2 { home: number; draw: number; away: number }

export interface FbMarket {
  market: (Fb1X2 & { overround: number; odds: Fb1X2 }) | null;
  edge: Fb1X2 | null;
  verdict: 'value_home' | 'value_draw' | 'value_away' | 'agree' | 'no_market';
}

export interface FbPrediction {
  league: string;
  neutral: boolean;
  teams: { home: FbSide; away: FbSide };
  model: Fb1X2;
  goals: {
    expectedHome: number; expectedAway: number; expectedTotal: number;
    over25: number; under25: number; bothScore: number;
    scorelines: { home: number; away: number; probability: number; label: string }[];
  };
  market: FbMarket;
  h2h: {
    total: number; homeWins: number; draws: number; awayWins: number;
    recentSeasons: { seasons: number; homeWins: number; draws: number; awayWins: number } | null;
    recent: { date: string; homeId: string; awayId: string; homeGoals: number; awayGoals: number }[];
  };
  reasoning: { factors: { key: string; label: string; pointsForHome: number }[]; text: string };
  reliability: FbReliability;
  summary: { headline: string; bullets: string[] };
  verdict: { outcome: 'home' | 'draw' | 'away'; label: string; probability: number; open: boolean };
  disclaimer: string;
}

export interface FbFixture {
  id: string; league: string; commence_time: string;
  home_name: string; away_name: string;
  home_id: string | null; away_id: string | null;
  odds_home: number | null; odds_draw: number | null; odds_away: number | null;
  books: number; source: 'live' | 'fixture';
}

export interface FbTeamInfo {
  id: string; league: string; name: string; elo: number; eloRank: number; matchesInDb: number;
  record: FbRecord; homeRecord: FbRecord; awayRecord: FbRecord;
  gf: number | null; ga: number | null; points: number;
  form: {
    date: string; opponentId: string; opponentName: string | null; home: boolean;
    result: 'W' | 'D' | 'L'; goalsFor: number; goalsAgainst: number;
  }[];
}

export interface FbFixtureWithPrediction {
  fixture: FbFixture;
  prediction: FbPrediction | null;
  marketOnly: (Fb1X2 & { overround: number; odds: Fb1X2 }) | null;
  teams: { home: FbTeamInfo | null; away: FbTeamInfo | null };
}

export interface FbMeta {
  dataSource: string; updatedAt: string | null;
  oddsSource: string | null; oddsRefreshedAt: string | null;
  hasOddsKey: boolean; autoRefreshMinutes: number;
  counts: { teams: number; matches: number };
  leagues: {
    id: string; name: string; label: string; matches: number; teams: number;
    historyThrough: string | null; hasModel: boolean; hasResultsSource: boolean;
  }[];
}

export interface FbPowerTeam {
  id: string; name: string; elo: number; matches: number; gf: number | null; ga: number | null;
}

export interface FbTrackRecord {
  resolved: number; pending: number;
  accuracy: number | null; rps: number | null; logLoss: number | null;
  draws: { predicted: number; actual: number; meanProbability: number | null } | null;
  byReliability: { level: string; n: number; accuracy: number | null; rps: number | null }[];
  vsMarket: {
    n: number; modelRps: number | null; marketRps: number | null;
    modelAccuracy: number | null; marketAccuracy: number | null;
  } | null;
  recent: {
    league: string; date: string | null; home: string | null; away: string | null;
    probs: Fb1X2; homeGoals: number | null; awayGoals: number | null;
    hit: boolean; reliability: string | null;
  }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/football${path}`);
  if (!res.ok) throw new Error(`API football${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
async function post<T>(path: string): Promise<T> {
  const res = await fetch(`/api/football${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API football${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const fbApi = {
  meta: () => get<FbMeta>('/meta'),
  leagues: () => get<FbLeague[]>('/leagues'),
  upcoming: (league?: string) =>
    get<FbFixtureWithPrediction[]>(
      `/fixtures/upcoming${league ? `?league=${encodeURIComponent(league)}` : ''}`,
    ),
  team: (league: string, id: string) =>
    get<FbTeamInfo>(`/teams/${encodeURIComponent(league)}/${encodeURIComponent(id)}`),
  power: (league: string, limit = 40) =>
    get<{ league: string; teams: FbPowerTeam[] }>(
      `/power?league=${encodeURIComponent(league)}&limit=${limit}`,
    ),
  trackRecord: (league?: string) =>
    get<FbTrackRecord>(`/track-record${league ? `?league=${encodeURIComponent(league)}` : ''}`),
  refresh: () => post<{ ok: boolean; source: string; count: number }>('/refresh'),
};

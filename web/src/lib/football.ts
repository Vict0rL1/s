// Typed client for the football half of the API (/api/football/*).

import type { MatchOutcome } from './outcome';

export interface FbLeague {
  id: string; name: string; label: string; country: string; tier: number;
  matches: number; teams: number; hasUpcoming: boolean; upcomingCount: number;
  /** False when the league has no results feed: market prices only, no Elo. */
  hasModel: boolean;
}

export interface FbRecord { wins: number; draws: number; losses: number }

export interface FbSide {
  id: string; name: string; elo: number; eloRank: number; matchesInDb: number;
  /** Set when the club just came up and its Elo was carried over from that league. */
  seededFrom?: string | null;
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

export interface FbSquadPlayer {
  id: string; team_id: string; name: string;
  position: 'GK' | 'DEF' | 'MID' | 'FWD';
  minutes: number; starts: number; xgi90: number | null;
  goals: number; assists: number;
  status: string | null; chance_next: number | null; news: string | null;
  regular: boolean; attackShare: number; minutesShare: number;
  flaggedOut: boolean; flagReason: string | null;
}

export interface FbAvailability {
  attack: number; defence: number;
  missingAttack: number; missingMinutes: number;
  out: { id: string; name: string; position: string; attackShare: number; reason: string | null }[];
}

export interface FbSquad {
  league: string; teamId: string;
  season: string | null; updatedAt: string | null;
  players: FbSquadPlayer[];
  availability: FbAvailability;
}

export interface FbGoalMargin { margin: number; probability: number }

export interface FbPropDistribution {
  pmf: number[];
  atLeastOne: number;
  atLeastTwo: number;
  expected: number;
}

export interface FbPlayerProp {
  playerId: string;
  name: string;
  position: string;
  teamId: string;
  minutes: {
    points: { minutes: number; probability: number }[];
    expected: number;
    pDidNotPlay: number;
  };
  minutesPlayed: number;
  priorWeight: number;
  starterShare: number;
  teamMatches: number;
  goals: FbPropDistribution;
  assists: FbPropDistribution;
  cards: FbPropDistribution;
  goalOrAssist: number;
}

export interface FbCountForecast {
  market: 'corners' | 'cards';
  home: number;
  away: number;
  total: number;
  lines: { line: number; over: number }[];
  distribution: 'poisson' | 'negbin';
  dispersion: number;
}

export interface FbMarketLiquidity {
  key: string;
  label: string;
  depth: 'profundo' | 'medio' | 'fino' | 'muy-fino';
  /** null = no consultado. NO es lo mismo que cero casas. */
  books: number | null;
  minEdge: number;
  note: string;
}

export interface FbThinMarkets {
  halves:
    | {
        htHome: number;
        htDraw: number;
        htAway: number;
        htOver05: number;
        htOver15: number;
        homeWinsAHalf: number;
        awayWinsAHalf: number;
        homeScoresBoth: number;
        awayScoresBoth: number;
        htFt: number[][];
        expected: { first: number; second: number };
        /** Error de calibración medido de cada mercado, en pp. */
        calibration: Record<string, number>;
        calibrationMatches: number;
      }
    | null;
  corners: FbCountForecast | null;
  cards: FbCountForecast | null;
  players: FbPlayerProp[];
  liquidity: FbMarketLiquidity[];
}

/** Qué le hizo la capa de post-proceso a la probabilidad. */
export interface FbPostprocess {
  calibrator: 'platt' | 'isotonic' | 'ninguno';
  /** Peso efectivo del modelo tras encoger hacia el mercado. null = no se mezcló. */
  weight: number | null;
  /** Discrepancia con el mercado, en nats. */
  disagreement: number | null;
  note?: string;
}

export interface FbPrediction {
  league: string;
  neutral: boolean;
  teams: { home: FbSide; away: FbSide };
  /**
   * La probabilidad CRUDA del modelo, coherente con la rejilla de marcadores.
   * Lo que se publica es `final`; las dos se enseñan.
   */
  model: Fb1X2;
  /** La publicada: calibrada, y mezclada con el mercado donde hay peso ajustado. */
  final: Fb1X2;
  postprocess: FbPostprocess;
  /** Mercados de menos liquidez. `null` en ligas sin ningún ajuste para ellos. */
  thin: FbThinMarkets | null;
  goals: {
    expectedHome: number; expectedAway: number; expectedTotal: number;
    over25: number; under25: number; bothScore: number;
    scorelines: { home: number; away: number; probability: number; label: string }[];
    /** cells[homeGoals][awayGoals]; cells + tail sum to 1. */
    grid: { cells: number[][]; maxGoals: number; tail: number };
    margins: FbGoalMargin[];
  };
  /** null for leagues with no player data at all — not the same as "no absences". */
  squads: { home: FbAvailability | null; away: FbAvailability | null };
  market: FbMarket;
  h2h: {
    total: number; homeWins: number; draws: number; awayWins: number;
    recentSeasons: { seasons: number; homeWins: number; draws: number; awayWins: number } | null;
    recent: { date: string; homeId: string; awayId: string; homeGoals: number; awayGoals: number }[];
  };
  reasoning: { factors: { key: string; label: string; pointsForHome: number }[]; text: string };
  reliability: FbReliability;
  summary: { headline: string; bullets: string[] };
  verdict: {
    outcome: 'home' | 'draw' | 'away';
    label: string;
    probability: number;
    open: boolean;
    /** La mejor doble oportunidad. Es lo único afirmable en un partido abierto. */
    doubleChance: { outcome: '1X' | 'X2'; label: string; probability: number };
  };
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
  outcome: MatchOutcome;
  fixture: FbFixture;
  prediction: FbPrediction | null;
  marketOnly: (Fb1X2 & { overround: number; odds: Fb1X2 }) | null;
  teams: { home: FbTeamInfo | null; away: FbTeamInfo | null };
}

export interface FbMeta {
  dataSource: string; updatedAt: string | null;
  oddsSource: string | null; oddsRefreshedAt: string | null;
  hasOddsKey: boolean; autoRefreshMinutes: number;
  squads: { season: string | null; updatedAt: string | null; leagues: string[] };
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
  squad: (league: string, id: string) =>
    get<FbSquad>(`/squad/${encodeURIComponent(league)}/${encodeURIComponent(id)}`),
  /** Re-predict a fixture with a set of players marked unavailable. */
  fixture: (id: string, out: { home?: string[]; away?: string[] } = {}) => {
    const q = new URLSearchParams();
    if (out.home?.length) q.set('outHome', out.home.join(','));
    if (out.away?.length) q.set('outAway', out.away.join(','));
    const qs = q.toString();
    return get<FbFixtureWithPrediction>(
      `/fixtures/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`,
    );
  },
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

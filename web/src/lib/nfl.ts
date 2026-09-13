// Typed client for the American football half of the API (/api/nfl/*).

import type { MatchOutcome } from './outcome';

/**
 * Where the market number came from. `spread` is the normal case in this app:
 * nflverse ships the closing handicap with the schedule, so it exists without an
 * ODDS_API_KEY, while a moneyline does not. A handicap is a line rather than a
 * price, so it carries no vig to remove — hence the nulls.
 */
export interface NafMarket {
  source: 'moneyline' | 'spread';
  odds: { home: number; away: number } | null;
  line: number | null;
  home: number;
  away: number;
  overround: number | null;
}

export interface NflLeague {
  id: string; name: string; label: string; country: string;
  games: number; teams: number; hasUpcoming: boolean; upcomingCount: number;
  /** False when the league has no results archive: market prices only, no model. */
  hasModel: boolean;
}

export interface NflRecord { wins: number; losses: number; ties: number }

export interface NflQb {
  name: string | null;
  /** Elo points relative to a league-average starter. */
  adjustment: number;
  /** What that offset is worth in points of expected margin. */
  points: number;
  starts: number;
  /** Always true today: the schedule never names a starter in advance. */
  assumed: boolean;
}

export interface NflSide {
  id: string; name: string; elo: number; eloRank: number; gamesInDb: number;
  pf: number | null; pa: number | null; pythagorean: number | null;
  record: NflRecord; venueRecord: NflRecord;
  last5: ('W' | 'D' | 'L')[];
  expectedPoints: number;
}

export interface NflReliability {
  level: 'high' | 'medium' | 'low';
  label: string; marginPp: number; reasons: string[];
  gamesBehind: { home: number; away: number };
}

export interface NflMarket {
  market: NafMarket | null;
  edge: { home: number; away: number } | null;
  verdict: 'differs_home' | 'differs_away' | 'agree' | 'no_market';
}

/** A handicap price. `push` is the stake coming back — common on whole numbers. */
export interface NflSpreadQuote {
  line: number; cover: number; push: number; fail: number; label: string;
}

export interface NflMarginBand {
  from: number | null; to: number | null; probability: number; label: string;
}

export interface NflScoreline {
  home: number; away: number; label: string; probability: number;
}

export interface NflPrediction {
  league: string;
  teams: { home: NflSide; away: NflSide };
  /**
   * The starting quarterback the forecast assumed. Worth showing rather than
   * hiding: it is the one input a reader can check against the news, so if the
   * app says Stidham and the reader knows Maye is back, they know exactly how the
   * forecast is stale instead of vaguely distrusting it.
   */
  quarterbacks: { home: NflQb | null; away: NflQb | null };
  conditions: { roof: string | null; totalAdjustment: number } | null;
  /** Probabilidades crudas del modelo, coherentes con la distribución de margen. */
  model: { home: number; away: number; tie: number };
  /** La publicada, a dos bandas: calibrada y mezclada con el mercado. */
  final: { home: number; away: number };
  postprocess: {
    calibrator: 'platt' | 'isotonic' | 'ninguno';
    weight: number | null;
    disagreement: number | null;
    note?: string;
  };
  spread: {
    expectedMargin: number;
    label: string;
    line: number;
    home: NflSpreadQuote;
    away: NflSpreadQuote;
    fromMarket: boolean;
    keyLines: NflSpreadQuote[];
  };
  total: {
    expected: number; line: number; over: number; push: number; under: number; fromMarket: boolean;
  };
  points: { home: number; away: number };
  bands: NflMarginBand[];
  scorelines: NflScoreline[];
  keyNumbers: { margin: number; probability: number }[];
  h2h: {
    total: number; homeWins: number; awayWins: number; ties: number;
    recent: {
      date: string; season: number; week: number;
      homeId: string; awayId: string; homePoints: number; awayPoints: number;
    }[];
  };
  market: NflMarket;
  reasoning: { text: string; factors: { key: string; label: string; pointsForHome: number }[] };
  reliability: NflReliability;
  verdict: { label: string; close: boolean; marginPp: number };
  summary: { headline: string; bullets: string[] };
  context: { homeAdvantageElo: number; homeAdvantagePoints: number; leagueTotal: number };
  disclaimer: string;
}

export interface NflGameRow {
  id: string; league: string;
  season: number | null; week: number | null;
  commence_time: string;
  home_name: string; away_name: string;
  home_id: string | null; away_id: string | null;
  neutral: number;
  odds_home: number | null; odds_away: number | null;
  spread_line: number | null; total_line: number | null;
  books: number;
  source: 'live' | 'schedule' | 'fixture';
  updated_at: string;
}

export interface NflTeamInfo {
  id: string; league: string; name: string;
  elo: number; eloRank: number; gamesInDb: number;
  record: NflRecord; homeRecord: NflRecord; awayRecord: NflRecord;
  pf: number | null; pa: number | null; pythagorean: number | null;
  form: {
    date: string; season: number; week: number;
    opponentId: string; opponentName: string | null;
    home: boolean; result: 'W' | 'D' | 'L';
    pointsFor: number; pointsAgainst: number;
  }[];
}

export interface NflGameWithPrediction {
  game: NflGameRow;
  outcome: MatchOutcome;
  prediction: NflPrediction | null;
  marketOnly: NafMarket | null;
  teams: { home: NflTeamInfo | null; away: NflTeamInfo | null };
  linesFromMarket: boolean;
}

export interface NflMeta {
  updatedAt: string | null;
  oddsRefreshedAt: string | null;
  hasOddsKey: boolean;
  autoRefreshMinutes: number;
  counts: { teams: number; games: number };
  /** League-wide quantities the model tracks rather than assumes. */
  league: { homeAdvantageElo: number; homeAdvantagePoints: number; pointsPerGame: number };
  leagues: {
    id: string; name: string; label: string; country: string;
    games: number; teams: number; historyThrough: string | null;
    hasModel: boolean; hasResultsSource: boolean;
  }[];
}

export interface NflTrackRecord {
  resolved: number; pending: number;
  accuracy: number | null; brier: number | null; logLoss: number | null;
  marginMae: number | null; marginBias: number | null; totalMae: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  byReliability: { level: string; n: number; accuracy: number | null; brier: number | null }[];
  vsMarket: {
    n: number;
    modelAccuracy: number | null; marketAccuracy: number | null;
    modelBrier: number | null; marketBrier: number | null;
  } | null;
  recent: {
    league: string; date: string | null; home: string | null; away: string | null;
    probHome: number; homePoints: number | null; awayPoints: number | null;
    hit: boolean; reliability: string | null;
  }[];
}

const BASE = '/api/nfl';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const nflApi = {
  meta: () => get<NflMeta>('/meta'),
  leagues: () => get<NflLeague[]>('/leagues'),
  upcoming: (league: string) =>
    get<NflGameWithPrediction[]>(`/games/upcoming?league=${encodeURIComponent(league)}`),
  team: (league: string, id: string) =>
    get<NflTeamInfo>(`/teams/${encodeURIComponent(league)}/${encodeURIComponent(id)}`),
  power: (league: string) =>
    get<{ league: string; teams: { id: string; name: string; elo: number; games: number; pf: number | null; pa: number | null }[] }>(
      `/power?league=${encodeURIComponent(league)}`,
    ),
  trackRecord: (league: string) =>
    get<NflTrackRecord>(`/track-record?league=${encodeURIComponent(league)}`),
  refresh: async () => {
    const res = await fetch(`${BASE}/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; stored: number }>;
  },
};

import type {
  DcfResponse,
  EarningsEvent,
  EtfComparison,
  EtfData,
  FilterSpec,
  Interpretation,
  NewsFeed,
  BacktestResponse,
  DeepDiveNarrative,
  DeepDiveReport,
  Portfolio,
  PriceAlert,
  QuantSignal,
  ScanResponse,
  ScreenerPreset,
  UniverseInfo,
  SignalExplanation,
  SignalResponse,
  ScreenResult,
  ThesisRecord,
  TodayResponse,
  TrackRecord,
  WatchlistItem,
  FilingsResponse,
  Financials,
  Fundamentals,
  Health,
  History,
  HistoryRange,
  IndexEntry,
  MacroIndicator,
  PeersResponse,
  Profile,
  LlmStatus,
  ProviderUsage,
  Quote,
  RiskResponse,
  ScenarioAssumptions,
  SectorEntry,
  ValuationDefaults,
  YieldCurve,
} from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(path)
  if (!resp.ok) {
    let detail = `Error HTTP ${resp.status}`
    try {
      const body = await resp.json()
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      // cuerpo no-JSON: nos quedamos con el mensaje genérico
    }
    throw new ApiError(resp.status, detail)
  }
  return resp.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    let detail = `Error HTTP ${resp.status}`
    try {
      const data = await resp.json()
      if (typeof data.detail === 'string') detail = data.detail
    } catch {
      // sin cuerpo JSON
    }
    throw new ApiError(resp.status, detail)
  }
  return resp.json() as Promise<T>
}

async function deleteJson<T>(path: string): Promise<T> {
  const resp = await fetch(path, { method: 'DELETE' })
  if (!resp.ok) {
    let detail = `Error HTTP ${resp.status}`
    try {
      const data = await resp.json()
      if (typeof data.detail === 'string') detail = data.detail
    } catch {
      // sin cuerpo JSON
    }
    throw new ApiError(resp.status, detail)
  }
  return resp.json() as Promise<T>
}

export const api = {
  quote: (symbol: string) => fetchJson<Quote>(`/api/stocks/${symbol}/quote`),
  profile: (symbol: string) => fetchJson<Profile>(`/api/stocks/${symbol}/profile`),
  fundamentals: (symbol: string) =>
    fetchJson<Fundamentals>(`/api/stocks/${symbol}/fundamentals`),
  history: (symbol: string, range: HistoryRange) =>
    fetchJson<History>(`/api/stocks/${symbol}/history?range=${range}`),
  usage: () => fetchJson<ProviderUsage[]>('/api/meta/usage'),
  llmStatus: () => fetchJson<LlmStatus>('/api/meta/llm'),
  // Fase 2
  financials: (symbol: string) => fetchJson<Financials>(`/api/stocks/${symbol}/financials`),
  health: (symbol: string) => fetchJson<Health>(`/api/stocks/${symbol}/health`),
  valuationDefaults: (symbol: string) =>
    fetchJson<ValuationDefaults>(`/api/stocks/${symbol}/valuation/defaults`),
  dcf: (
    symbol: string,
    body: {
      base_fcf: number
      years: number
      net_debt: number
      shares_outstanding: number | null
      scenarios: Record<string, ScenarioAssumptions>
    },
  ) => postJson<DcfResponse>(`/api/stocks/${symbol}/valuation/dcf`, body),
  peers: (symbol: string) => fetchJson<PeersResponse>(`/api/stocks/${symbol}/peers`),
  risk: (symbol: string) => fetchJson<RiskResponse>(`/api/stocks/${symbol}/risk`),
  filings: (symbol: string) => fetchJson<FilingsResponse>(`/api/stocks/${symbol}/filings`),
  news: (symbol: string | null, days = 7) =>
    fetchJson<NewsFeed>(
      `/api/news?days=${days}${symbol ? `&symbol=${symbol}` : ''}`,
    ),
  interpretNews: (body: { headline: string; summary: string | null; symbol: string | null }) =>
    postJson<Interpretation>('/api/news/interpret', body),
  // Fase 4
  etf: (symbol: string) => fetchJson<EtfData>(`/api/etfs/${symbol}`),
  compareEtfs: (symbols: string[]) =>
    fetchJson<EtfComparison>(
      `/api/etfs/compare/side-by-side?symbols=${encodeURIComponent(symbols.join(','))}`,
    ),
  screenerPresets: () =>
    fetchJson<{ builtin: ScreenerPreset[]; saved: ScreenerPreset[] }>('/api/screener/presets'),
  savePreset: (body: { name: string; logic_md: string | null; filters: Record<string, FilterSpec> }) =>
    postJson<{ id: number; name: string }>('/api/screener/presets', body),
  runScreen: (body: { symbols: string[]; filters: Record<string, FilterSpec> }) =>
    postJson<ScreenResult>('/api/screener/run', body),
  // Fase 5
  watchlist: () => fetchJson<{ name: string; items: WatchlistItem[] }>('/api/watchlist'),
  addToWatchlist: (body: { symbol: string; notes: string | null }) =>
    postJson<{ id: number; symbol: string }>('/api/watchlist', body),
  removeFromWatchlist: (id: number) => deleteJson<{ deleted: number }>(`/api/watchlist/${id}`),
  portfolio: () => fetchJson<Portfolio>('/api/portfolio'),
  addPosition: (body: { symbol: string; quantity: number; cost_basis: number }) =>
    postJson<{ id: number; symbol: string }>('/api/portfolio/positions', body),
  closePosition: (id: number, exitPrice: number) =>
    postJson<{ id: number; realized_pnl: number }>(`/api/portfolio/positions/${id}/close`, {
      exit_price: exitPrice,
    }),
  deletePosition: (id: number) =>
    deleteJson<{ deleted: number }>(`/api/portfolio/positions/${id}`),
  alerts: () => fetchJson<{ alerts: PriceAlert[] }>('/api/portfolio/alerts'),
  addAlert: (body: { symbol: string; op: 'lt' | 'gt'; price: number }) =>
    postJson<{ id: number }>('/api/portfolio/alerts', body),
  deleteAlert: (id: number) => deleteJson<{ deleted: number }>(`/api/portfolio/alerts/${id}`),
  theses: () => fetchJson<{ theses: ThesisRecord[] }>('/api/theses'),
  createThesis: (body: {
    symbol: string
    title: string
    body_md: string
    invalidation_criteria: string | null
  }) => postJson<{ id: number }>('/api/theses', body),
  deleteThesis: (id: number) => deleteJson<{ deleted: number }>(`/api/theses/${id}`),
  addScenario: (
    thesisId: number,
    body: {
      kind: 'bear' | 'base' | 'bull'
      assumptions: Record<string, number>
      value_mid: number | null
    },
  ) =>
    postJson<{ id: number; price_at_creation: number | null; warning: string | null }>(
      `/api/theses/${thesisId}/scenarios`,
      body,
    ),
  trackRecord: () => fetchJson<TrackRecord>('/api/theses/track-record'),
  // Informe de analista
  deepDive: (symbol: string, years = 10) =>
    fetchJson<DeepDiveReport>(`/api/deep-dive/${symbol}?history_years=${years}`),
  deepDiveNarrative: (symbol: string, report: DeepDiveReport) =>
    postJson<DeepDiveNarrative>(`/api/deep-dive/${symbol}/narrative`, report),
  // Motor de señales cuantitativas
  today: (refresh = false) =>
    fetchJson<TodayResponse>(`/api/signals/today${refresh ? '?refresh=true' : ''}`),
  universes: () =>
    fetchJson<{ universes: UniverseInfo[]; note: string }>('/api/signals/universes'),
  scanUniverse: (universe: string, topN: number) =>
    postJson<ScanResponse>('/api/signals/scan', { universe, top_n: topN }),
  scoreSignals: (symbols: string[], useNews: boolean) =>
    postJson<SignalResponse>('/api/signals/score', { symbols, use_news: useNews }),
  runBacktest: (symbols: string[], horizonMonths: number, years: number) =>
    postJson<BacktestResponse>('/api/signals/backtest', {
      symbols,
      horizon_months: horizonMonths,
      years,
    }),
  explainSignal: (symbol: string, signal: QuantSignal) =>
    postJson<SignalExplanation>(`/api/signals/${symbol}/explain`, {
      signal,
      context: signal.context,
    }),
  marketOverview: () => fetchJson<{ indices: IndexEntry[] }>('/api/market/overview'),
  marketSectors: () => fetchJson<{ sectors: SectorEntry[]; note: string }>('/api/market/sectors'),
  yieldCurve: () => fetchJson<YieldCurve>('/api/market/yield-curve'),
  macro: () => fetchJson<{ indicators: MacroIndicator[] }>('/api/market/macro'),
  calendar: () => fetchJson<{ events: EarningsEvent[] }>('/api/market/calendar'),
}

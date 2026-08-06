import type {
  DcfResponse,
  EarningsEvent,
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

export const api = {
  quote: (symbol: string) => fetchJson<Quote>(`/api/stocks/${symbol}/quote`),
  profile: (symbol: string) => fetchJson<Profile>(`/api/stocks/${symbol}/profile`),
  fundamentals: (symbol: string) =>
    fetchJson<Fundamentals>(`/api/stocks/${symbol}/fundamentals`),
  history: (symbol: string, range: HistoryRange) =>
    fetchJson<History>(`/api/stocks/${symbol}/history?range=${range}`),
  usage: () => fetchJson<ProviderUsage[]>('/api/meta/usage'),
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
  marketOverview: () => fetchJson<{ indices: IndexEntry[] }>('/api/market/overview'),
  marketSectors: () => fetchJson<{ sectors: SectorEntry[]; note: string }>('/api/market/sectors'),
  yieldCurve: () => fetchJson<YieldCurve>('/api/market/yield-curve'),
  macro: () => fetchJson<{ indicators: MacroIndicator[] }>('/api/market/macro'),
  calendar: () => fetchJson<{ events: EarningsEvent[] }>('/api/market/calendar'),
}

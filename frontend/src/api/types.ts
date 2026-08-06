// Tipos espejo de backend/app/schemas/market.py.
// Regla de la app: toda cifra llega con fuente, fecha y estado de caché.

export interface Sourced {
  source: string
  as_of: string
  cached: boolean
  fetched_at: string | null
}

export interface Quote extends Sourced {
  symbol: string
  price: number
  change: number | null
  change_pct: number | null
  prev_close: number | null
  day_high: number | null
  day_low: number | null
  day_open: number | null
  currency: string | null
  freshness: 'live' | 'delayed' | 'prev_close'
}

export interface Bar {
  ts: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface MacdSeries {
  macd: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
}

export interface IndicatorBundle {
  sma20: (number | null)[]
  sma50: (number | null)[]
  sma200: (number | null)[]
  rsi14: (number | null)[]
  macd: MacdSeries
}

export type HistoryRange = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '5Y' | '10Y'

export interface History extends Sourced {
  symbol: string
  interval: string
  range: HistoryRange
  currency: string | null
  bars: Bar[]
  indicators: IndicatorBundle
}

export interface Profile extends Sourced {
  symbol: string
  name: string | null
  exchange: string | null
  sector: string | null
  industry: string | null
  market_cap: number | null
  currency: string | null
  country: string | null
  ipo: string | null
  website: string | null
}

export interface Fundamentals extends Sourced {
  symbol: string
  period: string
  metrics: Record<string, number | null>
}

export interface ProviderUsage {
  provider: string
  configured: boolean
  limit: number
  window_seconds: number
  used: number
  remaining: number
}

// ---- Fase 2 ----

export interface FinancialPeriod {
  fiscal_year: string
  end_date?: string
  revenue?: number | null
  gross_profit?: number | null
  operating_income?: number | null
  net_income?: number | null
  eps_diluted?: number | null
  cfo?: number | null
  capex?: number | null
  total_assets?: number | null
  total_liabilities?: number | null
  equity?: number | null
  shares_outstanding?: number | null
  [key: string]: string | number | null | undefined
}

export interface RatioPeriod {
  fiscal_year: string
  [key: string]: string | number | null | undefined
}

export interface Financials extends Sourced {
  symbol: string
  entity?: string | null
  periods: FinancialPeriod[]
  ratios: RatioPeriod[]
  growth: {
    years: number
    revenue_cagr: number | null
    eps_cagr: number | null
    fcf_cagr: number | null
  }
}

export interface AltmanZ {
  score: number | null
  zone: string | null
  components: Record<string, number | null>
  note: string
}

export interface PiotroskiSignal {
  name: string
  passed: boolean | null
  detail: string
}

export interface Health extends Sourced {
  symbol: string
  altman_z: AltmanZ
  piotroski_f: {
    score: number | null
    max_possible: number
    signals: PiotroskiSignal[]
    fiscal_years?: string[]
  }
  interest_coverage: number | null
  net_debt: number | null
  fcf: number | null
  fiscal_year?: string
  market_cap_used: number | null
}

export interface ValuationDefaults extends Sourced {
  symbol: string
  base_fcf: number | null
  net_debt: number | null
  shares_outstanding: number | null
  historical_growth: Financials['growth']
  suggested_growth_capped: number | null
  current_price: number | null
  fiscal_year?: string
  note: string
}

export interface ScenarioAssumptions {
  growth_rate: number
  discount_rate: number
  terminal_growth: number
}

export interface DcfScenarioResult {
  assumptions: Record<string, number | null>
  value_per_share: number | null
  equity_value: number
  terminal_weight: number | null
}

export interface DcfResponse {
  symbol: string
  scenarios: Record<string, DcfScenarioResult>
  sensitivity: {
    growth_rates: number[]
    rows: { discount_rate: number; values: (number | null)[] }[]
  } | null
  current_price: number | null
  computed_by: string
}

export interface PeersResponse extends Sourced {
  symbol: string
  peers: { symbol: string; metrics: Record<string, number | null>; source: string }[]
  percentiles: Record<string, number | null>
  comparison_keys: string[]
  note: string
}

export interface RiskResponse extends Sourced {
  symbol: string
  window: string
  beta_vs_spy: number | null
  annualized_volatility: number | null
  max_drawdown: { max_drawdown: number; peak: string; trough: string } | null
}

export interface FilingEntry {
  type: string
  filed_at: string
  accession_no: string
  url: string
}

export interface FilingsResponse extends Sourced {
  symbol: string
  filings: FilingEntry[]
  insider_filings: FilingEntry[]
}

export interface IndexEntry {
  symbol: string
  label: string
  quote: Quote | null
}

export interface SectorEntry {
  symbol: string
  label: string
  change_pct: number | null
  quote: Quote | null
}

export interface YieldCurve {
  curve: { tenor: string; series_id: string; value: number | null; ts: string | null }[]
  spread_10y_2y: number | null
  spread_series: { ts: string; value: number | null }[]
  note: string
}

export interface MacroIndicator {
  series_id: string
  label: string
  value: number | null
  ts: string | null
}

export interface NewsItem {
  headline: string
  summary: string | null
  url: string
  published_at: string | null
  source: string | null
  related: string | null
}

export interface NewsFeed extends Sourced {
  symbol: string | null
  items: NewsItem[]
}

export interface Interpretation {
  generated_by: 'llm'
  content_md: string
  model: string
  created_at: string | null
  cached: boolean
  disclaimer: string
}

// ---- Fase 4 ----

export interface EtfHolding {
  symbol: string
  name: string | null
  weight: number | null
}

export interface EtfData extends Sourced {
  symbol: string
  name: string | null
  category: string | null
  expense_ratio: number | null
  aum: number | null
  dividend_yield: number | null
  currency: string | null
  top_holdings: EtfHolding[]
  sector_weights: Record<string, number>
  coverage_note?: string
}

export interface EtfOverlap {
  a: string
  b: string
  overlap_weight: number
  shared_count: number
  common_holdings: {
    symbol: string
    weight_a: number
    weight_b: number
    min_weight: number
  }[]
  note: string
}

export interface EtfComparison {
  etfs: EtfData[]
  overlaps: EtfOverlap[]
  errors: Record<string, string>
  note: string
}

export interface FilterSpec {
  op: 'gte' | 'lte'
  value: number
}

export interface ScreenerPreset {
  id?: number
  name: string
  logic_md: string | null
  filters: Record<string, FilterSpec>
  created_at?: string
}

export interface ScreenCheck {
  metric: string
  op: 'gte' | 'lte'
  value: number
  actual: number | null
  passed: boolean
}

export interface ScreenRow {
  symbol: string
  passes: boolean
  checks: ScreenCheck[]
  metrics: Record<string, number | null>
  source: string
  cached: boolean
}

export interface ScreenResult {
  results: ScreenRow[]
  unavailable: { symbol: string; reason: string }[]
  passed: number
  evaluated: number
  note: string
}

export interface EarningsEvent {
  symbol: string
  date: string
  hour: string | null
  quarter: number | null
  year: number | null
  eps_estimate: number | null
  eps_actual: number | null
  revenue_estimate: number | null
  revenue_actual: number | null
}

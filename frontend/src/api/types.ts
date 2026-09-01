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

export interface LlmStatus {
  configured: boolean
  model: string | null
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

// ---- Fase 5 ----

export interface WatchlistItem {
  id: number
  symbol: string
  name: string | null
  sector: string | null
  notes: string | null
  added_at: string
  quote: Quote | null
}

export interface PortfolioPosition {
  id: number
  symbol: string
  name: string | null
  sector: string
  opened_at: string
  quantity: number
  cost_basis: number
  invested: number
  price: number | null
  market_value: number | null
  unrealized_pnl: number | null
  unrealized_pct: number | null
}

export interface ClosedPosition {
  id: number
  symbol: string
  quantity: number
  cost_basis: number
  realized_pnl: number | null
  closed_at: string
}

export interface Allocation {
  label: string
  market_value: number
  weight: number
}

/** Qué le habría pasado a ESTA composición en el peor tramo del histórico.
 *  No son escenarios inventados: son tus pesos de hoy aplicados al pasado. */
export interface Estres {
  suficiente: boolean
  nota?: string
  max_drawdown_pct?: number
  drawdown_desde?: string
  drawdown_hasta?: string
  peor_ventana_pct?: number | null
  peor_ventana_meses?: number
  peor_ventana_desde?: string | null
  peor_ventana_hasta?: string | null
  /** Por qué la peor ventana viene vacía: el histórico no llega. */
  peor_ventana_nota?: string | null
  cobertura?: string
  años_cubiertos?: number
  aviso_cobertura?: string
}

export interface Portfolio {
  risk_budget: RiskBudget
  estres: Estres
  positions: PortfolioPosition[]
  closed_positions: ClosedPosition[]
  summary: {
    total_invested: number
    total_market_value: number | null
    unrealized_pnl: number | null
    unrealized_pct: number | null
    realized_pnl: number
    priced_positions: number
    total_positions: number
    /** Ninguna rentabilidad viaja sola: esta es la caída que la acompaña. */
    max_drawdown_esperado_pct: number | null
    peor_ventana_pct?: number | null
    aviso_cobertura: string
  }
  allocation_by_position: Allocation[]
  allocation_by_sector: Allocation[]
  concentration_warnings: string[]
  note: string
}

export interface PriceAlert {
  id: number
  symbol: string
  kind: string
  condition: { op?: string; price?: number }
  active: boolean
  current_price: number | null
  triggered: boolean | null
  triggered_at: string | null
}

export interface ScenarioRecord {
  id: number
  kind: 'bear' | 'base' | 'bull'
  assumptions: Record<string, number | string>
  value_low: number | null
  value_mid: number | null
  value_high: number | null
  price_at_creation: number | null
  created_at: string
  days_elapsed: number
  direction: string | null
  outcome: 'acertado' | 'fallido' | null
  price_change_pct: number | null
  implied_upside_pct: number | null
  estimate_error_pct?: number | null
  reason: string | null
}

export interface ThesisRecord {
  id: number
  symbol: string
  title: string
  body_md: string
  assumptions: Record<string, unknown> | null
  invalidation_criteria: string | null
  created_at: string
  days_elapsed: number
  current_price: number | null
  scenarios: ScenarioRecord[]
}

export interface TrackRecordEntry extends ScenarioRecord {
  scenario_id: number
  thesis_id: number | null
  symbol: string
  current_price: number | null
}

export interface TrackRecord {
  scenarios: TrackRecordEntry[]
  summary: {
    total: number
    evaluable: number
    hits: number
    misses: number
    hit_rate: number | null
    median_estimate_error_pct: number | null
    note: string
  }
}

// ---- Motor de señales cuantitativas ----

export interface NewsEvent {
  headline: string | null
  category: string
  confidence: string
  rationale: string | null
  weight: number
  model: string
}

export interface QuantSignal {
  symbol: string
  rank?: number
  score: number | null
  label: string
  coverage: number
  contributions: Record<string, number>
  families: Record<string, number | null>
  horizon: string
  probability: number | null
  probability_ci: [number, number] | null
  probability_note: string | null
  sample_size: number
  computed_by: string
  context: { name?: string | null; sector?: string | null; source?: string }
  events: NewsEvent[]
}

export interface SignalResponse {
  signals: QuantSignal[]
  unavailable: { symbol: string; reason: string }[]
  calibrated: boolean
  weights: Record<string, number>
  universe_size: number
  note: string
  disclaimer: string
}

export interface UniverseInfo {
  key: string
  name: string
  description: string
  size: number
  symbols: string[]
}

export interface ScanResponse {
  universe_key: string
  universe_name: string
  universe_description: string
  top: QuantSignal[]
  all_ranked: { symbol: string; score: number | null; label: string; rank?: number }[]
  scored: number
  requested: number
  unavailable: { symbol: string; reason: string }[]
  calibrated: boolean
  momentum_source: string | null
  momentum_coverage: number
  weights: Record<string, number>
  note: string
  disclaimer: string
}

/** Precio y serie derivados de la descarga masiva que ya hacía el momentum. */
export interface DailyPrice {
  last: number
  /** Variación frente al cierre anterior, en %. */
  change_pct: number | null
  low_52w: number
  high_52w: number
  /** Posición dentro del rango anual: 0 = mínimo, 1 = máximo. */
  range_position: number | null
  spark: number[]
  points: number
  source: string | null
  as_of: string | null
}

export type DecisionAction =
  | 'comprar'
  | 'vigilar'
  | 'mantener'
  | 'reducir'
  | 'vender'
  | 'evitar'
  | 'ninguna'
  | 'sin_datos'

export interface DecisionLevels {
  /** Nulos sobre una posición abierta: ya la tienes, no hay nada que entrar. */
  entrada_desde: number | null
  entrada_hasta: number | null
  stop: number
  /** Distancia del stop **desde el precio de hoy**. Positiva = ya perforado. */
  stop_pct: number
  objetivo: number
  objetivo_pct: number
  ratio: number
  /** Peso BRUTO: lo que este stop permite mirando esta empresa sola. NO es
   *  el peso final — ese depende de toda la cartera y lo decide el sizer. */
  peso_bruto_pct: number | null
}

/** Qué hacer, a qué precio y con qué salida. Reglas mecánicas, no opinión. */
export interface Decision {
  action: DecisionAction
  label: string
  reasons: string[]
  levels: DecisionLevels | null
  /** Percentiles reales del histórico simulado, no supuestos. */
  escenarios: {
    bajista: number
    base: number
    alcista: number
    n: number
    nota: string
  } | null
  triggers: string[]
  /** `refutada` = las reglas se probaron contra histórico y perdieron dinero. */
  confidence: 'calibrada' | 'refutada' | 'sin_calibrar' | 'ninguna'
  /** Si ya tienes la empresa en cartera: cambia la pregunta a sostener o soltar. */
  owned: boolean
  pnl_pct?: number | null
}

/** Señal de la lista diaria: como QuantSignal, más su sector y su precio. */
export interface DailySignal extends Omit<QuantSignal, 'score' | 'context'> {
  score: number // en /today las no puntuables se descartan: nunca es null
  sector_rank: number | null
  price: DailyPrice | null
  decision: Decision
  context: {
    name?: string | null
    sector?: string | null
    sector_key?: string
    sector_name?: string
    source?: string
  }
}

export interface DailySectorMeta {
  key: string
  name: string
  requested: number
  scored: number
  pending: number
  usable: boolean
}

export interface MarketInfo {
  key: string
  name: string
  description: string
  companies: number
  sectors: number
}

export interface UniversesMeta {
  retrieved_at: string
  markets: Record<string, { source: string; companies: number }>
}

export interface Conviction {
  valor: number
  acuerdo: number
  factores_a_favor: string[]
  factores_en_contra: string[]
  eficiencia_riesgo: number
  puesto?: number
  resumen?: string
}

/** Las pocas que comprar y las pocas que evitar. Un umbral dice quién califica;
 *  esto dice cuáles pocas. */
export interface Sizing {
  /** Lo que se AÑADE a cada posición, no su peso final. */
  pesos: Record<string, number>
  invertido_pct: number
  /** Lo que las posiciones abiertas ya ocupan: los topes lo cuentan. */
  ya_invertido_pct?: number
  invertido_total_pct?: number
  liquidez_pct: number
  vol_estimada_pct: number | null
  /** Volatilidad de la cartera actual sola, sin las ideas nuevas. */
  vol_cartera_actual_pct?: number | null
  objetivo_vol_pct: number
  escala_aplicada: number
  clusters: string[][]
  cartera_actual?: Record<string, number>
  recortes: string[]
  /** Posiciones abiertas que este barrido no pudo valorar. */
  aviso_cartera?: string
  nota: string
}

export interface Shortlist {
  /** El tamaño se decide sobre el conjunto, no idea por idea. */
  sizing: Sizing
  ideas: (DailySignal & { conviction: Conviction; peso_final_pct: number | null })[]
  evitar: (DailySignal & { conviction: Conviction })[]
  candidatas: number
  descartadas_por_sector: number
  nota: string
}

export interface TodayResponse {
  shortlist: Shortlist
  asset_class?: 'accion' | 'cripto' | 'etf'
  /** Sin fundamentales, la puntuación sale solo de momentum. */
  solo_momentum?: boolean
  as_of: string
  market_key: string
  market_name: string
  market_description: string
  /** TODAS las puntuadas, de mejor a peor — incluida la franja neutral. */
  signals: DailySignal[]
  counts: { favorables: number; neutrales: number; desfavorables: number }
  /** Fronteras de los cubos; vienen del backend para no duplicarlas aquí. */
  thresholds: { favorable: number; desfavorable: number }
  sectors: DailySectorMeta[]
  scored: number
  requested: number
  /** Cuántas quedan por descargar: los tiers gratuitos limitan cada pasada. */
  pending: number
  complete: boolean
  fetched_now: number
  data_meta: UniversesMeta | Record<string, never>
  unavailable: { symbol: string; reason: string }[]
  calibrated: boolean
  momentum_source: string | null
  note: string
  disclaimer: string
  cached?: boolean
  fetched_at?: string
}

export interface CalibrationBucket {
  n: number
  hits: number
  rate: number | null
  ci_low: number
  ci_high: number
  reliable: boolean
}

export interface BacktestResponse {
  calibration: Record<string, CalibrationBucket>
  n_observations: number
  n_rebalances: number
  overall_hit_rate: number | null
  horizon_months: number
  universe: string[]
  missing: string[]
  excluded_factors: string[]
  methodology: string
  reliable_buckets: number
  verdict: string
}

export interface SignalExplanation {
  generated_by: 'llm'
  content_md: string
  model: string
  disclaimer: string
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

// ---- Informe de analista (deep dive) ----

export interface MultipleStats {
  available: boolean
  n: number
  reason?: string
  current?: number | null
  median?: number
  min?: number
  max?: number
  p25?: number
  p75?: number
  percentile?: number | null
  cheapness_percentile?: number | null
  vs_median_pct?: number | null
  series?: { ts: string; value: number }[]
}

export interface ValuationHistory {
  multiples: Record<string, MultipleStats>
  cheapness_score: number | null
  reading: string
  years_covered: number
  caveats: string[]
}

export interface DeepDiveRisk {
  type: string
  severity: string
  evidence: string
  why: string
}

export interface DeepDiveCatalyst {
  type: string
  when: string | null
  detail: string | null
  source: string
  url?: string
}

export interface Verdict {
  stance: string
  positives: string[]
  negatives: string[]
  quant_label: string | null
  quant_score: number | null
  summary: string
  what_would_change_it: string[]
  disclaimer: string
}

export interface DeepDiveReport {
  symbol: string
  generated_at: string | null
  price: number | null
  business: {
    name: string | null
    sector: string | null
    country: string | null
    website: string | null
    market_cap: number | null
    latest_revenue: number | null
    latest_fiscal_year: string | null
    revenue_by_year: { year: string; revenue: number | null }[]
    years_of_history: number
    note: string
  }
  growth: {
    years: number
    revenue_cagr: number | null
    eps_cagr: number | null
    fcf_cagr: number | null
    revenue_cagr_3y: number | null
    yoy: { year: string; growth: number | null }[]
    acceleration: string | null
    reading: string
  }
  margins: {
    by_year: { year: string; gross_margin: number | null; operating_margin: number | null; net_margin: number | null }[]
    current: { gross_margin: number | null; operating_margin: number | null; net_margin: number | null }
    trends: Record<string, string | null>
    reading: string
  }
  debt: {
    net_debt: number | null
    total_debt: number | null
    cash: number | null
    debt_to_equity: number | null
    interest_coverage: number | null
    altman_z: AltmanZ
    piotroski_f: { score: number | null; max_possible: number; signals: PiotroskiSignal[] }
    by_year: { year: string; total_debt: number | null; cash: number | null }[]
    leverage_trend: string | null
    reading: string
  }
  cash_flow: {
    by_year: {
      year: string
      cfo: number | null
      capex: number | null
      fcf: number | null
      fcf_margin: number | null
      fcf_conversion: number | null
      capex_intensity: number | null
    }[]
    current: Record<string, number | null | string>
    fcf_trend: string | null
    reading: string
  }
  valuation: ValuationHistory
  dcf: {
    scenarios: Record<string, DcfScenarioResult>
    base_fcf: number
    net_debt: number
    shares_outstanding: number
    current_price: number | null
    note: string
  } | null
  quant_signal: QuantSignal | null
  risk_metrics: {
    annualized_volatility: number | null
    max_drawdown: { max_drawdown: number; peak: string; trough: string } | null
  } | null
  risks: DeepDiveRisk[]
  catalysts: DeepDiveCatalyst[]
  verdict: Verdict
  data_sources: { financials: string; quote: string | null; as_of: string }
  computed_by: string
}

export interface DeepDiveNarrative {
  generated_by: 'llm'
  content_md: string
  model: string
  disclaimer: string
}

/** Una operación simulada por el backtest de reglas. */
export interface RuleTrade {
  symbol: string
  score: number
  entrada_fecha: string
  entrada: number
  salida_fecha: string
  salida: number
  motivo: 'stop' | 'objetivo' | 'plazo'
  sesiones: number
  stop_pct: number
  objetivo_pct: number
  bruto_pct: number
  neto_pct: number
  ganadora: boolean
}

/** ¿Ganan dinero las reglas? Simulación operación a operación, neta de costes. */
export interface RuleBacktestResponse {
  n_operaciones: number
  fiable: boolean
  tasa_acierto?: number
  tasa_acierto_ic?: [number, number]
  esperanza_pct?: number
  media_ganadora_pct?: number
  media_perdedora_pct?: number
  factor_beneficio?: number | null
  peor_operacion_pct?: number
  mejor_operacion_pct?: number
  racha_perdedora?: number
  salidas?: Record<'stop' | 'objetivo' | 'plazo', number>
  /** Qué habría dado comprar el universo entero a ciegas en las mismas fechas. */
  referencia_pct?: number | null
  ventaja_pct?: number | null
  coste_por_lado_pct: number
  coste_total_por_operacion_pct: number
  filtro_tendencia: boolean
  umbral: number
  descartes: Record<string, number>
  operaciones: RuleTrade[]
  sesgo_supervivencia: string
  metodologia?: string
  nota?: string
  universo: string[]
  sin_datos: string[]
  periodo: { desde: string; hasta: string }
  comparativa_sin_filtro_tendencia: {
    n_operaciones: number
    esperanza_pct?: number
    tasa_acierto?: number
  }
  veredicto: string
}

/** Evaluación de un ETF con criterios propios del activo, no del modelo de acciones. */
export interface EtfPick {
  symbol: string
  name: string | null
  valor: number
  action: 'comprar' | 'vigilar' | 'evitar' | 'ninguna'
  expense_ratio: number | null
  aum: number | null
  reasons: string[]
}

export interface EtfRecommendation {
  evaluados: EtfPick[]
  recomendados: string[]
  avisos: string[]
  nota: string
  errors: Record<string, string>
  aviso_solapamiento: string
}

/** Riesgo abierto: lo que perderías si TODAS tus posiciones tocaran su stop. */
export interface RiskBudget {
  riesgo_total_pct: number
  tope_pct: number
  por_grupo: Record<string, number>
  tope_grupo_pct: number
  posiciones: {
    symbol: string
    grupo: string
    riesgo_pct: number
    peso_pct: number
    nota: string | null
  }[]
  sin_calcular: number
  avisos: string[]
  margen_pct: number
  nota: string
}

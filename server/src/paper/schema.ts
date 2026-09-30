// Lo que convierte paper_bets en un registro auditable, y los registros de predicciones en
// algo que no puede desaparecer. Sin imports: lo ejecuta db.ts al abrir la base, después de
// migrar las columnas (los triggers nombran columnas que la migración añade).
//
// ===========================================================================
// LAS REGLAS, EN LA BASE DE DATOS Y NO EN LA BUENA VOLUNTAD
// ===========================================================================
// Una apuesta de papel tiene tres momentos, y cada uno escribe lo suyo UNA vez:
//
//   al apostar   todo lo que se sabía entonces: probabilidades, cuota, importe, banco,
//                versiones, marcas de tiempo, apertura y cuota de la señal. CONGELADO.
//   al cerrar    la cuota de cierre y el CLV. Se escriben una vez; después, congelados.
//   al liquidar  resultado, beneficio, banco después, ROI. Una vez; después, congelados.
//
// Los triggers de abajo hacen que cualquier otra escritura FALLE. No se puede corregir
// una probabilidad, cambiar la cuota por la de cierre, rehacer el importe, recalcular con
// un modelo nuevo ni borrar la fila. Un registro que se puede reescribir no es un
// registro; es una opinión con fecha.

/** Las columnas nuevas de paper_bets (la tabla ya existía: se añaden por migración). */
export const PAPER_BET_COLUMNS: Record<string, string> = {
  league: 'TEXT',
  market: "TEXT DEFAULT 'h2h'",
  commence_time: 'TEXT',
  /** El id del evento en The Odds API, para buscar sus snapshots. */
  provider_event_id: 'TEXT',
  /** La selección con el nombre del proveedor («Draw» y no «Empate»). */
  provider_selection: 'TEXT',
  model_probability_raw: 'REAL',
  model_probability_calibrated: 'REAL',
  market_probability_raw: 'REAL',
  market_probability_no_vig: 'REAL',
  edge: 'REAL',
  bookmaker: 'TEXT',
  books: 'INTEGER',
  line: 'REAL',
  stake_pct_bankroll: 'REAL',
  kelly_raw: 'REAL',
  kelly_fraction_used: 'REAL',
  bankroll_after: 'REAL',
  model_version: 'TEXT',
  model_config_version: 'TEXT',
  calibration_version: 'TEXT',
  data_version: 'TEXT',
  strategy_version: 'TEXT',
  git_commit: 'TEXT',
  prediction_timestamp: 'TEXT',
  odds_timestamp: 'TEXT',
  opening_odds: 'REAL',
  opening_observed_at: 'TEXT',
  signal_odds: 'REAL',
  signal_observed_at: 'TEXT',
  closing_odds: 'REAL',
  closing_line: 'REAL',
  closing_observed_at: 'TEXT',
  clv: 'REAL',
  event_result: 'TEXT',
  roi: 'REAL',
};

/** Congeladas desde el INSERT. */
const CONGELADAS = [
  'placed_at', 'sport', 'match_key', 'event_id', 'label', 'selection', 'p_model', 'p_market', 'odds', 'stake', 'bankroll_at',
  'league', 'market', 'commence_time', 'provider_event_id', 'provider_selection',
  'model_probability_raw', 'model_probability_calibrated', 'market_probability_raw', 'market_probability_no_vig', 'edge',
  'bookmaker', 'books', 'line', 'stake_pct_bankroll', 'kelly_raw', 'kelly_fraction_used',
  'model_version', 'model_config_version', 'calibration_version', 'data_version', 'strategy_version', 'git_commit',
  'prediction_timestamp', 'odds_timestamp', 'opening_odds', 'opening_observed_at', 'signal_odds', 'signal_observed_at',
];
/** Se escriben al liquidar, una sola vez. */
const LIQUIDACION = ['status', 'settled_at', 'profit', 'event_result', 'bankroll_after', 'roi'];
/** Se escriben al cerrar el mercado, una sola vez. */
const CIERRE = ['closing_odds', 'closing_line', 'closing_observed_at', 'clv'];

export const ESTADOS = ['pending', 'won', 'lost', 'push', 'void', 'cancelled'];

const distinto = (cols: string[]) => cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
const estados = ESTADOS.map((e) => `'${e}'`).join(', ');

export const PAPER_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS paper_bets_no_delete
    BEFORE DELETE ON paper_bets
    BEGIN SELECT RAISE(ABORT, 'paper_bets: una apuesta registrada no se borra'); END;

  CREATE TRIGGER IF NOT EXISTS paper_bets_congelada
    BEFORE UPDATE ON paper_bets
    WHEN ${distinto(CONGELADAS)}
    BEGIN SELECT RAISE(ABORT, 'paper_bets: los datos de la apuesta quedan congelados al registrarla'); END;

  CREATE TRIGGER IF NOT EXISTS paper_bets_liquida_una_vez
    BEFORE UPDATE ON paper_bets
    WHEN OLD.status <> 'pending' AND (${distinto(LIQUIDACION)})
    BEGIN SELECT RAISE(ABORT, 'paper_bets: una apuesta liquidada no se vuelve a liquidar'); END;

  CREATE TRIGGER IF NOT EXISTS paper_bets_cierre_una_vez
    BEFORE UPDATE ON paper_bets
    WHEN OLD.closing_odds IS NOT NULL AND (${distinto(CIERRE)})
    BEGIN SELECT RAISE(ABORT, 'paper_bets: la cuota de cierre se fija una sola vez'); END;

  CREATE TRIGGER IF NOT EXISTS paper_bets_estado_valido
    BEFORE UPDATE OF status ON paper_bets
    WHEN NEW.status NOT IN (${estados})
    BEGIN SELECT RAISE(ABORT, 'paper_bets: estado desconocido'); END;

  CREATE TRIGGER IF NOT EXISTS paper_bets_alta_valida
    BEFORE INSERT ON paper_bets
    WHEN NEW.status NOT IN (${estados})
      OR NEW.odds <= 1 OR NEW.stake <= 0
      OR (NEW.commence_time IS NOT NULL AND NEW.placed_at >= NEW.commence_time)
      OR NEW.closing_odds IS NOT NULL OR NEW.profit IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'paper_bets: alta inválida (cuota, importe, estado, o apuesta posterior al inicio o con datos del futuro)'); END;
`;

// ===========================================================================
// LOS REGISTROS DE PREDICCIONES: NO SE BORRAN Y LA PREDICCIÓN NO SE REESCRIBE
// ===========================================================================
// Se pueden anotar el resultado (lo que pasó después) y rellenar una sola vez la
// probabilidad enseñada. Lo que el modelo DIJO no se toca: si mañana cambia el modelo, lo
// de ayer sigue diciendo lo que dijo.
/** Las versiones de una predicción: se fijan una vez (al registrarla) y no cambian. */
const VERSIONES = ['model_version', 'model_config_version', 'calibration_version', 'data_version', 'git_commit'];

const LOGS: { tabla: string; congeladas: string[]; unaVez: string[] }[] = [
  { tabla: 'prediction_log', congeladas: ['match_key', 'p1_id', 'p2_id', 'prob1', 'market_prob1', 'predicted_at'], unaVez: VERSIONES },
  {
    tabla: 'fb_prediction_log',
    congeladas: ['match_key', 'home_id', 'away_id', 'prob_home', 'prob_draw', 'prob_away', 'market_prob_home', 'market_prob_draw', 'market_prob_away', 'predicted_at'],
    unaVez: ['shown_home', 'shown_draw', 'shown_away', ...VERSIONES],
  },
  { tabla: 'bb_prediction_log', congeladas: ['game_key', 'home_id', 'away_id', 'prob_home', 'market_prob_home', 'predicted_at'], unaVez: VERSIONES },
  { tabla: 'bsb_prediction_log', congeladas: ['match_key', 'home_id', 'away_id', 'prob_home', 'market_prob_home', 'predicted_at'], unaVez: VERSIONES },
  { tabla: 'naf_prediction_log', congeladas: ['match_key', 'home_id', 'away_id', 'prob_home', 'market_prob_home', 'predicted_at'], unaVez: ['shown_home', ...VERSIONES] },
];

export const PREDICTION_LOG_TRIGGERS = LOGS.map(
  (l) => `
  CREATE TRIGGER IF NOT EXISTS ${l.tabla}_no_delete
    BEFORE DELETE ON ${l.tabla}
    BEGIN SELECT RAISE(ABORT, '${l.tabla}: una predicción registrada no se borra'); END;
  CREATE TRIGGER IF NOT EXISTS ${l.tabla}_congelada
    BEFORE UPDATE ON ${l.tabla}
    WHEN ${distinto(l.congeladas)}${l.unaVez.length ? ` OR ${l.unaVez.map((c) => `(OLD.${c} IS NOT NULL AND NEW.${c} IS NOT OLD.${c})`).join(' OR ')}` : ''}
    BEGIN SELECT RAISE(ABORT, '${l.tabla}: lo que el modelo dijo no se reescribe'); END;`,
).join('\n');

// ===========================================================================
// LAS SEÑALES: CADA VEZ QUE EL MODELO MIRÓ UN PARTIDO CON PRECIO REAL
// ===========================================================================
// Las apuestas son una muestra sesgada de lo que el modelo detecta: solo las que pasaron
// todos los topes. Para saber si el EDGE es real hace falta todo lo evaluado, apostado o
// no. Cada fila: la selección que eligió la política, sus probabilidades, la cuota, la
// ventaja, la decisión y su motivo. Append-only; el cierre y el CLV se fijan una vez.
export const EDGE_SIGNALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS edge_signals (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at                   TEXT NOT NULL,
    sport                        TEXT NOT NULL,
    league                       TEXT,
    event_id                     TEXT NOT NULL,
    provider_event_id            TEXT,
    market                       TEXT NOT NULL DEFAULT 'h2h',
    selection                    TEXT NOT NULL,
    provider_selection           TEXT,
    model_probability_raw        REAL,
    model_probability_calibrated REAL NOT NULL,
    market_probability_no_vig    REAL,
    odds                         REAL NOT NULL CHECK (odds > 1),
    edge                         REAL NOT NULL,
    kelly_raw                    REAL,
    decision                     TEXT NOT NULL CHECK (decision IN ('apostada', 'rechazada')),
    reason                       TEXT,
    stake                        REAL NOT NULL DEFAULT 0,
    paper_bet_id                 INTEGER,
    model_version                TEXT,
    calibration_version          TEXT,
    strategy_version             TEXT,
    data_version                 TEXT,
    git_commit                   TEXT,
    prediction_timestamp         TEXT,
    odds_timestamp               TEXT,
    commence_time                TEXT,
    closing_odds                 REAL,
    closing_observed_at          TEXT,
    clv                          REAL,
    CHECK (commence_time IS NULL OR created_at < commence_time)
  );
  CREATE INDEX IF NOT EXISTS idx_signals_event ON edge_signals (event_id, selection, id);

  CREATE TRIGGER IF NOT EXISTS edge_signals_no_delete
    BEFORE DELETE ON edge_signals
    BEGIN SELECT RAISE(ABORT, 'edge_signals: una señal registrada no se borra'); END;
  CREATE TRIGGER IF NOT EXISTS edge_signals_congelada
    BEFORE UPDATE ON edge_signals
    WHEN ${distinto([
      'created_at', 'sport', 'league', 'event_id', 'provider_event_id', 'market', 'selection', 'provider_selection',
      'model_probability_raw', 'model_probability_calibrated', 'market_probability_no_vig', 'odds', 'edge', 'kelly_raw',
      'decision', 'reason', 'stake', 'paper_bet_id', 'model_version', 'calibration_version', 'strategy_version',
      'data_version', 'git_commit', 'prediction_timestamp', 'odds_timestamp', 'commence_time',
    ])}
    BEGIN SELECT RAISE(ABORT, 'edge_signals: una señal registrada queda congelada'); END;
  CREATE TRIGGER IF NOT EXISTS edge_signals_cierre_una_vez
    BEFORE UPDATE ON edge_signals
    WHEN OLD.closing_odds IS NOT NULL AND (${distinto(['closing_odds', 'closing_observed_at', 'clv'])})
    BEGIN SELECT RAISE(ABORT, 'edge_signals: la cuota de cierre se fija una sola vez'); END;
`;

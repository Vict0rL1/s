// El laboratorio de estrategias (Fase 6.1): bancos de papel con nombre, cada uno con su
// configuración, que apuestan en paralelo sobre las mismas candidatas que el banco principal.
// Libro mayor. Sin imports: lo ejecuta db.ts al migrar.
//
// Una estrategia NO se edita. Cambiar la ventaja mínima a mitad de camino haría que su
// registro mezclara dos hipótesis y no midiera ninguna; cambiarla es crear otra y comparar.
// Lo único que admite es archivarse, una vez, y desde entonces deja de apostar.
//
// Sus apuestas siguen las reglas de `paper_bets` (paper/schema.ts): lo que se sabía al
// apostar queda congelado desde el INSERT, el cierre se fija una vez, la liquidación una vez,
// y nada se borra.

const CONGELADAS = [
  'strategy_id', 'placed_at', 'sport', 'league', 'match_key', 'event_id', 'provider_event_id', 'label', 'selection',
  'provider_selection', 'commence_time', 'p_model', 'p_market', 'odds', 'edge', 'stake', 'bankroll_at', 'kelly_fraction',
  'trust_factor', 'correlation_groups',
];
const LIQUIDACION = ['status', 'settled_at', 'profit', 'event_result', 'bankroll_after'];
const CIERRE = ['closing_odds', 'closing_observed_at', 'clv'];
export const ESTADOS_ESTRATEGIA = ['pending', 'won', 'lost', 'push', 'void', 'cancelled'];

const distinto = (cols: string[]) => cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
const estados = ESTADOS_ESTRATEGIA.map((e) => `'${e}'`).join(', ');

export const STRATEGIES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS strategies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    config      TEXT NOT NULL,      -- JSON: deportes, mercados, staking, confianza
    hash        TEXT NOT NULL,      -- sha-256 del JSON canónico
    nota        TEXT,
    archived_at TEXT
  );
  CREATE TRIGGER IF NOT EXISTS strategies_no_delete
    BEFORE DELETE ON strategies
    BEGIN SELECT RAISE(ABORT, 'strategies: una estrategia no se borra; se archiva'); END;
  CREATE TRIGGER IF NOT EXISTS strategies_solo_archivar
    BEFORE UPDATE ON strategies
    WHEN OLD.archived_at IS NOT NULL OR ${distinto(['created_at', 'nombre', 'config', 'hash', 'nota'])}
    BEGIN SELECT RAISE(ABORT, 'strategies: una estrategia no se edita; cambiarla es crear otra'); END;

  CREATE TABLE IF NOT EXISTS strategy_bets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id         INTEGER NOT NULL,
    placed_at           TEXT NOT NULL,
    sport               TEXT NOT NULL,
    league              TEXT,
    match_key           TEXT NOT NULL,
    event_id            TEXT NOT NULL,
    provider_event_id   TEXT,
    label               TEXT NOT NULL,
    selection           TEXT NOT NULL,
    provider_selection  TEXT,
    commence_time       TEXT,
    p_model             REAL NOT NULL,
    p_market            REAL NOT NULL,
    odds                REAL NOT NULL,
    edge                REAL NOT NULL,
    stake               REAL NOT NULL,
    bankroll_at         REAL NOT NULL,
    kelly_fraction      REAL,
    trust_factor        REAL,
    closing_odds        REAL,
    closing_observed_at TEXT,
    clv                 REAL,
    status              TEXT NOT NULL DEFAULT 'pending',
    settled_at          TEXT,
    profit              REAL,
    event_result        TEXT,
    bankroll_after      REAL,
    correlation_groups  TEXT,           -- JSON: evento, equipos o jugadores (seguimiento; antes, NULL)
    policy_version_id   INTEGER,        -- la versión de la política con la que se apostó (lote C, C5)
    UNIQUE (strategy_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_strategy_bets_estado ON strategy_bets (strategy_id, status);

  CREATE TRIGGER IF NOT EXISTS strategy_bets_no_delete
    BEFORE DELETE ON strategy_bets
    BEGIN SELECT RAISE(ABORT, 'strategy_bets: una apuesta registrada no se borra'); END;
  CREATE TRIGGER IF NOT EXISTS strategy_bets_congelada
    BEFORE UPDATE ON strategy_bets
    WHEN ${distinto(CONGELADAS)}
    BEGIN SELECT RAISE(ABORT, 'strategy_bets: los datos de la apuesta quedan congelados al registrarla'); END;
  CREATE TRIGGER IF NOT EXISTS strategy_bets_liquida_una_vez
    BEFORE UPDATE ON strategy_bets
    WHEN OLD.status <> 'pending' AND (${distinto(LIQUIDACION)})
    BEGIN SELECT RAISE(ABORT, 'strategy_bets: una apuesta liquidada no se vuelve a liquidar'); END;
  CREATE TRIGGER IF NOT EXISTS strategy_bets_cierre_una_vez
    BEFORE UPDATE ON strategy_bets
    WHEN OLD.closing_odds IS NOT NULL AND (${distinto(CIERRE)})
    BEGIN SELECT RAISE(ABORT, 'strategy_bets: la cuota de cierre se fija una sola vez'); END;
  CREATE TRIGGER IF NOT EXISTS strategy_bets_estado_valido
    BEFORE UPDATE OF status ON strategy_bets
    WHEN NEW.status NOT IN (${estados})
    BEGIN SELECT RAISE(ABORT, 'strategy_bets: estado desconocido'); END;
  CREATE TRIGGER IF NOT EXISTS strategy_bets_alta_valida
    BEFORE INSERT ON strategy_bets
    WHEN NEW.status <> 'pending' OR NEW.odds <= 1 OR NEW.stake <= 0
      OR (NEW.commence_time IS NOT NULL AND NEW.placed_at >= NEW.commence_time)
      OR NEW.closing_odds IS NOT NULL OR NEW.profit IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'strategy_bets: alta inválida (cuota, importe, estado, o apuesta posterior al inicio o con datos del futuro)'); END;
`;

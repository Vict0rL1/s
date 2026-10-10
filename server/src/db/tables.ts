// Qué tabla vive en qué fichero. UNA lista, y de aquí beben la migración, la publicación
// nocturna, `verify:data` y el doctor.
//
// `history.db`: lo que se puede volver a bajar (resultados, equipos, ratings, próximos,
// medidas derivadas). Se reconstruye cada noche y se publica.
// `ledger.db`: lo que no se puede volver a conseguir: lo que el modelo dijo antes de cada
// partido, las apuestas (de papel y tuyas), cada precio observado, las evaluaciones de
// confianza, las sesiones. Publicarlo sería publicar a una persona; perderlo, perder meses.

export const TABLAS_LEDGER: readonly string[] = [
  // Lo que el modelo dijo antes del partido, por deporte.
  'prediction_log',
  'fb_prediction_log',
  'bb_prediction_log',
  'bsb_prediction_log',
  'naf_prediction_log',
  'nhl_prediction_log',
  'ufc_prediction_log',
  // Dinero: el banco de papel, las señales y tus apuestas.
  'paper_bets',
  'edge_signals',
  'bets',
  // Cada precio que se vio, y el último estado de cada cuota (apunta a odds_snapshots; lote B, B2).
  'odds_snapshots',
  'odds_event_observations',
  'odds_quote_state',
  // Capa de confianza y pre-partido.
  'prediction_snapshots',
  'prematch_final',
  'prediction_assessments',
  'shadow_predictions',
  'alerts',
  // Seguimiento de la persona (Fase 5).
  'watchlist',
  // Laboratorio de estrategias (Fase 6).
  'strategies',
  'strategy_bets',
  // Bandeja e informes archivados (Fase 6).
  'inbox',
  'reports',
  // Operación.
  'sessions',
  'error_log',
  'ingestion_runs',
  'settings',
  // Reservadas: las crean fases posteriores (2C y 3). Están aquí para que, cuando nazcan,
  // nazcan en el fichero correcto sin tocar esta lista otra vez.
  'weather_observations',
  'policy_versions',
  // Fase 3: operación.
  'scheduler_jobs',
  'notification_log',
  'push_subscriptions',
];

/** Las que todavía no crea ninguna migración; `verify:data` no exige que existan. */
export const TABLAS_LEDGER_RESERVADAS: readonly string[] = [];

const LEDGER = new Set(TABLAS_LEDGER);

export function esLedger(tabla: string): boolean {
  return LEDGER.has(tabla);
}

/**
 * Claves de `meta` que son ESTADO del libro mayor, no procedencia de datos. Van a
 * `ledger.settings` para que sobrevivan a una base de historia nueva (`fetch-data`) y no
 * viajen a la base publicada.
 */
export const CLAVES_LEDGER: readonly string[] = ['paper:startedAt', 'paper:lastRun', 'prematch_cycle_at'];
const PREFIJOS_LEDGER = ['backup:', 'retention:', 'policy:', 'scheduler:', 'telegram:'];

export function claveEsLedger(clave: string): boolean {
  return CLAVES_LEDGER.includes(clave) || PREFIJOS_LEDGER.some((p) => clave.startsWith(p));
}

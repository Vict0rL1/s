// Registrar y leer las mediciones de latencia.
//
// ===========================================================================
// PERCENTILES, NO MEDIAS
// ===========================================================================
// La media de una latencia miente casi siempre. Un ciclo que va bien 95 veces y se
// atasca 5 tiene una media estupenda y una experiencia mala, porque lo que se nota es
// justo el atasco. Aquí se publican p50 y p95: el p50 dice cómo va normalmente y el p95
// dice cómo va cuando va mal, que es la pregunta de verdad.
//
// El p95 es además el que se compara con el objetivo. Cumplir «de media» un objetivo de
// latencia no significa nada: la mitad de las veces lo incumples.

import { getDb } from '../db.ts';
import { STAGES, type Stage } from './budget.ts';

export interface Sample {
  stage: Stage;
  ms: number;
  sport?: string;
  fixtureId?: string;
  /** Minutos que faltaban para el inicio. Para cortar por urgencia. */
  minutesToStart?: number | null;
}

export function recordLatency(s: Sample, observedAt = new Date().toISOString()): void {
  getDb()
    .prepare(
      `INSERT INTO latency_samples (stage, ms, sport, fixture_id, minutes_to_start, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(s.stage, s.ms, s.sport ?? null, s.fixtureId ?? null, s.minutesToStart ?? null, observedAt);
}

/** Varias etapas de una misma observación, en una transacción. */
export function recordMany(samples: Sample[], observedAt = new Date().toISOString()): void {
  if (samples.length === 0) return;
  const db = getDb();
  db.exec('BEGIN');
  try {
    for (const s of samples) recordLatency(s, observedAt);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface StageStats {
  stage: Stage;
  n: number;
  p50: number;
  p95: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/**
 * Estadísticas por etapa sobre una ventana reciente.
 *
 * @param hours  cuánto hacia atrás. 24 por defecto: más allá, un cambio de plan o de
 *               cadencia mezcla dos regímenes distintos en el mismo percentil.
 */
export function stageStats(hours = 24, sport?: string): StageStats[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const db = getDb();
  return STAGES.map((stage) => {
    const rows = db
      .prepare(
        `SELECT ms FROM latency_samples
         WHERE stage = ? AND observed_at >= ?${sport ? ' AND sport = ?' : ''}
         ORDER BY ms`,
      )
      .all(...(sport ? [stage, since, sport] : [stage, since])) as unknown as { ms: number }[];
    const xs = rows.map((r) => r.ms);
    return {
      stage,
      n: xs.length,
      p50: percentile(xs, 0.5),
      p95: percentile(xs, 0.95),
      max: xs.length ? xs[xs.length - 1] : 0,
    };
  });
}

/**
 * El total de punta a punta, sumando el p95 de cada etapa.
 *
 * Sumar percentiles NO da el percentil de la suma —eso solo sería cierto si las etapas
 * se atascaran siempre a la vez— y el resultado es PESIMISTA: supone el peor caso de
 * las cuatro simultáneamente. Se usa igualmente, y se dice, porque para un objetivo de
 * latencia equivocarse por el lado pesimista es el lado correcto.
 */
export function totalP95(hours = 24): { ms: number; complete: boolean; missing: Stage[] } {
  const stats = stageStats(hours);
  const missing = stats.filter((s) => s.n === 0).map((s) => s.stage);
  return {
    ms: stats.reduce((a, s) => a + s.p95, 0),
    complete: missing.length === 0,
    missing,
  };
}

/** Borra lo viejo. Sin esto la tabla crece sin techo y los percentiles se apolillan. */
export function pruneLatency(keepDays = 30): number {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const db = getDb();
  const before = (db.prepare('SELECT COUNT(*) n FROM latency_samples').get() as unknown as { n: number }).n;
  db.prepare('DELETE FROM latency_samples WHERE observed_at < ?').run(cutoff);
  const after = (db.prepare('SELECT COUNT(*) n FROM latency_samples').get() as unknown as { n: number }).n;
  return before - after;
}

// ===========================================================================
// FRESCURA EN ORIGEN
// ===========================================================================

export interface Freshness {
  fixtureId: string;
  sport: string;
  /** Lo que dijo la casa. */
  sourceUpdatedAt: string;
  /** Cuándo lo leímos nosotros. */
  fetchedAt: string;
  books: number | null;
}

/**
 * Guardar cuándo dijo la casa que publicó, y cuándo lo leímos.
 *
 * La clave primaria es (partido, marca de origen), así que releer el mismo precio no
 * crea una fila nueva — y eso es lo que hace que la tabla mida CAMBIOS y no sondeos.
 * Devuelve la latencia de origen en ms cuando la fila es nueva, y null cuando ya
 * estaba: un precio que no ha cambiado no tiene latencia que medir.
 */
export function recordFreshness(f: Freshness): number | null {
  const db = getDb();
  const existing = db
    .prepare('SELECT 1 FROM odds_freshness WHERE fixture_id = ? AND source_updated_at = ?')
    .get(f.fixtureId, f.sourceUpdatedAt);
  if (existing) return null;
  db.prepare(
    `INSERT INTO odds_freshness (fixture_id, sport, source_updated_at, fetched_at, books)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(f.fixtureId, f.sport, f.sourceUpdatedAt, f.fetchedAt, f.books ?? null);
  const ms = Date.parse(f.fetchedAt) - Date.parse(f.sourceUpdatedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

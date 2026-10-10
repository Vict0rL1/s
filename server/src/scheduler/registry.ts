// El registro de trabajos programados (Fase 3.7): UNA lista, con cadencia, última ejecución,
// duración, estado y un interruptor por trabajo, en vez de temporizadores sueltos en index.ts.
//
// Cada tic comprueba el interruptor en la base (se puede apagar un trabajo desde la API sin
// reiniciar), mide la duración, la guarda y la pasa a las métricas. Un trabajo que falla no
// tumba a los demás ni al servidor: su error queda en la fila y en el log. Un trabajo nunca se
// solapa consigo mismo.

import { getDb } from '../db.ts';
import { fijar, incrementar } from '../observability/metrics.ts';

export interface DefinicionTrabajo {
  nombre: string;
  descripcion: string;
  /** Cada cuántos minutos. 0 = nunca por sí solo (solo a mano). */
  cadenciaMin: number;
  /** Minutos tras arrancar para la primera pasada (0 = en el arranque). */
  primeraEnMin: number;
  fn: (log: (m: string) => void) => Promise<unknown> | unknown;
  /** Solo se registra si se cumple (p. ej. hay clave de cuotas). */
  cuando?: () => boolean;
}

export interface EstadoTrabajo {
  nombre: string;
  descripcion: string;
  /** La cadencia vigente: la de Ajustes si la hay, si no la del código. */
  cadenciaMin: number;
  cadenciaPorDefecto: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStatus: 'ok' | 'error' | 'running' | null;
  lastError: string | null;
  nextRunAt: string | null;
  runsOk: number;
  runsError: number;
}

const trabajos = new Map<string, DefinicionTrabajo>();
const temporizadores = new Map<string, ReturnType<typeof setTimeout>>();
const enMarcha = new Set<string>();
let arrancado = false;
let registroLog: (m: string) => void = () => {};
let reloj: () => Date = () => new Date();

/** Para los tests: olvidar todo. */
export function reiniciarRegistro(opts: { ahora?: () => Date } = {}): void {
  for (const t of temporizadores.values()) clearTimeout(t);
  temporizadores.clear();
  trabajos.clear();
  enMarcha.clear();
  arrancado = false;
  reloj = opts.ahora ?? (() => new Date());
}

function fila(nombre: string) {
  return getDb().prepare('SELECT * FROM scheduler_jobs WHERE name = ?').get(nombre) as
    | { name: string; cadence_minutes: number; enabled: number; last_run_at: string | null; last_duration_ms: number | null; last_status: string | null; last_error: string | null; next_run_at: string | null; runs_ok: number; runs_error: number }
    | undefined;
}

export function registrar(def: DefinicionTrabajo): void {
  if (def.cuando && !def.cuando()) return;
  trabajos.set(def.nombre, def);
  const db = getDb();
  const ahora = reloj().toISOString();
  // La cadencia la manda el código (puede venir de una variable de entorno); el interruptor,
  // la base, para que apagar un trabajo desde la API sobreviva a un reinicio.
  db.prepare(
    `INSERT INTO scheduler_jobs (name, cadence_minutes, enabled, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET cadence_minutes = excluded.cadence_minutes, updated_at = excluded.updated_at`,
  ).run(def.nombre, def.cadenciaMin, ahora);
}

export function habilitado(nombre: string): boolean {
  return (fila(nombre)?.enabled ?? 1) === 1;
}

export function habilitar(nombre: string, enabled: boolean): EstadoTrabajo | null {
  return configurar(nombre, { enabled });
}

/** La cadencia vigente de un trabajo: la anulación de Ajustes si la hay, si no la del código. */
export function cadenciaDe(nombre: string): number {
  const f = fila(nombre) as (ReturnType<typeof fila> & { cadence_override?: number | null }) | undefined;
  const def = trabajos.get(nombre);
  return f?.cadence_override ?? def?.cadenciaMin ?? f?.cadence_minutes ?? 0;
}

/**
 * Interruptor y cadencia desde la API (Fase 5.7). La cadencia del código no se toca: la
 * anulación va en su propia columna y se puede quitar (null). Reprograma el temporizador.
 */
export function configurar(nombre: string, cambios: { enabled?: boolean; cadenciaMin?: number | null }): EstadoTrabajo | null {
  if (!trabajos.has(nombre) && !fila(nombre)) return null;
  const db = getDb();
  const ahora = reloj().toISOString();
  if (cambios.enabled !== undefined) db.prepare('UPDATE scheduler_jobs SET enabled = ?, updated_at = ? WHERE name = ?').run(cambios.enabled ? 1 : 0, ahora, nombre);
  if (cambios.cadenciaMin !== undefined) {
    if (cambios.cadenciaMin != null && !(cambios.cadenciaMin >= 1 && cambios.cadenciaMin <= 7 * 24 * 60)) throw new Error('cadenciaMin: entre 1 minuto y 7 días, o null para la del código');
    db.prepare('UPDATE scheduler_jobs SET cadence_override = ?, updated_at = ? WHERE name = ?').run(cambios.cadenciaMin, ahora, nombre);
    if (arrancado && trabajos.has(nombre)) {
      const t = temporizadores.get(nombre);
      if (t) clearTimeout(t);
      temporizadores.delete(nombre);
      const min = cadenciaDe(nombre);
      if (min > 0) programarTic(nombre, min * 60_000);
      db.prepare('UPDATE scheduler_jobs SET next_run_at = ?, updated_at = ? WHERE name = ?').run(min > 0 ? new Date(reloj().getTime() + min * 60_000).toISOString() : null, ahora, nombre);
    }
  }
  return estado().find((e) => e.nombre === nombre) ?? null;
}

/** Ejecuta un trabajo ahora (desde el tic o a mano), midiendo y anotando. Nunca lanza. */
export async function ejecutar(nombre: string): Promise<{ ok: boolean; ms: number; error: string | null; saltado: boolean }> {
  const def = trabajos.get(nombre);
  if (!def) return { ok: false, ms: 0, error: `trabajo desconocido: ${nombre}`, saltado: true };
  if (enMarcha.has(nombre)) return { ok: false, ms: 0, error: 'el anterior sigue en marcha', saltado: true };
  enMarcha.add(nombre);
  const db = getDb();
  const inicio = reloj();
  db.prepare("UPDATE scheduler_jobs SET last_status = 'running', last_run_at = ?, updated_at = ? WHERE name = ?").run(inicio.toISOString(), inicio.toISOString(), nombre);
  let error: string | null = null;
  try {
    await def.fn(registroLog);
  } catch (e) {
    error = (e as Error).message ?? String(e);
  } finally {
    enMarcha.delete(nombre);
  }
  const ms = Math.max(0, reloj().getTime() - inicio.getTime());
  const cadencia = cadenciaDe(nombre);
  const siguiente = cadencia > 0 ? new Date(reloj().getTime() + cadencia * 60_000).toISOString() : null;
  db.prepare(
    `UPDATE scheduler_jobs SET last_status = ?, last_duration_ms = ?, last_error = ?, next_run_at = ?, runs_ok = runs_ok + ?, runs_error = runs_error + ?, updated_at = ? WHERE name = ?`,
  ).run(error ? 'error' : 'ok', ms, error, siguiente, error ? 0 : 1, error ? 1 : 0, reloj().toISOString(), nombre);
  incrementar('trabajo_ejecuciones_total', { trabajo: nombre, estado: error ? 'error' : 'ok' }, 'ejecuciones de trabajos programados');
  fijar('trabajo_duracion_segundos', ms / 1000, { trabajo: nombre }, 'duración de la última ejecución de cada trabajo');
  if (error) registroLog(`Trabajo ${nombre}: falló — ${error}`);
  return { ok: !error, ms, error, saltado: false };
}

function programarTic(nombre: string, enMs: number): void {
  const def = trabajos.get(nombre);
  if (!def) return;
  // Nunca dos temporizadores para el mismo trabajo (lote B, B5).
  const previo = temporizadores.get(nombre);
  if (previo) clearTimeout(previo);
  const t = setTimeout(async () => {
    temporizadores.delete(nombre);
    if (habilitado(nombre)) await ejecutar(nombre);
    else registroLog(`Trabajo ${nombre}: apagado, no se ejecuta.`);
    // Si mientras corría Ajustes cambió la cadencia, `configurar` ya programó el siguiente tic:
    // este no programa otro. Antes quedaban dos vivos, uno sin registrar.
    if (temporizadores.has(nombre)) return;
    const cadencia = cadenciaDe(nombre);
    if (cadencia > 0 && arrancado) programarTic(nombre, cadencia * 60_000);
  }, enMs);
  t.unref?.();
  temporizadores.set(nombre, t);
}

/** Arranca los temporizadores de todos los trabajos registrados. */
export function arrancar(log: (m: string) => void = () => {}): void {
  registroLog = log;
  arrancado = true;
  for (const def of trabajos.values()) {
    const ms = cadenciaDe(def.nombre) > 0 || def.primeraEnMin > 0 ? def.primeraEnMin * 60_000 : -1;
    if (ms >= 0) programarTic(def.nombre, ms);
    getDb().prepare('UPDATE scheduler_jobs SET next_run_at = ?, updated_at = ? WHERE name = ?').run(ms >= 0 ? new Date(reloj().getTime() + ms).toISOString() : null, reloj().toISOString(), def.nombre);
  }
  log(`Trabajos programados: ${[...trabajos.values()].map((d) => `${d.nombre} (${d.cadenciaMin > 0 ? `cada ${d.cadenciaMin} min` : 'a mano'})`).join(', ') || 'ninguno'}.`);
}

export function parar(): void {
  arrancado = false;
  for (const t of temporizadores.values()) clearTimeout(t);
  temporizadores.clear();
}

/** ¿Está el registro en marcha? Lo pregunta /ready. */
export function registroArrancado(): boolean {
  return arrancado;
}

export function estado(): EstadoTrabajo[] {
  const defs = [...trabajos.values()];
  const filas = getDb().prepare('SELECT * FROM scheduler_jobs ORDER BY name').all() as unknown as NonNullable<ReturnType<typeof fila>>[];
  return filas
    .filter((f) => trabajos.has(f.name))
    .map((f) => {
      const d = defs.find((x) => x.nombre === f.name)!;
      return {
        nombre: f.name,
        descripcion: d.descripcion,
        cadenciaMin: (f as { cadence_override?: number | null }).cadence_override ?? f.cadence_minutes,
        cadenciaPorDefecto: f.cadence_minutes,
        enabled: f.enabled === 1,
        lastRunAt: f.last_run_at,
        lastDurationMs: f.last_duration_ms,
        lastStatus: (f.last_status as EstadoTrabajo['lastStatus']) ?? null,
        lastError: f.last_error,
        nextRunAt: f.next_run_at,
        runsOk: f.runs_ok,
        runsError: f.runs_error,
      };
    });
}

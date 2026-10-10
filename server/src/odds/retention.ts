// Retención de snapshots de cuotas: adelgazar lo viejo sin perder lo que importa.
//
// ===========================================================================
// LA REGLA Y LA TENSIÓN
// ===========================================================================
// `odds_snapshots` es append-only y tiene un trigger que impide borrar. La regla del
// proyecto es no borrar filas de las tablas inmutables. Pero cada refresco de cuotas de los
// cinco deportes añade miles de filas, y a los meses el fichero crece sin que la mayoría de
// esas filas (el mismo precio reobservado cada hora) aporte nada que apertura, T-24h, T-6h,
// T-1h y cierre no digan.
//
// La resolución, deliberada:
//   · NUNCA automático. Ni el servidor ni ningún ciclo llaman a esto. Solo
//     `npm run odds:retention -- --dias N --confirmar`, a mano.
//   · Sin `--confirmar` solo se enseña el plan.
//   · Antes de borrar, cada fila que va a quitarse se EXPORTA a un fichero
//     `data/archive/odds_snapshots-<fecha>.jsonl.gz`. No se pierde información: se mueve.
//   · Se conservan, por evento + mercado + selección + casa: la primera observación
//     (apertura), la última anterior a T-24h, a T-6h y a T-1h, y la última antes del inicio
//     (cierre). Y TODO lo que tenga menos de N días.
//   · El trigger se quita y se vuelve a crear dentro de la misma transacción.
// Los tests comprueban que los puntos conservados sobreviven y que el archivo contiene
// exactamente lo borrado.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from '../config.ts';
import { getDb, setMeta } from '../db.ts';
import { LEDGER_SCHEMA } from '../db/layout.ts';
import { ledgerize } from '../db/ledgerize.ts';

export const MARCAS_HORAS = [24, 6, 1];

export interface PlanRetencion {
  diasVivos: number;
  limite: string;
  /** Filas anteriores al límite, en total. */
  antiguas: number;
  conservar: number[];
  borrar: number[];
}

interface Fila {
  id: number;
  event_id: string;
  market: string;
  selection: string;
  bookmaker: string;
  commence_time: string | null;
  observed_at: string;
}

/** Decide qué ids se quedan entre las filas anteriores al límite. Pura, para poder probarla. */
export function decidir(filas: Fila[]): { conservar: number[]; borrar: number[] } {
  const grupos = new Map<string, Fila[]>();
  for (const f of filas) {
    const k = `${f.event_id}|${f.market}|${f.selection}|${f.bookmaker}`;
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(f);
  }
  const conservar = new Set<number>();
  for (const g of grupos.values()) {
    g.sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id - b.id);
    conservar.add(g[0].id); // apertura
    // El ancla es la ÚLTIMA hora de inicio conocida (lote B, B5): un partido aplazado trae la
    // nueva en sus últimas observaciones, y T-24h, T-6h, T-1h y el cierre son respecto a ella.
    const conHora = [...g].reverse().find((f) => f.commence_time);
    const inicio = conHora?.commence_time ? Date.parse(conHora.commence_time) : null;
    if (inicio != null) {
      for (const h of MARCAS_HORAS) {
        const marca = inicio - h * 3_600_000;
        const ultimaAntes = [...g].reverse().find((f) => Date.parse(f.observed_at) <= marca);
        if (ultimaAntes) conservar.add(ultimaAntes.id);
      }
      const cierre = [...g].reverse().find((f) => Date.parse(f.observed_at) <= inicio);
      if (cierre) conservar.add(cierre.id);
    }
    conservar.add(g[g.length - 1].id); // la última observación, siempre
  }
  const borrar = filas.filter((f) => !conservar.has(f.id)).map((f) => f.id);
  return { conservar: [...conservar].sort((a, b) => a - b), borrar };
}

export function planificar(diasVivos: number, ahora = new Date()): PlanRetencion {
  if (!(diasVivos >= 7)) throw new Error('La retención exige al menos 7 días vivos.');
  const limite = new Date(ahora.getTime() - diasVivos * 86_400_000).toISOString();
  const filas = getDb()
    .prepare('SELECT id, event_id, market, selection, bookmaker, commence_time, observed_at FROM odds_snapshots WHERE observed_at < ? ORDER BY id')
    .all(limite) as unknown as Fila[];
  const { conservar, borrar } = decidir(filas);
  return { diasVivos, limite, antiguas: filas.length, conservar, borrar };
}

export function directorioArchivo(): string {
  return path.join(DATA_DIR, 'archive');
}

/** Exporta las filas a borrar (completas) y las borra, con el trigger quitado solo durante la transacción. */
export function aplicar(plan: PlanRetencion, opts: { confirmar: boolean; ahora?: Date }): { borradas: number; archivo: string | null } {
  if (!opts.confirmar) return { borradas: 0, archivo: null };
  if (plan.borrar.length === 0) return { borradas: 0, archivo: null };
  const db = getDb();
  const ahora = opts.ahora ?? new Date();
  const dir = directorioArchivo();
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `odds_snapshots-${ahora.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl.gz`);
  // Primero el archivo, y comprobado, y solo después el borrado.
  const sel = db.prepare('SELECT * FROM odds_snapshots WHERE id = ?');
  const lineas: string[] = [];
  for (const id of plan.borrar) {
    const fila = sel.get(id);
    if (fila) lineas.push(JSON.stringify(fila));
  }
  fs.writeFileSync(archivo, zlib.gzipSync(Buffer.from(lineas.join('\n') + '\n')));
  const releido = zlib.gunzipSync(fs.readFileSync(archivo)).toString('utf8').trim().split('\n').filter(Boolean).length;
  if (releido !== lineas.length) {
    fs.rmSync(archivo, { force: true });
    throw new Error(`El archivo no se releyó entero (${releido} de ${lineas.length}); no se borra nada.`);
  }
  const trigger = (db.prepare(`SELECT sql FROM ${LEDGER_SCHEMA === 'main' ? '' : `${LEDGER_SCHEMA}.`}sqlite_master WHERE type = 'trigger' AND name = 'odds_snapshots_no_delete'`).get() as { sql: string } | undefined)?.sql;
  db.exec('BEGIN');
  try {
    if (trigger) db.exec('DROP TRIGGER odds_snapshots_no_delete');
    const del = db.prepare('DELETE FROM odds_snapshots WHERE id = ?');
    let borradas = 0;
    for (const id of plan.borrar) borradas += Number(del.run(id).changes);
    if (trigger) db.exec(ledgerize(trigger.replace(/^CREATE TRIGGER\s+(?:\w+\.)?/i, 'CREATE TRIGGER IF NOT EXISTS '), LEDGER_SCHEMA));
    db.exec('COMMIT');
    setMeta('retention:last_at', ahora.toISOString());
    setMeta('retention:last_removed', String(borradas));
    return { borradas, archivo };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

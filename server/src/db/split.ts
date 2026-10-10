// La migración única de `tennis.db` (todo junto) a `history.db` + `ledger.db`.
//
// SIN PERDER NADA, POR CONSTRUCCIÓN
// No hay ningún `INSERT … SELECT`: se hacen DOS copias completas del fichero con
// `VACUUM INTO` (una copia física y consistente) y en cada una se quitan con `DROP TABLE` las
// tablas que no le corresponden. Un `DROP` arrastra sus índices y triggers. Ninguna fila se
// transforma, ningún trigger de validación vuelve a evaluar filas viejas, y el original se
// queda al lado con otro nombre hasta que quien quiera lo borre.
//
// Las claves de ESTADO de `meta` (banco de papel, latido del ciclo) se copian a
// `ledger.settings`, que es donde las lee la app desde la Fase 2 (ver tables.ts).

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { TABLAS_LEDGER, claveEsLedger } from './tables.ts';

export interface ResultadoSplit {
  history: string;
  ledger: string;
  original: string;
  tablasHistory: string[];
  tablasLedger: string[];
  settingsCopiadas: number;
}

function tablasDe(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
}

/** Copia física del fichero abierto, consistente aunque haya WAL. */
function copiar(origen: string, destino: string): void {
  const db = new DatabaseSync(origen);
  try {
    fs.rmSync(destino, { force: true });
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function quitar(fichero: string, condicion: (tabla: string) => boolean): string[] {
  const db = new DatabaseSync(fichero);
  try {
    const todas = tablasDe(db);
    const fuera = todas.filter(condicion);
    db.exec('BEGIN');
    for (const t of fuera) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    db.exec('COMMIT');
    db.exec('VACUUM');
    return todas.filter((t) => !fuera.includes(t));
  } finally {
    db.close();
  }
}

/** Las claves de estado de `meta` del original → `settings` del libro mayor. */
function copiarSettings(original: string, ledger: string): number {
  const db = new DatabaseSync(ledger);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`ATTACH '${original.replace(/'/g, "''")}' AS old`);
    const filas = db.prepare("SELECT key, value FROM old.meta").all() as { key: string; value: string }[];
    const ins = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    let n = 0;
    const t = new Date().toISOString();
    for (const f of filas) {
      if (claveEsLedger(f.key)) {
        ins.run(f.key, f.value, t);
        n++;
      }
    }
    db.exec('DETACH old');
    return n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Parte `original` en `history` y `ledger`. No toca `original` salvo para renombrarlo al final
 * (`<original>.pre-split-<fecha>`), y solo si todo lo anterior salió bien.
 */
export function partirBase(original: string, history: string, ledger: string, ahora = new Date()): ResultadoSplit {
  if (!fs.existsSync(original)) throw new Error(`No existe ${original}`);
  const tmpH = `${history}.partiendo`;
  const tmpL = `${ledger}.partiendo`;
  try {
    copiar(original, tmpH);
    copiar(original, tmpL);
    const tablasHistory = quitar(tmpH, (t) => TABLAS_LEDGER.includes(t));
    const tablasLedger = quitar(tmpL, (t) => !TABLAS_LEDGER.includes(t));
    const settingsCopiadas = copiarSettings(original, tmpL);
    // Las dos copias están completas: ahora sí, en su sitio y el original apartado.
    fs.renameSync(tmpH, history);
    fs.renameSync(tmpL, ledger);
    const sello = ahora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const apartado = `${original}.pre-split-${sello}`;
    fs.renameSync(original, apartado);
    for (const suf of ['-wal', '-shm', '-journal']) fs.rmSync(original + suf, { force: true });
    // La marca de que aquí hay libro mayor (lote B, B4): si un día falta, el servidor lo dirá.
    fs.writeFileSync(`${ledger}.existe`, `libro mayor creado al partir ${original} el ${ahora.toISOString()}\n`);
    return { history, ledger, original: apartado, tablasHistory, tablasLedger, settingsCopiadas };
  } catch (e) {
    fs.rmSync(tmpH, { force: true });
    fs.rmSync(tmpL, { force: true });
    throw e;
  }
}

/** ¿Hace falta partir? Hay original y no hay ninguno de los dos nuevos. */
export function hayQuePartir(original: string, history: string, ledger: string): boolean {
  return fs.existsSync(original) && !fs.existsSync(history) && !fs.existsSync(ledger);
}

// Tocar un fichero SQLite desde FUERA de la app sin romperlo (lote B, B1).
//
// Dos cosas que `fs.copyFileSync` y `fs.renameSync` no saben:
//   · Con WAL, parte de la base vive en `<fichero>-wal` hasta el siguiente checkpoint. Copiar
//     solo el fichero principal es copiar una base incompleta. `VACUUM INTO` produce un fichero
//     nuevo y consistente con todo dentro.
//   · Reemplazar un fichero que otro proceso tiene abierto corrompe: la conexión vieja sigue
//     escribiendo en el inodo viejo y el siguiente checkpoint aplica un WAL ajeno al nuevo.
//     Antes de tocar nada se comprueba que nadie lo tiene abierto.
//
// La sonda: una conexión con `locking_mode=EXCLUSIVE` y `busy_timeout=0` no consigue empezar
// una transacción mientras cualquier otra conexión (de este proceso o de otro) tenga el fichero
// abierto, aunque esté ociosa; medido en db/seguridadDatos.test.ts.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** ¿Hay otra conexión con el fichero abierto? Un fichero que no existe, o que no es una base, no. */
export function otraConexionAbierta(fichero: string): boolean {
  if (!fs.existsSync(fichero)) return false;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(fichero);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;');
    db.exec('BEGIN IMMEDIATE; COMMIT;');
    return false;
  } catch (e) {
    return /locked|busy/i.test((e as Error).message);
  } finally {
    try {
      db?.close();
    } catch {
      // Ya cerrada.
    }
  }
}

/** `PRAGMA integrity_check` de un fichero: 'ok' o el primer problema. */
export function integridadDe(fichero: string): string {
  const db = new DatabaseSync(fichero, { readOnly: true });
  try {
    return (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  } finally {
    db.close();
  }
}

/**
 * Copia consistente de una base (con lo que haya en su WAL) a `destino`, comprobada.
 * Devuelve el resultado del `integrity_check` del destino.
 */
export function copiaConsistente(origen: string, destino: string): string {
  fs.rmSync(destino, { force: true });
  const db = new DatabaseSync(origen);
  try {
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return integridadDe(destino);
}

/** Los ficheros laterales de una base: no pueden quedarse junto a un fichero que no es el suyo. */
export function quitarLaterales(fichero: string): void {
  for (const suf of ['-wal', '-shm', '-journal']) fs.rmSync(fichero + suf, { force: true });
}

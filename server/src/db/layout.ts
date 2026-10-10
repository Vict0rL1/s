// Dónde está cada fichero de la base, y en qué disposición.
//
//   DB_LAYOUT=split  (por defecto)  history.db (principal) + ledger.db (adjunta como `ledger`)
//   DB_LAYOUT=single               todo en tennis.db, como hasta la Fase 2 (compatibilidad)
//
// La principal es la de HISTORIA a propósito: las decenas de `CREATE TABLE` sin prefijo del
// esquema caen en ella, y solo las tablas del libro mayor (pocas, listadas en tables.ts)
// llevan el prefijo, que pone `ledgerize.ts` sin tocar los esquemas.

import path from 'node:path';
import { DATA_DIR, DB_PATH } from '../config.ts';

export type Layout = 'split' | 'single';

export function layoutDesdeEntorno(entorno: NodeJS.ProcessEnv = process.env): Layout {
  return entorno.DB_LAYOUT?.trim().toLowerCase() === 'single' ? 'single' : 'split';
}

export const LAYOUT: Layout = layoutDesdeEntorno();

/** El fichero antiguo, con todo dentro. */
export const LEGACY_DB_PATH = DB_PATH;
export const HISTORY_DB_PATH = path.join(DATA_DIR, 'history.db');
export const LEDGER_DB_PATH = path.join(DATA_DIR, 'ledger.db');
/**
 * La marca de que aquí HUBO un libro mayor (lote B, B4). La escribe la app al crearlo y la
 * partición al partir. Si está y `ledger.db` no, el servidor no arranca con uno vacío: alguien
 * perdió o movió las apuestas y el registro, y eso se dice en vez de taparlo.
 */
export const LEDGER_MARCA_PATH = `${LEDGER_DB_PATH}.existe`;

/** Nombre del esquema SQLite del libro mayor: `ledger` en split, `main` en single. */
export const LEDGER_SCHEMA = LAYOUT === 'split' ? 'ledger' : 'main';

/** El fichero que abre la conexión principal según la disposición. */
export function rutaPrincipal(layout: Layout = LAYOUT): string {
  return layout === 'split' ? HISTORY_DB_PATH : LEGACY_DB_PATH;
}

/** Los ficheros que componen la base en una disposición (para el doctor y los backups). */
export function ficherosDe(layout: Layout = LAYOUT): { history: string; ledger: string | null } {
  return layout === 'split' ? { history: HISTORY_DB_PATH, ledger: LEDGER_DB_PATH } : { history: LEGACY_DB_PATH, ledger: null };
}

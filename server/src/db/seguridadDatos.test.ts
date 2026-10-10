// Lote B (revisión del 8 de octubre de 2026): lo que podía perder datos.
//
//   B4  Sin ledger.db y con la marca de que existió, el servidor NO arranca con uno vacío.
//   B1  Otra conexión abierta se detecta; la restauración es real con WAL; el apagado cierra.
//   B5  El libro mayor abre con synchronous=FULL.
//   B2  odds_quote_state vive en el libro mayor, y la migración mueve lo que hubiera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import '../test/setup.ts';

const { abrirBase, getDb, cerrarDb, MIGRACIONES } = await import('../db.ts');
const { LEDGER_DB_PATH, LEDGER_MARCA_PATH } = await import('./layout.ts');
const { otraConexionAbierta } = await import('./sqliteSeguro.ts');
const { hacerCopia, restaurarCopia } = await import('./backup.ts');
const { partirBase } = await import('./split.ts');
const { TABLAS_LEDGER } = await import('./tables.ts');
const { apagar } = await import('../apagado.ts');

const existe = (f: string) => fs.existsSync(f);
const sinSufijos = (f: string) => {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true });
};

// ---------------------------------------------------------------------------
// B4 (antes de que nadie abra la base de los tests)
// ---------------------------------------------------------------------------
test('B4: la primera apertura crea el libro mayor y deja la marca; si después falta, no se arranca uno vacío', () => {
  assert.equal(existe(LEDGER_DB_PATH), false, 'la base de los tests aún no se ha abierto');
  const d = abrirBase();
  d.close();
  assert.equal(existe(LEDGER_DB_PATH), true);
  assert.equal(existe(LEDGER_MARCA_PATH), true, 'la marca dice que aquí hubo un libro mayor');
  sinSufijos(LEDGER_DB_PATH);
  assert.throws(() => abrirBase(), /npm run restore/, 'sin ledger.db y con la marca: se niega y dice cómo restaurar');
  assert.equal(existe(LEDGER_DB_PATH), false, 'y no deja un libro mayor vacío al pasar');
  // A sabiendas (LEDGER_NUEVO=si) sí: una instalación que de verdad empieza de cero.
  process.env.LEDGER_NUEVO = 'si';
  try {
    const d2 = abrirBase();
    d2.close();
  } finally {
    delete process.env.LEDGER_NUEVO;
  }
  assert.equal(existe(LEDGER_DB_PATH), true);
});

test('B4: partir la base antigua también deja la marca', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-marca-'));
  const original = path.join(dir, 'tennis.db');
  const o = new DatabaseSync(original);
  o.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE matches (id INTEGER PRIMARY KEY); CREATE TABLE paper_bets (id INTEGER PRIMARY KEY); INSERT INTO matches VALUES (1);");
  o.close();
  const ledger = path.join(dir, 'ledger.db');
  partirBase(original, path.join(dir, 'history.db'), ledger, new Date('2026-10-08T00:00:00Z'));
  assert.equal(existe(`${ledger}.existe`), true);
});

// ---------------------------------------------------------------------------
// B1
// ---------------------------------------------------------------------------
test('B1: otraConexionAbierta ve la conexión de la app y deja de verla al cerrarla', () => {
  getDb();
  assert.equal(otraConexionAbierta(LEDGER_DB_PATH), true);
  cerrarDb();
  assert.equal(otraConexionAbierta(LEDGER_DB_PATH), false);
  assert.equal(otraConexionAbierta(path.join(os.tmpdir(), 'no-existe-nunca.db')), false, 'sin fichero no hay nadie');
});

test('B1: restaurar de verdad con WAL: se niega con la base abierta; cerrada, aparta lo actual ENTERO y deja el destino íntegro', async () => {
  const db = getDb();
  db.exec("INSERT INTO alerts (created_at, type, severity, title, body) VALUES ('2026-10-01T00:00:00Z', 'a', 'info', 't', 'b')");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurar-wal-'));
  const copia = await hacerCopia({ dir, ahora: new Date('2026-10-08T05:00:00Z'), subir: false });
  // Después de la copia, más filas: viven en ledger.db-wal hasta el siguiente checkpoint.
  db.exec("INSERT INTO alerts (created_at, type, severity, title, body) VALUES ('2026-10-02T00:00:00Z', 'b', 'info', 't2', 'b2'), ('2026-10-03T00:00:00Z', 'c', 'info', 't3', 'b3')");
  assert.equal(existe(`${LEDGER_DB_PATH}-wal`), true, 'hay WAL');
  assert.throws(() => restaurarCopia(copia.fichero), /abiert|conexión/i, 'con el servidor (esta conexión) usando el fichero, no se restaura');
  cerrarDb();
  const r = restaurarCopia(copia.fichero, { ahora: new Date('2026-10-08T06:00:00Z') });
  assert.equal(r.destino, LEDGER_DB_PATH);
  assert.ok(r.apartado && existe(r.apartado));
  const apartado = new DatabaseSync(r.apartado, { readOnly: true });
  assert.equal((apartado.prepare('SELECT COUNT(*) n FROM alerts').get() as { n: number }).n, 3, 'lo apartado lleva TAMBIÉN las filas que estaban en el WAL');
  assert.equal((apartado.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  apartado.close();
  assert.equal(existe(`${LEDGER_DB_PATH}-wal`), false);
  assert.equal(existe(`${LEDGER_DB_PATH}-shm`), false);
  const restaurada = new DatabaseSync(LEDGER_DB_PATH, { readOnly: true });
  assert.equal((restaurada.prepare('SELECT COUNT(*) n FROM alerts').get() as { n: number }).n, 1, 'el destino es la copia');
  assert.equal((restaurada.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  restaurada.close();
  // Y la app vuelve a abrir sobre lo restaurado.
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM alerts').get() as { n: number }).n, 1);
});

test('B1: el apagado cierra la base (el WAL se vuelca y desaparece) y sale con 0; index.ts lo instala', async () => {
  const db = getDb();
  db.exec("INSERT INTO alerts (created_at, type, severity, title, body) VALUES ('2026-10-04T00:00:00Z', 'd', 'info', 't', 'b')");
  assert.equal(existe(`${LEDGER_DB_PATH}-wal`), true);
  let codigo: number | null = null;
  let cerrados = 0;
  await apagar({ senal: 'SIGTERM', cerrarApp: async () => void cerrados++, salir: (c) => void (codigo = c), log: () => undefined });
  assert.equal(cerrados, 1);
  assert.equal(codigo, 0);
  assert.equal(existe(`${LEDGER_DB_PATH}-wal`), false, 'la conexión se cerró: SQLite volcó y quitó el WAL');
  const fuente = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'index.ts'), 'utf8');
  assert.match(fuente, /instalarApagado\(/);
});

// ---------------------------------------------------------------------------
// B5 · B2
// ---------------------------------------------------------------------------
test('B5: el libro mayor abre con synchronous=FULL y la historia con NORMAL', () => {
  const db = getDb();
  assert.equal((db.prepare('PRAGMA ledger.synchronous').get() as { synchronous: number }).synchronous, 2);
  assert.equal((db.prepare('PRAGMA main.synchronous').get() as { synchronous: number }).synchronous, 1);
});

test('B2: odds_quote_state es del libro mayor, y la migración 20 se lleva lo que hubiera en la historia', () => {
  assert.ok(TABLAS_LEDGER.includes('odds_quote_state'));
  const db = getDb();
  const en = (schema: string) => (db.prepare(`SELECT COUNT(*) n FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'odds_quote_state'`).get() as { n: number }).n;
  assert.equal(en('ledger'), 1);
  assert.equal(en('main'), 0);
  // Una instalación anterior: la tabla en la historia con filas. La migración la mueve.
  db.exec('DROP TABLE ledger.odds_quote_state');
  db.exec("CREATE TABLE main.odds_quote_state (event_id TEXT NOT NULL, market TEXT NOT NULL, selection TEXT NOT NULL, bookmaker TEXT NOT NULL, odds_decimal REAL, line REAL, withdrawn INTEGER NOT NULL DEFAULT 0, snapshot_id INTEGER NOT NULL, PRIMARY KEY (event_id, market, selection, bookmaker))");
  db.exec("INSERT INTO main.odds_quote_state VALUES ('e1', 'h2h', 'Casa', 'bet365', 1.9, NULL, 0, 7)");
  const m = MIGRACIONES.find((x) => x.version === 20)!;
  assert.ok(m, 'hay migración 20');
  assert.equal(m.destino, 'ledger');
  m.up(db, { ledger: 'ledger', fichero: 'ledger' });
  assert.equal(en('ledger'), 1);
  assert.equal(en('main'), 0);
  assert.equal((db.prepare("SELECT snapshot_id FROM ledger.odds_quote_state WHERE event_id = 'e1'").get() as { snapshot_id: number }).snapshot_id, 7);
});

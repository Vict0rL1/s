// A7: una instalación nueva acababa con la base vacía. `setup` corría db:migrate antes de los
// datos, eso dejaba un history.db solo con esquema, fetch-data veía que el fichero existía y no
// descargaba. Ahora una base sin filas cuenta como ausente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { hayHistoria } = (await import(path.join(ROOT, 'scripts', 'datos-estado.mjs'))) as { hayHistoria: (fichero: string) => boolean };

/**
 * El script en un proceso hijo, SIN bloquear: el servidor que le sirve la release vive en este
 * mismo proceso, y con `spawnSync` nunca llegaría a contestarle.
 */
function correFetchData(env: NodeJS.ProcessEnv, args: string[] = []): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((ok, mal) => {
    const h = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fetch-data.mjs'), ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    h.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    h.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    h.on('error', mal);
    h.on('close', (status) => ok({ status, stdout, stderr }));
  });
}

const ESQUEMA = 'CREATE TABLE matches (id INTEGER PRIMARY KEY, winner_id TEXT); CREATE TABLE fb_matches (id INTEGER PRIMARY KEY); CREATE TABLE naf_games (id INTEGER PRIMARY KEY); CREATE TABLE player_ratings (player_id TEXT PRIMARY KEY);';

function baseCon(filas: number, fichero: string): void {
  const db = new DatabaseSync(fichero);
  db.exec(ESQUEMA);
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO matches (winner_id) VALUES (?)');
  for (let i = 0; i < filas; i++) ins.run(`p${i}`);
  db.exec('COMMIT');
  db.close();
}

test('A7: hayHistoria distingue una base solo con esquema de una con filas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datos-estado-'));
  assert.equal(hayHistoria(path.join(dir, 'no-existe.db')), false);
  baseCon(0, path.join(dir, 'vacia.db'));
  assert.equal(hayHistoria(path.join(dir, 'vacia.db')), false);
  baseCon(12, path.join(dir, 'llena.db'));
  assert.equal(hayHistoria(path.join(dir, 'llena.db')), true);
  fs.writeFileSync(path.join(dir, 'rota.db'), 'esto no es sqlite');
  assert.equal(hayHistoria(path.join(dir, 'rota.db')), false);
});

test('A7: fetch-data descarga aunque haya un history.db solo con esquema (y lo aparta)', async () => {
  // La release, servida en local (DATA_BASE_URL): una base con filas de sobra, comprimida y con su checksum.
  const publicada = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  baseCon(10_500, path.join(publicada, 'history.db'));
  const gz = zlib.gzipSync(fs.readFileSync(path.join(publicada, 'history.db')));
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  const servidor = http.createServer((req, res) => {
    if (req.url === '/history.db.gz') return res.writeHead(200, { 'content-type': 'application/gzip' }).end(gz);
    if (req.url === '/history.db.gz.sha256') return res.writeHead(200, { 'content-type': 'text/plain' }).end(`${sha}  history.db.gz\n`);
    res.writeHead(404).end('no');
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const puerto = (servidor.address() as AddressInfo).port;

  // La instalación: un history.db solo con esquema (lo que deja db:migrate antes de bajar datos).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instalacion-'));
  baseCon(0, path.join(dataDir, 'history.db'));
  try {
    const entorno = { ...process.env, DATA_DIR: dataDir, DATA_BASE_URL: `http://127.0.0.1:${puerto}`, NODE_OPTIONS: '--experimental-sqlite --disable-warning=ExperimentalWarning' };
    const r = await correFetchData(entorno);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(hayHistoria(path.join(dataDir, 'history.db')), true, r.stdout);
    const db = new DatabaseSync(path.join(dataDir, 'history.db'));
    assert.equal((db.prepare('SELECT COUNT(*) n FROM matches').get() as { n: number }).n, 10_500);
    db.close();
    const apartada = fs.readdirSync(dataDir).find((f) => f.startsWith('history.db.sin-filas-'));
    assert.ok(apartada, `la base sin filas se aparta con fecha: ${fs.readdirSync(dataDir).join(', ')}`);
    assert.match(r.stdout, /sin filas/i);

    // Una segunda vez, con filas, no toca nada.
    const r2 = await correFetchData(entorno);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /No se toca/);
  } finally {
    await new Promise<void>((ok) => servidor.close(() => ok()));
  }
});

// ---------------------------------------------------------------------------
// B1 · B3: --force con WAL, con el servidor en marcha, y lo tuyo que sobrevive
// ---------------------------------------------------------------------------
const { otraConexionAbierta } = (await import(path.join(ROOT, 'scripts', 'datos-estado.mjs'))) as { otraConexionAbierta: (fichero: string) => boolean };

const ESQUEMA_MIO =
  'CREATE TABLE bets (id INTEGER PRIMARY KEY, stake REAL); CREATE TABLE fb_news (id TEXT PRIMARY KEY, quote TEXT); CREATE TABLE fb_lineups (fixture_id TEXT, team_id TEXT, player_id TEXT, kind TEXT, recorded_at TEXT); ' +
  'CREATE TABLE fb_odds_history (id INTEGER PRIMARY KEY, fixture_id TEXT, observed_at TEXT); CREATE TABLE latency_samples (id INTEGER PRIMARY KEY, stage TEXT, ms REAL); CREATE TABLE player_ids (tour TEXT, name TEXT, id INTEGER, PRIMARY KEY (tour, name));';

async function servidorConRelease(filasPublicadas: number) {
  const publicada = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  baseCon(filasPublicadas, path.join(publicada, 'history.db'));
  const d = new DatabaseSync(path.join(publicada, 'history.db'));
  d.exec(ESQUEMA_MIO);
  d.close();
  const gz = zlib.gzipSync(fs.readFileSync(path.join(publicada, 'history.db')));
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  const servidor = http.createServer((req, res) => {
    if (req.url === '/history.db.gz') return res.writeHead(200, { 'content-type': 'application/gzip' }).end(gz);
    if (req.url === '/history.db.gz.sha256') return res.writeHead(200, { 'content-type': 'text/plain' }).end(`${sha}  history.db.gz\n`);
    res.writeHead(404).end('no');
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  return { puerto: (servidor.address() as AddressInfo).port, cerrar: () => new Promise<void>((ok) => servidor.close(() => ok())) };
}

test('B1: otraConexionAbierta (datos-estado.mjs) ve una conexión abierta y deja de verla al cerrar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-'));
  const f = path.join(dir, 'x.db');
  const db = new DatabaseSync(f);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  assert.equal(otraConexionAbierta(f), true);
  db.close();
  assert.equal(otraConexionAbierta(f), false);
});

test('B1: fetch-data --force se niega con la base abierta; cerrada, la copia de la anterior lleva lo que estaba en el WAL y no queda un -wal viejo', async () => {
  const s = await servidorConRelease(10_500);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instalacion-force-'));
  const history = path.join(dataDir, 'history.db');
  try {
    // La instalación actual: con filas, con lo tuyo, y con páginas en el WAL (como la deja un
    // servidor en marcha): se copia el fichero Y su WAL mientras la conexión sigue abierta.
    const vivo = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-'));
    baseCon(12, path.join(vivo, 'history.db'));
    const v = new DatabaseSync(path.join(vivo, 'history.db'));
    v.exec('PRAGMA journal_mode = WAL;');
    v.exec(ESQUEMA_MIO);
    v.exec("INSERT INTO bets (stake) VALUES (25); INSERT INTO fb_news VALUES ('n1', 'lesión'); INSERT INTO fb_lineups VALUES ('f1', 't1', 'p1', 'confirmada', '2026-10-08T10:00:00Z'); INSERT INTO fb_odds_history (fixture_id, observed_at) VALUES ('f1', '2026-10-08T09:00:00Z'); INSERT INTO latency_samples (stage, ms) VALUES ('servidor', 12); INSERT INTO player_ids VALUES ('atp', 'Nadie', 999);");
    v.exec("INSERT INTO matches (winner_id) VALUES ('en-el-wal')");
    for (const suf of ['', '-wal', '-shm']) if (fs.existsSync(path.join(vivo, 'history.db') + suf)) fs.copyFileSync(path.join(vivo, 'history.db') + suf, history + suf);
    v.close();
    assert.ok(fs.statSync(`${history}-wal`).size > 0, 'la instalación tiene páginas en el WAL');

    const entorno = { ...process.env, DATA_DIR: dataDir, DATA_BASE_URL: `http://127.0.0.1:${s.puerto}`, NODE_OPTIONS: '--experimental-sqlite --disable-warning=ExperimentalWarning' };
    // 1. Con una conexión abierta (el servidor en marcha): no se toca nada.
    const abierta = new DatabaseSync(history);
    abierta.exec('SELECT 1');
    const negado = await correFetchData(entorno, ['--force']);
    abierta.close();
    assert.equal(negado.status, 1, `${negado.stdout}\n${negado.stderr}`);
    assert.match(negado.stdout + negado.stderr, /abiert|en marcha/i);
    assert.equal(fs.readdirSync(dataDir).filter((f) => f.startsWith('history.db.backup-')).length, 0, 'ni copia ni reemplazo');

    // 2. Cerrada: reemplaza, con copia COMPLETA de la anterior y lo tuyo conservado.
    const r = await correFetchData(entorno, ['--force']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(fs.existsSync(`${history}-wal`), false, 'un WAL de otro fichero no puede quedarse al lado del nuevo');
    const backup = fs.readdirSync(dataDir).find((f) => f.startsWith('history.db.backup-'));
    assert.ok(backup, fs.readdirSync(dataDir).join(', '));
    const copia = new DatabaseSync(path.join(dataDir, backup!), { readOnly: true });
    assert.equal((copia.prepare("SELECT COUNT(*) n FROM matches WHERE winner_id = 'en-el-wal'").get() as { n: number }).n, 1, 'la copia de la anterior lleva lo que estaba en el WAL');
    assert.equal((copia.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    copia.close();
    const nueva = new DatabaseSync(history, { readOnly: true });
    assert.equal((nueva.prepare('SELECT COUNT(*) n FROM matches').get() as { n: number }).n, 10_500);
    assert.equal((nueva.prepare('SELECT COUNT(*) n FROM bets').get() as { n: number }).n, 1, 'bets sobrevive (ya lo hacía)');
    for (const t of ['fb_news', 'fb_lineups', 'fb_odds_history', 'latency_samples', 'player_ids']) {
      assert.equal((nueva.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, 1, `${t} sobrevive al --force (B3)`);
    }
    nueva.close();
  } finally {
    await s.cerrar();
  }
});

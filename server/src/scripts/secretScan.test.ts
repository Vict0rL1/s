// D16 (revisión del 8 de octubre): `secret-scan --staged` listaba lo preparado con
// `git diff --cached` pero leía el fichero del DISCO. Lo que se comprobaba no era lo que iba al
// commit: un secreto en el índice y ya borrado del disco (o un `git add -p` parcial) pasaba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ESCANER = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'secret-scan.mjs');
// Armado por trozos: si estuviera entero en este fichero, el propio escáner lo cazaría aquí.
const SECRETO = ['APP_', 'PASSWORD', '=', 'frase-de-prueba-larga'].join('');

function git(dir: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

test('D16: --staged lee lo que va al commit (el índice), no el disco', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'config.txt'), `${SECRETO}\n`);
  git(dir, 'add', 'config.txt');
  // En el disco ya está limpio; en el índice, no.
  fs.writeFileSync(path.join(dir, 'config.txt'), 'APP_USER=victor\n');
  const r = spawnSync(process.execPath, [ESCANER, '--staged', '--json', '--root', dir], { encoding: 'utf8' });
  const salida = JSON.parse(r.stdout) as { hallazgos: { fichero: string; patron: string }[] };
  assert.deepEqual(salida.hallazgos.map((h) => h.fichero), ['config.txt'], 'el secreto del índice se encuentra');
  assert.equal(r.status, 1);
});

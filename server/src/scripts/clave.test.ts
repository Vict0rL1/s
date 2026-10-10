// scripts/clave.mjs (`npm run clave`): la clave de cuotas acaba en UNA línea del .env, limpia,
// sin imprimirse nunca, y la comprobación usa el listado gratuito. Sin red de verdad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
type Comprobacion = { ok: boolean | null; texto: string };
const m = (await import(path.join(ROOT, 'scripts', 'clave.mjs'))) as {
  limpiarClave: (t: string) => string | null;
  escribirClave: (texto: string, clave: string) => string;
  terminalQuePisa: (entorno: Record<string, string | undefined>, clave: string) => { nombre: string; vacia: boolean }[];
  interpretarComprobacion: (status: number, cuerpo: string, restantes: number | null) => Comprobacion;
  comprobar: (clave: string, f: typeof fetch) => Promise<Comprobacion>;
  formaHabitual: (c: string) => boolean;
};

const CLAVE = '0123456789abcdef0123456789abcdef';

test('limpiarClave: acepta la clave sola o la línea entera, con comillas, export, espacios o \\r', () => {
  for (const t of [CLAVE, ` ${CLAVE}\r\n`, `ODDS_API_KEY=${CLAVE}`, `export ODDS_API_KEY="${CLAVE}"`, `THE_ODDS_API_KEY='${CLAVE}'`, `\x1b[200~${CLAVE}\x1b[201~`]) {
    assert.equal(m.limpiarClave(t), CLAVE, JSON.stringify(t));
  }
  for (const t of ['', '   ', 'hola que tal', 'corta', 'ODDS_API_KEY=']) assert.equal(m.limpiarClave(t), null, JSON.stringify(t));
  assert.equal(m.formaHabitual(CLAVE), true);
  assert.equal(m.formaHabitual('no-es-hex-pero-vale-quiza'), false);
});

test('escribirClave: reescribe la primera línea, quita las duplicadas y no toca nada más', () => {
  const antes = ['# comentario', 'ODDS_API_KEY=vieja', 'ODDS_REGIONS=eu', 'export ODDS_API_KEY=otra', '# ODDS_API_KEY=comentada', 'THE_ODDS_API_KEY=alias', ''].join('\n');
  const despues = m.escribirClave(antes, CLAVE);
  assert.equal(despues, ['# comentario', `ODDS_API_KEY=${CLAVE}`, 'ODDS_REGIONS=eu', '# ODDS_API_KEY=comentada', 'THE_ODDS_API_KEY=alias', ''].join('\n'));
  // Sin línea: se añade al final, una vez.
  assert.equal(m.escribirClave('A=1\n\n', CLAVE), `A=1\nODDS_API_KEY=${CLAVE}\n`);
  assert.equal(m.escribirClave('', CLAVE), `ODDS_API_KEY=${CLAVE}\n`);
  // Saltos de Windows: se respetan, y la clave no se queda con un \r pegado.
  assert.equal(m.escribirClave('ODDS_API_KEY=x\r\nB=2\r\n', CLAVE), `ODDS_API_KEY=${CLAVE}\r\nB=2\r\n`);
  // El .env.example de verdad: su línea vacía se rellena y sigue habiendo una sola.
  const ejemplo = m.escribirClave(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), CLAVE);
  assert.equal(ejemplo.split('\n').filter((l) => /^\s*(export\s+)?ODDS_API_KEY\s*=/.test(l)).length, 1);
  assert.ok(ejemplo.includes(`\nODDS_API_KEY=${CLAVE}\n`));
});

test('terminalQuePisa: una ODDS_API_KEY de la terminal, distinta o VACÍA, gana sobre el .env', () => {
  assert.deepEqual(m.terminalQuePisa({}, CLAVE), []);
  assert.deepEqual(m.terminalQuePisa({ ODDS_API_KEY: CLAVE }, CLAVE), []);
  assert.deepEqual(m.terminalQuePisa({ ODDS_API_KEY: 'vieja' }, CLAVE), [{ nombre: 'ODDS_API_KEY', vacia: false }]);
  assert.deepEqual(m.terminalQuePisa({ ODDS_API_KEY: '' }, CLAVE), [{ nombre: 'ODDS_API_KEY', vacia: true }]);
  // El alias no estorba: la app mira antes ODDS_API_KEY.
  assert.deepEqual(m.terminalQuePisa({ THE_ODDS_API_KEY: 'otra' }, CLAVE), []);
});

test('la comprobación: listado gratuito (/v4/sports), y cada respuesta dice lo que es', async () => {
  const pedidas: string[] = [];
  const falso = (status: number, cuerpo: string, restantes: string | null) =>
    (async (url: string | URL | Request) => {
      pedidas.push(String(url));
      return new Response(cuerpo, { status, headers: restantes != null ? { 'x-requests-remaining': restantes } : {} });
    }) as typeof fetch;
  const ok = await m.comprobar(CLAVE, falso(200, '[]', '487'));
  assert.equal(ok.ok, true);
  assert.match(ok.texto, /487/);
  assert.ok(pedidas.every((u) => new URL(u).pathname === '/v4/sports'), 'solo el listado que no gasta créditos');
  assert.equal((await m.comprobar(CLAVE, falso(401, '{"error_code":"INVALID_KEY"}', null))).ok, false);
  const sinCreditos = await m.comprobar(CLAVE, falso(401, '{"error_code":"OUT_OF_USAGE_CREDITS"}', '0'));
  assert.equal(sinCreditos.ok, false);
  assert.match(sinCreditos.texto, /créditos/);
  assert.equal((await m.comprobar(CLAVE, falso(429, '', null))).ok, null);
  const sinRed = await m.comprobar(CLAVE, (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch);
  assert.equal(sinRed.ok, null);
  assert.match(sinRed.texto, /queda guardada/);
});

test('de punta a punta: crea el .env desde el ejemplo, una línea, y nunca imprime la clave', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['clave.mjs', 'otra-copia.mjs', 'ports.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(dir, '.env.example'));
    const entorno = { ...process.env, ODDS_API_KEY: 'vieja-de-la-terminal', PORT: '1' };
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'clave.mjs'), '--sin-red'], { input: `ODDS_API_KEY="${CLAVE}"\n`, env: entorno, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const salida = r.stdout + r.stderr;
    assert.ok(!salida.includes(CLAVE), 'la clave entera no sale por pantalla');
    assert.ok(!salida.includes('vieja-de-la-terminal'), 'tampoco la de la terminal');
    assert.match(salida, /••••cdef/);
    assert.match(salida, /unset ODDS_API_KEY/);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.equal(env.split('\n').filter((l) => l.startsWith('ODDS_API_KEY=')).length, 1);
    assert.ok(env.includes(`ODDS_API_KEY=${CLAVE}\n`));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o077, 0, 'nuevo .env solo legible por su dueño');
    // Como argumento, no: se quedaría en el historial.
    const arg = spawnSync(process.execPath, [path.join(dir, 'scripts', 'clave.mjs'), CLAVE], { input: '', env: entorno, encoding: 'utf8' });
    assert.equal(arg.status, 1);
    assert.ok(!(arg.stdout + arg.stderr).includes(CLAVE));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

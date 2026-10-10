// scripts/otra-copia.mjs: `npm run dev` reconoce otra copia de esta app en su puerto y da un
// comando para cerrarla que NO mata al navegador conectado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { pareceEstaApp, comandoCerrar, mensajeOtraCopia } = (await import(path.join(ROOT, 'scripts', 'otra-copia.mjs'))) as {
  pareceEstaApp: (port: number, opts?: { timeoutMs?: number; fetch?: typeof fetch }) => Promise<boolean>;
  comandoCerrar: (puertos: number[], plataforma?: string) => string[];
  mensajeOtraCopia: (o: { web: number | null; api: number | null; plataforma?: string }) => string;
};

/**
 * `fetch` está bloqueado en los tests (src/test/setup.ts: nunca la red). Este solo llega a
 * 127.0.0.1, que es lo único que estas pruebas necesitan.
 */
const fetchLocal = ((url: string) =>
  new Promise((ok, mal) => {
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1') return mal(new Error(`solo 127.0.0.1: ${url}`));
    const req = http.get(u, (res) => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (cuerpo += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, text: async () => cuerpo }));
    });
    req.on('error', mal);
    req.setTimeout(500, () => req.destroy(new Error('timeout')));
  })) as unknown as typeof fetch;

/** Un servidor local que responde lo que se le diga; devuelve su puerto y cómo cerrarlo. */
async function servidor(responder: (url: string) => { status: number; cuerpo: string }) {
  const s = http.createServer((req, res) => {
    const r = responder(req.url ?? '/');
    res.writeHead(r.status, { 'content-type': 'text/plain' });
    res.end(r.cuerpo);
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return { port: (s.address() as AddressInfo).port, cerrar: () => new Promise<void>((ok) => s.close(() => ok())) };
}

test('la página de esta app (el <title> de web/index.html) se reconoce', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const s = await servidor(() => ({ status: 200, cuerpo: html }));
  try {
    assert.equal(await pareceEstaApp(s.port, { fetch: fetchLocal }), true);
  } finally {
    await s.cerrar();
  }
});

test('la API de esta app (/ready con migraciones y trabajos, aunque sea 503) se reconoce', async () => {
  const s = await servidor((url) =>
    url === '/ready' ? { status: 503, cuerpo: JSON.stringify({ ok: false, migraciones: 'pendientes', trabajos: 'ok', detalle: [] }) } : { status: 404, cuerpo: '{"error":"no"}' },
  );
  try {
    assert.equal(await pareceEstaApp(s.port, { fetch: fetchLocal }), true);
  } finally {
    await s.cerrar();
  }
});

test('otro programa en el puerto, o nadie, no es esta app', async () => {
  const otro = await servidor((url) => (url === '/ready' ? { status: 200, cuerpo: '{"ok":true}' } : { status: 200, cuerpo: '<title>Otra cosa</title>' }));
  try {
    assert.equal(await pareceEstaApp(otro.port, { fetch: fetchLocal }), false);
  } finally {
    await otro.cerrar();
  }
  // El puerto de un servidor recién cerrado: nadie escucha.
  assert.equal(await pareceEstaApp(otro.port, { timeoutMs: 300, fetch: fetchLocal }), false);
});

test('el comando para cerrarla filtra por LISTEN: nunca el `lsof -ti :puerto` que también mata al navegador', () => {
  assert.deepEqual(comandoCerrar([7374, 7373], 'darwin'), ['lsof -ti tcp:7373-7374 -sTCP:LISTEN | xargs kill']);
  assert.deepEqual(comandoCerrar([7373], 'linux'), ['lsof -ti tcp:7373 -sTCP:LISTEN | xargs kill']);
  assert.deepEqual(comandoCerrar([7373, 7380], 'linux'), ['lsof -ti tcp:7373,7380 -sTCP:LISTEN | xargs kill']);
  const win = comandoCerrar([7373], 'win32');
  assert.ok(win.some((c) => c.includes('LISTENING') && c.includes(':7373')));
  assert.ok(win.some((c) => c.startsWith('taskkill')));
  for (const c of [...comandoCerrar([7373, 7374], 'darwin'), ...comandoCerrar([7373], 'linux')]) {
    assert.match(c, /-sTCP:LISTEN/);
  }
});

test('el aviso dice dónde está la otra copia, cómo cerrarla y cómo arrancar las dos a propósito', () => {
  const m = mensajeOtraCopia({ web: 7373, api: 7374, plataforma: 'darwin' });
  assert.match(m, /otra copia de esta app abierta en http:\/\/localhost:7373/);
  assert.match(m, /lsof -ti tcp:7373-7374 -sTCP:LISTEN \| xargs kill/);
  assert.match(m, /npm run dev -- --junto/);
  const soloApi = mensajeOtraCopia({ web: null, api: 7374, plataforma: 'linux' });
  assert.match(soloApi, /el puerto 7374/);
  assert.match(soloApi, /tcp:7374 -sTCP:LISTEN/);
});

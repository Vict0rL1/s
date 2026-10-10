// D6 (revisión del 8 de octubre): el service worker, ejecutado de verdad en una caja con una
// caché y una red simuladas. Cada caso es uno de los defectos de la revisión.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

type Manejador = (e: unknown) => void;

/** Carga public/sw.js con `self`, `caches` y `fetch` simulados. */
function cargar(red: (req: Request) => Promise<Response>) {
  const almacen = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (n: string) => {
      if (!almacen.has(n)) almacen.set(n, new Map());
      const m = almacen.get(n)!;
      return { put: async (k: Request | string, r: Response) => void m.set(typeof k === 'string' ? new URL(k, 'http://app.test').href : k.url, r), addAll: async () => undefined };
    },
    match: async (k: Request | string) => {
      const url = typeof k === 'string' ? new URL(k, 'http://app.test').href : k.url;
      for (const m of almacen.values()) if (m.has(url)) return m.get(url)!.clone();
      return undefined;
    },
    keys: async () => [...almacen.keys()],
    delete: async (n: string) => almacen.delete(n),
  };
  const manejadores: Record<string, Manejador[]> = {};
  const self = {
    location: { origin: 'http://app.test' },
    addEventListener: (tipo: string, f: Manejador) => (manejadores[tipo] ??= []).push(f),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    registration: {},
  };
  vm.runInNewContext(fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self, caches, fetch: red, Response, Request, Headers, URL, Promise, console });
  /** Lanza un fetch al worker: devuelve la respuesta, o null si el worker no la toma. */
  async function pedir(url: string, init: RequestInit & { mode?: string } = {}): Promise<Response | null> {
    const { mode: modo, ...resto } = init;
    const req = new Request(new URL(url, 'http://app.test'), resto);
    let resp: Promise<Response> | null = null;
    const evento = { request: modo ? new Proxy(req, { get: (t, p) => (p === 'mode' ? modo : Reflect.get(t, p, t)) }) : req, respondWith: (p: Promise<Response>) => (resp = p), waitUntil: () => undefined };
    for (const f of manejadores.fetch ?? []) f(evento);
    const r = resp ? await resp : null;
    await new Promise((ok) => setTimeout(ok, 5));
    return r;
  }
  async function mensaje(data: unknown) {
    const pendientes: Promise<unknown>[] = [];
    for (const f of manejadores.message ?? []) f({ data, waitUntil: (p: Promise<unknown>) => pendientes.push(p) });
    await Promise.all(pendientes);
  }
  return { pedir, mensaje, almacen };
}

const json = (status = 200) => new Response('{"ok":true}', { status, headers: { 'content-type': 'application/json' } });

test('D6: el canal en vivo (SSE) no pasa por el worker', async () => {
  const sw = cargar(async () => new Response('data: x\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(await sw.pedir('/api/latency/stream', { headers: { accept: 'text/event-stream' } }), null, 'por la cabecera Accept');
  assert.equal(await sw.pedir('/api/latency/stream'), null, 'y por la ruta');
});

test('D6: la navegación solo guarda como armazón una página HTML buena', async () => {
  const sw = cargar(async (req) => (new URL(req.url).pathname === '/malo' ? json(401) : new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })));
  await sw.pedir('/malo', { mode: 'navigate' });
  assert.equal(sw.almacen.get('predictor-armazon-v1')?.size ?? 0, 0, 'un 401 JSON no es el armazón');
  await sw.pedir('/futbol', { mode: 'navigate' });
  assert.equal(sw.almacen.get('predictor-armazon-v1')?.size, 1);
});

test('D6: apuestas y búsqueda no se guardan; lo demás sí, y sin red sale marcado como de la caché', async () => {
  let enLinea = true;
  const sw = cargar(async () => {
    if (!enLinea) throw new TypeError('Failed to fetch');
    return json();
  });
  await sw.pedir('/api/bets?estado=pending');
  await sw.pedir('/api/bets/resumen');
  await sw.pedir('/api/buscar?q=madrid');
  await sw.pedir('/api/top-picks?horas=24');
  const api = [...(sw.almacen.get('predictor-api-v1')?.keys() ?? [])];
  assert.deepEqual(api, ['http://app.test/api/top-picks?horas=24']);
  enLinea = false;
  const r = await sw.pedir('/api/top-picks?horas=24');
  assert.equal(r?.status, 200);
  assert.equal(r?.headers.get('x-desde-cache'), '1', 'para el banner «datos de…»');
});

test('D6: al salir se vacía la caché de la API', async () => {
  const sw = cargar(async () => json());
  await sw.pedir('/api/top-picks');
  assert.ok(sw.almacen.has('predictor-api-v1'));
  await sw.mensaje({ tipo: 'vaciar-api' });
  assert.equal(sw.almacen.has('predictor-api-v1'), false);
});

// Cabeceras, CORS cerrado, límite de cuerpo y el registro de errores con su id de petición.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { buildApp } = await import('../app.ts');
const { configAuth } = await import('../auth/mode.ts');
const { LimiteDeIntentos } = await import('../auth/rateLimit.ts');
const { CABECERAS, CSP } = await import('./headers.ts');
const { leerErrores, contarErrores, registrarError, LIMITE_ERROR_LOG } = await import('./errors.ts');
const { origenesPermitidos } = await import('./cors.ts');

async function appAbierta(entorno: Partial<NodeJS.ProcessEnv> = {}) {
  const e = { NODE_ENV: 'test', ...entorno } as NodeJS.ProcessEnv;
  return buildApp({ auth: { config: configAuth(e), limite: new LimiteDeIntentos() }, servirWeb: false, logger: false, entorno: e });
}

test('cabeceras de seguridad en toda respuesta, sin HSTS fuera de producción', async () => {
  const app = await appAbierta();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  for (const [k, v] of Object.entries(CABECERAS)) assert.equal(res.headers[k], v, k);
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /script-src 'self'/);
  assert.equal(res.headers['strict-transport-security'], undefined);
  await app.close();
  const prod = await appAbierta({ NODE_ENV: 'production', APP_PASSWORD: 'una-frase-larga-y-propia' });
  const r2 = await prod.inject({ method: 'GET', url: '/healthz' });
  assert.match(String(r2.headers['strict-transport-security']), /max-age=/);
  await prod.close();
});

test('CORS: un origen ajeno no se refleja; solo los de CORS_ORIGINS', async () => {
  const cerrada = await appAbierta();
  const ajeno = await cerrada.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://malo.example' } });
  assert.equal(ajeno.headers['access-control-allow-origin'], undefined);
  await cerrada.close();
  assert.deepEqual(origenesPermitidos({ CORS_ORIGINS: 'https://ok.example/, https://otro.example' } as NodeJS.ProcessEnv), ['https://ok.example', 'https://otro.example']);
  const abierta = await appAbierta({ CORS_ORIGINS: 'https://ok.example' });
  const ok = await abierta.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://ok.example' } });
  assert.equal(ok.headers['access-control-allow-origin'], 'https://ok.example');
  const malo = await abierta.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://malo.example' } });
  assert.equal(malo.headers['access-control-allow-origin'], undefined);
  await abierta.close();
});

test('límite de cuerpo: por encima, 413 con requestId; por debajo, pasa', async () => {
  const app = await appAbierta({ BODY_LIMIT_BYTES: '1024' });
  const grande = await app.inject({ method: 'POST', url: '/api/ask', payload: { pregunta: 'x'.repeat(2000) } });
  assert.equal(grande.statusCode, 413);
  assert.match(grande.json().requestId, /^[0-9a-f-]{36}$/);
  const pequeña = await app.inject({ method: 'POST', url: '/api/ask', payload: { pregunta: 'top 5 atp' } });
  assert.equal(pequeña.statusCode, 200);
  await app.close();
});

test('un error no controlado deja fila en error_log con el mismo requestId que la respuesta, y sin la pila', async () => {
  const app = await appAbierta();
  app.get('/__boom', async () => {
    throw new Error('explota a propósito');
  });
  const antes = contarErrores('1970-01-01');
  const res = await app.inject({ method: 'GET', url: '/__boom', headers: { 'x-request-id': 'req-de-prueba-123' } });
  assert.equal(res.statusCode, 500);
  const j = res.json() as { error: string; requestId: string };
  assert.equal(j.error, 'Error interno del servidor', 'el mensaje interno no sale');
  assert.equal(j.requestId, 'req-de-prueba-123', 'respeta el id del proxy');
  assert.ok(!JSON.stringify(j).includes('explota'), 'ni el mensaje ni la pila viajan al cliente');
  assert.equal(contarErrores('1970-01-01'), antes + 1);
  const fila = leerErrores(1)[0];
  assert.equal(fila.request_id, 'req-de-prueba-123');
  assert.equal(fila.message, 'explota a propósito');
  assert.equal(fila.status, 500);
  assert.match(fila.stack ?? '', /explota/);
  // Un 404 de la API no es un error del servidor: no se apunta.
  await app.inject({ method: 'GET', url: '/api/no-existe' });
  assert.equal(contarErrores('1970-01-01'), antes + 1);
  await app.close();
});

test('B6: error_log no crece sin tope: por encima del límite se podan las más viejas', () => {
  assert.ok(LIMITE_ERROR_LOG >= 1000 && LIMITE_ERROR_LOG <= 20_000, String(LIMITE_ERROR_LOG));
  for (let i = 0; i < LIMITE_ERROR_LOG + 120; i++) registrarError({ status: 500, message: `fallo ${i}`, url: '/x' }, new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)));
  assert.ok(contarErrores('1970-01-01') <= LIMITE_ERROR_LOG, `${contarErrores('1970-01-01')} filas con tope ${LIMITE_ERROR_LOG}`);
  assert.equal(leerErrores(1)[0].message, `fallo ${LIMITE_ERROR_LOG + 119}`, 'se quedan las más recientes');
});

test('D9: la CSP deja cargar imágenes blob: (Mi selección → PNG) y solo en img-src', async () => {
  const { CSP } = await import('./headers.ts');
  const directivas = Object.fromEntries(CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.ok(directivas['img-src'].includes('blob:'), `img-src: ${directivas['img-src'].join(' ')}`);
  for (const [k, v] of Object.entries(directivas)) if (k !== 'img-src') assert.ok(!v.includes('blob:'), `${k} no lleva blob:`);
});

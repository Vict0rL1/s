// Lote A (revisión del 8 de octubre de 2026): lo que la puerta hacía mal.
//
//   A1  En producción la web entera quedaba detrás de la puerta: `/`, los assets y las rutas
//       de la SPA devolvían 401 y no había forma de llegar a la pantalla de entrada.
//   A2  El límite de intentos se saltaba con `X-Forwarded-For`, bloqueaba al dueño aunque
//       trajera una sesión válida, y su Map crecía sin tope.
//   A3  Basic Auth se saltaba el TOTP, y la API podía apagar `auth.totp` y `auth.sesiones`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../test/setup.ts';

const { buildApp } = await import('../app.ts');
const { configAuth } = await import('./mode.ts');
const { LimiteDeIntentos } = await import('./rateLimit.ts');
const { totp, base32Encode } = await import('./totp.ts');
const { featureEncendida, reiniciarFeatures, estadoFeatures } = await import('../features.ts');

const PASSWORD = 'una-frase-larga-y-propia';
const ENTORNO = { APP_AUTH: 'on', APP_PASSWORD: PASSWORD, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const basic = (clave = PASSWORD) => 'Basic ' + Buffer.from(`victor:${clave}`).toString('base64');
const soloToken = (sc: string) => sc.split(';')[0];

function reloj() {
  let t = 1_700_000_000_000;
  return { ahora: () => t, avanzar: (ms: number) => (t += ms) };
}

async function appConAuth(extra: Partial<NodeJS.ProcessEnv> = {}, limite = new LimiteDeIntentos(), opciones: { webDist?: string } = {}) {
  const entorno = { ...ENTORNO, ...extra } as NodeJS.ProcessEnv;
  return buildApp({ auth: { config: configAuth(entorno), limite }, servirWeb: !!opciones.webDist, webDist: opciones.webDist, logger: false, entorno });
}

/** Una web construida de mentira: el index, un asset y el service worker. */
function webDeMentira(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Sports Predictor</title><script src="/assets/x.js"></script>');
  fs.writeFileSync(path.join(dir, 'assets', 'x.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'sw.js'), '// sw');
  return dir;
}

// ---------------------------------------------------------------------------
// A1
// ---------------------------------------------------------------------------
test('A1: con la puerta activa, la web construida se sirve sin credenciales y la API no', async () => {
  const app = await appConAuth({}, new LimiteDeIntentos(), { webDist: webDeMentira() });
  const html = { accept: 'text/html' };
  const portada = await app.inject({ method: 'GET', url: '/', headers: html });
  assert.equal(portada.statusCode, 200, `GET / → ${portada.statusCode} ${portada.body}`);
  assert.match(portada.body, /Sports Predictor/);
  assert.equal((await app.inject({ method: 'GET', url: '/assets/x.js' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/sw.js' })).statusCode, 200);
  // Una ruta de la SPA recargada: el index, para que React decida.
  const spa = await app.inject({ method: 'GET', url: '/apuestas', headers: html });
  assert.equal(spa.statusCode, 200);
  assert.match(spa.body, /Sports Predictor/);
  // La API sigue cerrada: un endpoint mal escrito es 401 sin credenciales (no se dice qué
  // rutas existen) y un 404 JSON con ellas; nunca la página.
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 401);
  const typo = await app.inject({ method: 'GET', url: '/api/typo', headers: html });
  assert.equal(typo.statusCode, 401);
  assert.equal(typo.json().error, 'Contraseña requerida');
  const typoDentro = await app.inject({ method: 'GET', url: '/api/typo', headers: { ...html, authorization: basic() } });
  assert.equal(typoDentro.statusCode, 404);
  assert.equal(typoDentro.json().error, 'Ruta no encontrada: /api/typo');
  // Lo que no es estático sigue detrás: la especificación y el visor.
  assert.equal((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/apuestas', payload: {} })).statusCode, 401);
  await app.close();
});

// ---------------------------------------------------------------------------
// A2
// ---------------------------------------------------------------------------
test('A2: fuera de producción, rotar X-Forwarded-For no evita el bloqueo (cuenta el socket)', async () => {
  const r = reloj();
  const app = await appConAuth({}, new LimiteDeIntentos({ ahora: r.ahora }));
  let ultimo = 0;
  for (let i = 1; i <= 6; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'mal' }, headers: { 'x-forwarded-for': `203.0.113.${i}` } });
    ultimo = res.statusCode;
  }
  assert.equal(ultimo, 429, 'a la quinta, bloqueada aunque cada intento traiga otra X-Forwarded-For');
  // Y otro socket NO está bloqueado: el límite es por dirección de verdad.
  const otro = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD }, remoteAddress: '198.51.100.7' });
  assert.equal(otro.statusCode, 200);
  await app.close();
});

test('A2: en producción cuenta Fly-Client-IP (lo pone Fly), y X-Forwarded-For no cambia nada', async () => {
  const r = reloj();
  const app = await appConAuth({ NODE_ENV: 'production' }, new LimiteDeIntentos({ ahora: r.ahora }));
  let ultimo = 0;
  for (let i = 1; i <= 6; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'mal' },
      headers: { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': `203.0.113.${i}, 10.0.0.1` },
    });
    ultimo = res.statusCode;
  }
  assert.equal(ultimo, 429);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { 'fly-client-ip': '203.0.113.9' } })).statusCode, 429, 'la dirección de Fly sigue bloqueada');
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { 'fly-client-ip': '203.0.113.10', authorization: basic() } })).statusCode, 200, 'otra dirección de Fly entra');
  await app.close();
});

test('A2: una sesión válida entra aunque su dirección esté bloqueada', async () => {
  const r = reloj();
  const app = await appConAuth({}, new LimiteDeIntentos({ ahora: r.ahora }));
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  const cookie = soloToken(String(login.headers['set-cookie']));
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'mal' } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 429, 'sin sesión, bloqueada');
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })).statusCode, 200, 'con la sesión del dueño, dentro');
  await app.close();
});

test('A2: el limitador poda lo caducado y acota el número de direcciones', () => {
  const r = reloj();
  const limite = new LimiteDeIntentos({ ahora: r.ahora, maxDirecciones: 3 });
  for (let i = 0; i < 10; i++) limite.fallo(`10.0.0.${i}`);
  assert.ok(limite.tamano() <= 3, `${limite.tamano()} direcciones guardadas con tope 3`);
  // Lo caducado (fuera de la ventana y sin bloqueo vivo) desaparece.
  r.avanzar(16 * 60_000);
  limite.fallo('10.0.0.99');
  assert.equal(limite.tamano(), 1);
});

// ---------------------------------------------------------------------------
// A3
// ---------------------------------------------------------------------------
test('A3: con TOTP configurado, Basic Auth exige además el código en X-TOTP-Code', async () => {
  const secreto = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const r = reloj();
  const limite = new LimiteDeIntentos({ ahora: r.ahora });
  const app = await appConAuth({ TOTP_SECRET: secreto }, limite);
  const sin = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: basic() } });
  assert.equal(sin.statusCode, 401, 'la contraseña sola ya no abre');
  assert.equal(sin.json().totp, true);
  const mal = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: basic(), 'x-totp-code': '000000' } });
  assert.equal(mal.statusCode, 401);
  assert.equal(limite.bloqueadas(), 0);
  const bien = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: basic(), 'x-totp-code': totp(secreto) } });
  assert.equal(bien.statusCode, 200);
  // Y un código válido con la contraseña mala sigue siendo 401 (las dos cosas, siempre).
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: basic('nope'), 'x-totp-code': totp(secreto) } })).statusCode, 401);
  await app.close();
});

test('A3: los interruptores auth.* y seguridad.* son de arranque: la API no los cambia y la base no los anula', async () => {
  const app = await appConAuth();
  const h = { authorization: basic() };
  for (const nombre of ['auth.totp', 'auth.sesiones', 'seguridad.cabeceras', 'seguridad.errorLog']) {
    const res = await app.inject({ method: 'PATCH', url: `/api/features/${nombre}`, payload: { on: false }, headers: h });
    assert.equal(res.statusCode, 403, `${nombre}: ${res.statusCode} ${res.body}`);
  }
  // Uno normal sigue pudiéndose anular.
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/features/api.docs', payload: { on: false }, headers: h })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/features/api.docs', payload: { on: null }, headers: h })).statusCode, 200);
  const f = (await app.inject({ method: 'GET', url: '/api/features', headers: h })).json().features as Record<string, { soloArranque?: boolean }>;
  assert.equal(f['auth.totp'].soloArranque, true);
  assert.equal(f['seguridad.cabeceras'].soloArranque, true);
  assert.equal(f['api.docs'].soloArranque, false);
  await app.close();

  // Una anulación guardada en la base (de antes de este arreglo) para esos nombres se ignora.
  reiniciarFeatures(undefined, { 'auth.totp': false, 'auth.sesiones': false, 'api.docs': false });
  try {
    assert.equal(featureEncendida('auth.totp'), true);
    assert.equal(featureEncendida('auth.sesiones'), true);
    assert.equal(featureEncendida('api.docs'), false, 'las demás anulaciones siguen valiendo');
    assert.equal(estadoFeatures()['auth.totp'].anulada, false);
  } finally {
    reiniciarFeatures();
  }
});

test('B6: una cookie sp_session indescifrable no es un 500: se ignora y la puerta responde 401', async () => {
  const app = await appConAuth();
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: 'sp_session=%E0%A4%A; otra=%' } });
  assert.equal(res.statusCode, 401, res.body);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'sp_session=%E0%A4%A' } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().dentro, false);
  await app.close();
});

// ---------------------------------------------------------------------------
// D7 (lote D): un asset que ya no existe no es la página
// ---------------------------------------------------------------------------
test('D7: /assets/* y /flags/* que no existen son 404, no el index (la carga diferida falla en voz alta)', async () => {
  const app = await appConAuth({}, new LimiteDeIntentos(), { webDist: webDeMentira() });
  const viejo = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
  assert.equal(viejo.statusCode, 404, `→ ${viejo.statusCode} ${viejo.headers['content-type']}`);
  assert.doesNotMatch(viejo.body, /Sports Predictor/);
  assert.equal((await app.inject({ method: 'GET', url: '/flags/zz.svg' })).statusCode, 404);
  // Lo demás sigue igual: el asset que existe y la ruta de la SPA.
  assert.equal((await app.inject({ method: 'GET', url: '/assets/x.js' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/futbol/epl', headers: { accept: 'text/html' } })).statusCode, 200);
  await app.close();
});

// ---------------------------------------------------------------------------
// G12 (lote G): /api/auth/me no le dice el usuario a quien no ha entrado
// ---------------------------------------------------------------------------
test('G12: /api/auth/me sin sesión no lleva el usuario; con sesión, sí', async () => {
  const app = await appConAuth();
  const fuera = (await app.inject({ method: 'GET', url: '/api/auth/me' })).json() as Record<string, unknown>;
  assert.equal(fuera.dentro, false);
  assert.equal('usuario' in fuera, false, `fuera: ${JSON.stringify(fuera)}`);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const dentro = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json() as Record<string, unknown>;
  assert.equal(dentro.dentro, true);
  assert.equal(typeof dentro.usuario, 'string');
  await app.close();
});

// La puerta: límite de intentos, cookie con sus atributos, TOTP, y que TODAS las rutas
// (el SSE incluido) quedan detrás.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { buildApp } = await import('../app.ts');
const { configAuth, assertAuthConfigured } = await import('./mode.ts');
const { LimiteDeIntentos } = await import('./rateLimit.ts');
const { totp, verificarTotp, base32Decode, base32Encode, nuevoSecreto } = await import('./totp.ts');
const { igual } = await import('./compare.ts');
const { RUTAS_EXENTAS } = await import('../auth.ts');

const PASSWORD = 'una-frase-larga-y-propia';
const ENTORNO = { APP_AUTH: 'on', APP_PASSWORD: PASSWORD, NODE_ENV: 'test' } as NodeJS.ProcessEnv;

function reloj() {
  let t = 1_700_000_000_000;
  return { ahora: () => t, avanzar: (ms: number) => (t += ms) };
}

async function appConAuth(extra: Partial<NodeJS.ProcessEnv> = {}, limite = new LimiteDeIntentos()) {
  const rutas: { method: string | string[]; url: string }[] = [];
  const entorno = { ...ENTORNO, ...extra } as NodeJS.ProcessEnv;
  const app = await buildApp({ auth: { config: configAuth(entorno), limite }, servirWeb: false, logger: false, entorno, onRoute: (r) => rutas.push(r) });
  return { app, rutas };
}

const cookieDe = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '');
const soloToken = (sc: string) => sc.split(';')[0];

test('modo: auto solo en producción; on siempre; off nunca (y off en producción no arranca)', () => {
  assert.equal(configAuth({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).activa, false);
  assert.equal(configAuth({ NODE_ENV: 'production', APP_PASSWORD: PASSWORD } as NodeJS.ProcessEnv).activa, true);
  assert.equal(configAuth({ APP_AUTH: 'on', APP_PASSWORD: PASSWORD } as NodeJS.ProcessEnv).activa, true);
  assert.equal(configAuth({ APP_AUTH: 'off', NODE_ENV: 'production', APP_PASSWORD: PASSWORD } as NodeJS.ProcessEnv).activa, false);
  assert.throws(() => assertAuthConfigured(configAuth({ APP_AUTH: 'off', NODE_ENV: 'production', APP_PASSWORD: PASSWORD } as NodeJS.ProcessEnv)), /no arranca sin contraseña/);
  assert.throws(() => assertAuthConfigured(configAuth({ APP_AUTH: 'on', APP_PASSWORD: 'corta' } as NodeJS.ProcessEnv)), /Ocho es el mínimo/);
  assert.throws(() => assertAuthConfigured(configAuth({ APP_AUTH: 'on', APP_PASSWORD: PASSWORD, TOTP_SECRET: 'no-es-base32!' } as NodeJS.ProcessEnv)), /base32/);
});

test('comparación en tiempo constante: iguales sí, distintas y de otra longitud no, sin lanzar', () => {
  assert.equal(igual('abc', 'abc'), true);
  assert.equal(igual('abc', 'abd'), false);
  assert.equal(igual('abc', 'abcd'), false);
  assert.equal(igual('', ''), true);
});

test('sin credenciales, todas las rutas registradas devuelven 401 salvo las exentas (el SSE incluido)', async () => {
  const { app, rutas } = await appConAuth();
  assert.ok(rutas.length > 60, `se registraron ${rutas.length} rutas`);
  assert.ok(rutas.some((r) => r.url === '/api/latency/stream'), 'el SSE está entre las rutas');
  for (const r of rutas) {
    const metodos = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of metodos) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      const url = r.url.replace(/:[a-zA-Z]+/g, '1');
      const res = await app.inject({ method: m as 'GET', url, payload: m === 'GET' ? undefined : {} });
      if (RUTAS_EXENTAS.has(r.url)) {
        // Exenta de la PUERTA: puede devolver 401 por otra cosa (login con contraseña vacía),
        // pero nunca el 401 de «Contraseña requerida».
        const cuerpo = res.json() as { error?: string };
        assert.notEqual(cuerpo.error, 'Contraseña requerida', `${m} ${r.url} está exenta y la puerta la paró`);
      } else {
        assert.equal(res.statusCode, 401, `${m} ${r.url} devolvió ${res.statusCode} sin credenciales`);
      }
    }
  }
  const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
  // Sin el usuario: solo se le dice a quien ya ha entrado (G12, lote G).
  assert.deepEqual(me.json(), { auth: true, dentro: false, totp: false, sesiones: true, sesionId: null });
  await app.close();
});

test('Basic Auth sigue valiendo, y el fallo por Basic Auth también cuenta para el límite', async () => {
  const r = reloj();
  const limite = new LimiteDeIntentos({ ahora: r.ahora });
  const { app } = await appConAuth({}, limite);
  const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: 'Basic ' + Buffer.from(`victor:${PASSWORD}`).toString('base64') } });
  assert.equal(ok.statusCode, 200);
  const mal = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: 'Basic ' + Buffer.from('victor:nope').toString('base64') } });
  assert.equal(mal.statusCode, 401);
  assert.match(String(mal.headers['www-authenticate']), /Basic realm/);
  await app.close();
});

test('login: contraseña mala 401; a la quinta, 429 con Retry-After; pasado el bloqueo, vuelve a dejar', async () => {
  const r = reloj();
  const limite = new LimiteDeIntentos({ ahora: r.ahora });
  const { app } = await appConAuth({}, limite);
  for (let i = 1; i <= 4; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'mal' } });
    assert.equal(res.statusCode, 401, `intento ${i}`);
  }
  const quinto = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'mal' } });
  assert.equal(quinto.statusCode, 429);
  assert.ok(Number(quinto.headers['retry-after']) >= 900, 'quince minutos');
  // Incluso con la contraseña BUENA, la dirección está bloqueada: así se frena la fuerza bruta.
  const bloqueado = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  assert.equal(bloqueado.statusCode, 429);
  // Y una ruta normal también responde 429 mientras dura.
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 429);
  r.avanzar(16 * 60_000);
  const despues = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  assert.equal(despues.statusCode, 200);
  await app.close();
});

test('la cookie: HttpOnly, SameSite=Strict, Path=/; Secure en producción; y abre la puerta', async () => {
  const { app } = await appConAuth();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  const sc = cookieDe(login);
  assert.match(sc, /^sp_session=[A-Za-z0-9_-]{20,}/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Max-Age=2592000/);
  assert.doesNotMatch(sc, /Secure/, 'en un test por HTTP no se exige Secure');
  const cookie = soloToken(sc);
  const dentro = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
  assert.equal(dentro.statusCode, 200);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.json().dentro, true);
  // Una cookie inventada no vale.
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: 'sp_session=' + 'x'.repeat(43) } })).statusCode, 401);
  await app.close();

  // Producción (sin web construida: servirWeb false) → Secure.
  const prod = await appConAuth({ NODE_ENV: 'production' });
  const l2 = await prod.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  assert.match(cookieDe(l2), /Secure/);
  await prod.app.close();
});

test('sesiones: se listan, la actual va marcada, se revocan y la revocada deja de valer; logout también', async () => {
  const { app } = await appConAuth();
  const l1 = soloToken(cookieDe(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD }, headers: { 'user-agent': 'Portátil' } })));
  const l2 = soloToken(cookieDe(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD }, headers: { 'user-agent': 'Móvil' } })));
  const lista = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: l1 } });
  assert.equal(lista.statusCode, 200);
  const j = lista.json() as { actual: number; sesiones: { id: number; actual: boolean; user_agent: string }[] };
  assert.ok(j.sesiones.length >= 2);
  assert.equal(j.sesiones.filter((s) => s.actual).length, 1);
  const otra = j.sesiones.find((s) => !s.actual && s.user_agent === 'Móvil')!;
  const rev = await app.inject({ method: 'POST', url: `/api/auth/sessions/${otra.id}/revoke`, headers: { cookie: l1 } });
  assert.deepEqual(rev.json(), { ok: true, eraLaActual: false });
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: l2 } })).statusCode, 401, 'la revocada no entra');
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: l1 } })).statusCode, 200, 'la otra sigue');
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: l1 } });
  assert.match(cookieDe(out), /Max-Age=0/);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: l1 } })).statusCode, 401);
  await app.close();
});

test('TOTP: el vector de la RFC 6238, la ventana de ±1 paso, y el login lo exige cuando hay secreto', async () => {
  // RFC 6238, apéndice B: secreto ASCII «12345678901234567890», T = 59 s → 94287082 (los 6 últimos: 287082).
  const secreto = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  assert.equal(secreto, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp(secreto, 59_000), '287082');
  assert.equal(totp(secreto, 1_111_111_109_000), '081804');
  assert.equal(verificarTotp(secreto, '287082', 59_000), true);
  assert.equal(verificarTotp(secreto, '287082', 59_000 + 30_000), true, 'un paso después todavía vale');
  assert.equal(verificarTotp(secreto, '287082', 59_000 + 61_000), false, 'dos pasos después no');
  assert.equal(verificarTotp(secreto, '000000', 59_000), false);
  assert.deepEqual(base32Decode(secreto), Buffer.from('12345678901234567890', 'ascii'));
  const n = nuevoSecreto();
  assert.match(n.secreto, /^[A-Z2-7]{32}$/);
  assert.match(n.otpauth, /^otpauth:\/\/totp\//);

  const { app } = await appConAuth({ TOTP_SECRET: secreto });
  const sinCodigo = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  assert.equal(sinCodigo.statusCode, 401);
  assert.equal(sinCodigo.json().totp, true);
  const conCodigo = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD, codigo: totp(secreto) } });
  assert.equal(conCodigo.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me' })).json().totp, true);
  await app.close();
});

test('sin auth activa, nada cambia: las rutas abren y /api/auth/me lo dice', async () => {
  const entorno = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  const app = await buildApp({ auth: { config: configAuth(entorno), limite: new LimiteDeIntentos() }, servirWeb: false, logger: false, entorno });
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/auth/me' })).json(), { auth: false, dentro: true, totp: false, sesiones: false });
  await app.close();
});

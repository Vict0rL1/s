import { test } from 'node:test';
import assert from 'node:assert/strict';
import './../test/setup.ts';

const {
  comprobarConfiguracion,
  interpretarApi,
  comprobarDeportes,
  comprobarBaseDeDatos,
  comprobarFrescura,
  comprobarServidor,
  resultado,
  enmascarar,
} = await import('./checks.ts');
const { outcomeError, outcomeOk, OddsApiError } = await import('../oddsApi.ts');

const CLAVE = '0123456789abcdef0123456789abcdef';
const base = {
  envPath: '/proyecto/.env',
  envExiste: true,
  envCrudo: `ODDS_API_KEY=${CLAVE}\n`,
  otrosEnv: [] as string[],
  valoresFichero: { ODDS_API_KEY: CLAVE } as Record<string, string>,
  valoresProceso: { ODDS_API_KEY: CLAVE } as Record<string, string | undefined>,
  clave: { value: CLAVE, name: 'ODDS_API_KEY' as string | null },
  regiones: 'eu',
  zonaHoraria: 'Europe/Madrid',
  offsetMin: 120,
};
const niveles = (hs: { nivel: string }[]) => hs.map((x) => x.nivel);
const buscar = <T extends { texto: string }>(hs: T[], re: RegExp): T | undefined => hs.find((x) => re.test(x.texto));

test('configuración correcta: sin errores, y la clave nunca se imprime entera', () => {
  const hs = comprobarConfiguracion(base);
  assert.ok(!niveles(hs).includes('error'));
  assert.ok(buscar(hs, /API key detectada/));
  assert.ok(!JSON.stringify(hs).includes(CLAVE), 'la clave completa no puede aparecer en la salida');
  assert.equal(enmascarar(CLAVE), '••••cdef');
});

test('sin clave: error con la acción exacta', () => {
  const hs = comprobarConfiguracion({ ...base, envCrudo: '', valoresFichero: {}, valoresProceso: {}, clave: { value: '', name: null } });
  const e = buscar(hs, /ODDS_API_KEY no encontrada/);
  assert.equal(e?.nivel, 'error');
  assert.match(e!.accion!.join(' '), /ODDS_API_KEY=/);
});

test('el alias THE_ODDS_API_KEY se reconoce y se dice de dónde salió', () => {
  const hs = comprobarConfiguracion({
    ...base,
    envCrudo: `THE_ODDS_API_KEY=${CLAVE}\n`,
    valoresFichero: { THE_ODDS_API_KEY: CLAVE },
    valoresProceso: { THE_ODDS_API_KEY: CLAVE },
    clave: { value: CLAVE, name: 'THE_ODDS_API_KEY' },
  });
  assert.match(buscar(hs, /API key detectada/)!.texto, /THE_ODDS_API_KEY/);
});

// TEST NEGATIVO: el caso invisible. La terminal tiene la variable con otro valor y
// dotenv no la pisa, así que la app usa la de la terminal.
test('la terminal con OTRA clave pisa al .env: se detecta como error', () => {
  const hs = comprobarConfiguracion({ ...base, valoresProceso: { ODDS_API_KEY: '' } });
  const e = buscar(hs, /La terminal tiene ODDS_API_KEY/);
  assert.equal(e?.nivel, 'error');
  assert.match(e!.accion!.join(' '), /unset ODDS_API_KEY/);
});

test('clave sin nombre delante, comillas y saltos de Windows', () => {
  assert.ok(buscar(comprobarConfiguracion({ ...base, envCrudo: `${CLAVE}\n`, clave: { value: '', name: null } }), /sin `ODDS_API_KEY=` delante/));
  assert.ok(buscar(comprobarConfiguracion({ ...base, envCrudo: `ODDS_API_KEY="${CLAVE}"\n` }), /entre comillas/));
  assert.equal(buscar(comprobarConfiguracion({ ...base, envCrudo: `ODDS_API_KEY=${CLAVE}\r\n` }), /Windows/)?.nivel, 'error');
});

test('región inválida es un error (la API respondería 422)', () => {
  assert.equal(buscar(comprobarConfiguracion({ ...base, regiones: 'europe' }), /ODDS_REGIONS/)?.nivel, 'error');
  assert.equal(buscar(comprobarConfiguracion({ ...base, regiones: 'eu,uk' }), /Regiones/)?.nivel, 'ok');
});

// ---------------------------------------------------------------------------
const listadoOk = {
  status: 200, cuerpo: '', restantes: 463, usados: 37, ms: 120, errorRed: null,
  deportes: [{ key: 'basketball_nba', active: true }, { key: 'baseball_mlb', active: false }],
};
const apiBase = { hayClave: true, sinRed: false, listado: listadoOk, plan: 500, ritmo: { ok: true } as const, gastoPorCiclo: 5, minutosEntreCiclos: 720 };

test('API sana: clave válida, responde, créditos y presupuesto', () => {
  const hs = interpretarApi(apiBase);
  assert.deepEqual(niveles(hs).filter((n) => n !== 'info'), ['ok', 'ok', 'ok', 'ok']);
  assert.ok(buscar(hs, /Créditos restantes: 463/));
  assert.ok(buscar(hs, /~10\/día/));
});

test('401 de clave y 401 de créditos son errores distintos con acciones distintas', () => {
  const clave = interpretarApi({ ...apiBase, listado: { ...listadoOk, status: 401, cuerpo: '{"error_code":"INVALID_KEY"}' } });
  const creditos = interpretarApi({ ...apiBase, listado: { ...listadoOk, status: 401, cuerpo: '{"error_code":"OUT_OF_USAGE_CREDITS"}' } });
  assert.match(clave[0].accion![0], /no es válida/);
  assert.match(creditos[0].accion![0], /sin créditos/);
});

test('sin red y créditos agotados', () => {
  assert.equal(interpretarApi({ ...apiBase, listado: { ...listadoOk, status: null, errorRed: 'ENOTFOUND' } })[0].nivel, 'error');
  assert.equal(buscar(interpretarApi({ ...apiBase, listado: { ...listadoOk, restantes: 0 } }), /Créditos restantes/)?.nivel, 'error');
});

test('el freno de ritmo se enseña como advertencia, con la salida manual', () => {
  const hs = interpretarApi({ ...apiBase, ritmo: { ok: false, reason: 'vas por delante' } });
  assert.match(buscar(hs, /freno de ritmo/)!.accion![0], /npm run odds/);
});

// ---------------------------------------------------------------------------
test('deportes: con cuotas, parcial, sin partidos y con fallo', () => {
  const ok = (key: string, n: number, cp: number) =>
    ({ ...outcomeOk(key, { events: [], credits: 1, fetchedAt: 'x', malformed: 0 }), eventos: n, conPrecio: cp, casas: cp ? 4 : 0 });
  const hs = comprobarDeportes(
    [
      { nombre: 'NBA', claves: ['basketball_nba'], ultimas: [ok('basketball_nba', 8, 8)] },
      { nombre: 'Tenis', claves: ['basketball_nba'], ultimas: [ok('basketball_nba', 19, 6)] },
      { nombre: 'MLB', claves: ['baseball_mlb'], ultimas: [] },
      { nombre: 'NFL', claves: ['basketball_nba'], ultimas: [outcomeError('basketball_nba', new OddsApiError('sin_creditos', 'créditos agotados', 401))] },
    ],
    listadoOk.deportes,
  );
  assert.match(hs[0].texto, /8 eventos \/ 8 con cuotas/);
  assert.equal(hs[0].nivel, 'ok');
  assert.equal(hs[1].nivel, 'aviso');
  assert.match(hs[1].detalle!.join(), /13 evento\(s\) sin ninguna casa/);
  assert.match(hs[2].texto, /ninguna competición en juego/);
  assert.equal(hs[3].nivel, 'error');
  assert.match(hs[3].accion!.join(), /sin créditos/);
});

test('base de datos: totales, demo y sin cuotas', () => {
  const hs = comprobarBaseDeDatos('/x.db', true, [
    { nombre: 'Fútbol', total: 47, reales: 41, demo: 0, sinCuotas: 6 },
    { nombre: 'NFL', total: 12, reales: 12, demo: 0, sinCuotas: 0 },
  ], true);
  assert.ok(buscar(hs, /59 próximos eventos/));
  assert.ok(buscar(hs, /53 con cuotas reales/));
  assert.equal(buscar(hs, /6 sin cuotas/)?.nivel, 'aviso');
  assert.equal(comprobarBaseDeDatos('/x.db', false, [], true)[0].nivel, 'error');
});

test('frescura: cuotas de más de 6 h avisan; solo demo no da ✓', () => {
  const ahora = new Date('2026-10-01T12:00:00Z');
  const viejas = comprobarFrescura([{ nombre: 'NBA', ultimoRefresco: '2026-10-01T11:56:00Z', precioMasNuevo: '2026-10-01T02:00:00Z' }], ahora, true);
  assert.match(viejas[0].texto, /hace 4 min/);
  assert.equal(buscar(viejas, /puede que ya no valgan/)?.nivel, 'aviso');
  const demo = comprobarFrescura([{ nombre: 'NBA', ultimoRefresco: '2026-10-01T11:56:00Z', precioMasNuevo: null }], ahora, true);
  assert.equal(demo[0].nivel, 'aviso');
});

test('servidor: apagado es advertencia con `npm run dev`; encendido cuenta lo visible', () => {
  const apagado = comprobarServidor({ puertoApi: 7374, puertoWeb: 7373, api: { ok: false, error: 'no está arrancado' }, web: null, hoy: null });
  assert.equal(apagado[0].nivel, 'aviso');
  assert.deepEqual(apagado[0].accion, ['npm run dev']);
  const encendido = comprobarServidor({ puertoApi: 7374, puertoWeb: 7373, api: { ok: true }, web: { ok: true }, hoy: { partidos: 20, conPrecio: 15 } });
  assert.ok(buscar(encendido, /20 partidos visibles/));
  assert.ok(buscar(encendido, /15 con cuotas reales en pantalla/));
});

test('resultado: error manda, luego avisos; y la misma acción se dice una vez', () => {
  const r = resultado([
    { seccion: 'DEPORTES', nivel: 'aviso', texto: 'Fútbol', accion: ['npm run odds'] },
    { seccion: 'DEPORTES', nivel: 'aviso', texto: 'NBA', accion: ['npm run odds'] },
  ]);
  assert.equal(r.nivel, 'aviso');
  assert.equal(r.acciones.length, 1);
  assert.match(r.acciones[0].texto, /y 1 más: NBA/);
  assert.equal(resultado([{ seccion: 'BASE DE DATOS', nivel: 'ok', texto: 'x' }]).nivel, 'ok');
  assert.equal(resultado([{ seccion: 'BASE DE DATOS', nivel: 'error', texto: 'x' }]).nivel, 'error');
});

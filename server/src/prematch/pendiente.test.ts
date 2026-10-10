// G1 (lote G): una marca pre-partido que todavía no ha llegado está PENDIENTE. Antes,
// `horizontes()` la rellenaba con la última instantánea anterior a la marca, que para una marca
// futura es cualquiera tomada hoy: el T-1h de un partido de pasado mañana decía un número.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { recordSnapshot, horizontes } = await import('./snapshots.ts');

const H = 3_600_000;
const ahora = new Date('2026-10-09T19:00:00Z');
const instantanea = (matchKey: string, commence: string) => ({
  sport: 'nhl' as const, matchKey, eventId: matchKey, commence, outcomes: ['Local', 'Visitante'], probs: [0.654, 0.346], probsRaw: [0.654, 0.346],
  odds: null, oddsAt: null, usaMercado: false, entradas: {},
});

test('G1: con el partido a 30 h, T-24h, T-6h, T-1h y la final están pendientes (sin fila)', () => {
  const commence = new Date(ahora.getTime() + 30 * H).toISOString();
  recordSnapshot(instantanea('nhl|futuro', commence) as never, new Date(ahora.getTime() - 2 * H));
  const hs = horizontes('nhl', 'nhl|futuro', commence, ahora);
  assert.deepEqual(hs.map((h) => [h.etiqueta, h.fila === null]), [['T-24h', true], ['T-6h', true], ['T-1h', true], ['Final pre-partido', true]]);
});

test('G1: con el partido a 3 h, T-24h y T-6h ya pasaron (con fila); T-1h y la final, pendientes', () => {
  const commence = new Date(ahora.getTime() + 3 * H).toISOString();
  recordSnapshot(instantanea('nhl|cerca', commence) as never, new Date(ahora.getTime() - 30 * H));
  const hs = horizontes('nhl', 'nhl|cerca', commence, ahora);
  assert.deepEqual(hs.map((h) => [h.etiqueta, h.fila !== null]), [['T-24h', true], ['T-6h', true], ['T-1h', false], ['Final pre-partido', false]]);
});

test('G1: un partido ya jugado conserva todas sus filas (la evaluación por horizonte no cambia)', () => {
  const commence = new Date(ahora.getTime() - 5 * H).toISOString();
  recordSnapshot(instantanea('nhl|jugado', commence) as never, new Date(ahora.getTime() - 40 * H));
  const hs = horizontes('nhl', 'nhl|jugado', commence, ahora);
  assert.ok(hs.every((h) => h.fila !== null));
});

// G1b (revisión de quant-reviewer al lote G): el estado de cada horizonte lo decide el servidor con
// el MISMO reloj con que decide si hay fila. La web lo volvía a deducir con el suyo, y un segundo
// de desfase convertía un «pendiente» en «sin observación».
test('G1b: cada horizonte dice su estado (ok, pendiente, sin_observacion) con el mismo reloj', () => {
  const commence = new Date(ahora.getTime() + 3 * H).toISOString();
  // Una instantánea a T-30h (antes de T-24h) y nada más: T-24h y T-6h ya pasaron y tienen fila.
  recordSnapshot(instantanea('nhl|estado', commence) as never, new Date(ahora.getTime() - 27 * H));
  const hs = horizontes('nhl', 'nhl|estado', commence, ahora);
  assert.deepEqual(hs.map((h) => [h.etiqueta, h.estado]), [['T-24h', 'ok'], ['T-6h', 'ok'], ['T-1h', 'pendiente'], ['Final pre-partido', 'pendiente']]);
  // Un partido cuya primera instantánea llegó tarde: T-24h ya pasó sin nada anterior.
  const tarde = new Date(ahora.getTime() + 5 * H).toISOString();
  recordSnapshot(instantanea('nhl|tarde', tarde) as never, new Date(ahora.getTime() - 1 * H));
  assert.equal(horizontes('nhl', 'nhl|tarde', tarde, ahora)[0].estado, 'sin_observacion');
});

test('G1b: /api/prematch trae los nombres de los resultados aunque ningún horizonte haya llegado', async () => {
  const { buildApp } = await import('../app.ts');
  const { configAuth } = await import('../auth/mode.ts');
  const { LimiteDeIntentos } = await import('../auth/rateLimit.ts');
  const commence = new Date(Date.now() + 30 * H).toISOString();
  recordSnapshot(instantanea('nhl|nombres', commence) as never, new Date(Date.now() - 2 * H));
  const app = await buildApp({ auth: { config: configAuth({ APP_AUTH: 'off' }), limite: new LimiteDeIntentos() }, servirWeb: false, logger: false, entorno: { APP_AUTH: 'off' } });
  const r = await app.inject({ method: 'GET', url: `/api/prematch/nhl/${encodeURIComponent('nhl|nombres')}` });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json() as { outcomes: string[]; horizontes: { fila: unknown }[] };
  assert.ok(j.horizontes.every((h) => h.fila === null), 'los cuatro, pendientes');
  assert.deepEqual(j.outcomes, ['Local', 'Visitante']);
  await app.close();
});

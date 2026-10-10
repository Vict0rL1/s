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

// Combinadas: independientes multiplican, misma liga y día corrigen un poco, el mismo
// partido es incompatible, y la entrada inválida no entra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { combinada, validarPatas, posicionDe } = await import('./parlay.ts');
const { SAME_LEAGUE_DAY_RHO } = await import('../staking/correlation.ts');

const pata = (matchKey: string, p: number, extra: Partial<ReturnType<typeof validarPatas>[number]> = {}) => ({
  sport: 'football' as const, matchKey, liga: 'epl', cuando: '2026-10-10T15:00:00Z', seleccion: matchKey, indice: 0, resultados: 3, p, cuota: 2, ...extra,
});

test('patas sin vínculo: la conjunta es el producto', () => {
  const r = combinada([pata('a', 0.5, { liga: 'epl' }), pata('b', 0.5, { liga: 'laliga' })]);
  assert.equal(r.independiente, 0.25);
  assert.equal(r.conjunta, 0.25);
  assert.equal(r.vinculos.length, 0);
  assert.equal(r.cuotaCombinada, 4);
  assert.equal(r.cuotaJusta, 4);
  assert.ok(Math.abs((r.ventaja as number) - 0) < 1e-12);
});

test('C1: misma liga y día: la conjunta NO se infla (ρ medida indistinguible de cero → 0 entre partidos distintos)', () => {
  const r = combinada([pata('a', 0.1), pata('b', 0.1)]);
  assert.ok(Math.abs(r.conjunta - 0.01) < 1e-12, `${r.conjunta}: el producto, sin el 4 % de inflación del extremo alto del intervalo`);
  assert.ok(r.factorCorrelacion <= 1 && r.factorCorrelacion > 0);
  assert.ok(SAME_LEAGUE_DAY_RHO > 0, 'la ρ prudente sigue existiendo para DIMENSIONAR (libro manual)');
  assert.ok(r.vinculos.every((v) => v.rho === 0), JSON.stringify(r.vinculos));
  // Diez patas de la misma jornada: antes el factor pasaba de 6; ahora nunca más de 1.
  const diez = combinada(Array.from({ length: 10 }, (_, i) => pata(`p${i}`, 0.1)));
  assert.ok(diez.conjunta <= diez.independiente + 1e-15);
  assert.ok(diez.factorCorrelacion <= 1);
});

test('dos selecciones del mismo partido son incompatibles; la misma selección repetida cuenta una vez', () => {
  const r = combinada([pata('a', 0.5, { indice: 0, seleccion: 'local' }), pata('a', 0.3, { indice: 2, seleccion: 'visitante' })]);
  assert.equal(r.conjunta, 0);
  assert.equal(r.incompatibles.length, 1);
  assert.equal(r.cuotaJusta, null);
  const dup = combinada([pata('a', 0.5), pata('a', 0.5)]);
  assert.equal(dup.patas, 1);
  assert.equal(dup.conjunta, 0.5);
});

test('la conjunta nunca supera la pata menos probable ni baja de 0', () => {
  const r = combinada([pata('a', 0.9), pata('b', 0.1), pata('c', 0.95)]);
  assert.ok(r.conjunta <= 0.1 && r.conjunta >= 0);
});

test('validarPatas y posicionDe: límites, lados y fechas', () => {
  assert.throws(() => validarPatas([]), /entre 1 y 20/);
  assert.throws(() => validarPatas([{ p: 1.2, matchKey: 'x', cuando: '2026-01-01T00:00:00Z' }]), /fuera de/);
  assert.throws(() => validarPatas([{ p: 0.5, matchKey: 'x', cuando: 'ayer' }]), /fecha/);
  const [v] = validarPatas([{ sport: 'football', p: 0.5, matchKey: 'x', cuando: '2026-01-01T00:00:00Z', indice: 7, resultados: 3, cuota: '2.5' }]);
  assert.equal(v.indice, 2);
  assert.equal(v.cuota, 2.5);
  assert.equal(posicionDe(v).side, 'contraria');
  assert.equal(posicionDe({ ...v, indice: 1 }).side, 'otro');
  assert.equal(posicionDe(v).day, '2026-01-01');
});

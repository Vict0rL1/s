import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { SPORT_IDS } = await import('../sports.ts');
const { probarMedia, validacionEnVivo, MIN_N } = await import('./validation.ts');
const { getDb } = await import('../db.ts');

/** Generador determinista: los tests no pueden depender de la suerte. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const fmt = (x: number) => x.toFixed(3);

test('con menos de 30 datos no se afirma nada', () => {
  const r = probarMedia([0.1, 0.2, 0.3], 'x', true, fmt);
  assert.equal(r.veredicto, 'muestra insuficiente');
  assert.equal(r.lo, null);
  assert.match(r.lectura, /3 de al menos 30/);
});

test('un efecto claro sale a favor, con intervalo que no toca el cero', () => {
  const r0 = rng(1);
  const xs = Array.from({ length: 200 }, () => 0.05 + (r0() - 0.5) * 0.04);
  const r = probarMedia(xs, 'x', true, fmt);
  assert.equal(r.veredicto, 'a favor');
  assert.ok((r.lo as number) > 0);
});

// TEST NEGATIVO: el falso positivo que más cuesta. Ruido puro no puede salir «a favor».
test('ruido centrado en cero NO sale a favor, y dice cuántos datos harían falta', () => {
  const r0 = rng(7);
  const xs = Array.from({ length: 60 }, () => (r0() - 0.5) * 0.4);
  const r = probarMedia(xs, 'x', true, fmt);
  assert.notEqual(r.veredicto, 'a favor');
  assert.equal(r.veredicto, 'no concluyente');
  assert.ok(r.lectura.includes('incluye el cero'));
});

test('el signo de «a favor» se respeta: en log loss, negativo es mejor', () => {
  const xs = Array.from({ length: 100 }, (_, i) => -0.02 + (i % 2 ? 0.001 : -0.001));
  assert.equal(probarMedia(xs, 'x', false, fmt).veredicto, 'a favor');
  assert.equal(probarMedia(xs, 'x', true, fmt).veredicto, 'en contra');
});

test('en vivo: el CLV de las señales, separado en apostadas y rechazadas', () => {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO edge_signals (created_at, sport, event_id, selection, model_probability_calibrated, odds, edge, decision, stake, commence_time, closing_odds, clv)
     VALUES ('2026-09-01T10:00:00Z', 'football', ?, 'A', 0.55, 2.2, 0.21, ?, 0, '2026-09-01T18:00:00Z', 2.0, ?)`,
  );
  const r0 = rng(3);
  for (let i = 0; i < MIN_N + 10; i++) ins.run(`ev${i}`, i % 4 === 0 ? 'apostada' : 'rechazada', 0.06 + (r0() - 0.5) * 0.03);
  // Una señal sin ventaja no cuenta como «edge detectado».
  db.prepare(
    `INSERT INTO edge_signals (created_at, sport, event_id, selection, model_probability_calibrated, odds, edge, decision, stake, commence_time, closing_odds, clv)
     VALUES ('2026-09-01T10:00:00Z', 'football', 'sin-edge', 'A', 0.4, 2.2, -0.12, 'rechazada', 0, '2026-09-01T18:00:00Z', 2.5, -0.5)`,
  ).run();
  const v = validacionEnVivo();
  assert.equal(v.clvSenales.n, MIN_N + 10);
  assert.equal(v.clvSenales.veredicto, 'a favor');
  assert.equal(v.clvApostadas.n, 10);
  assert.equal(v.clvApostadas.veredicto, 'muestra insuficiente');
  assert.equal(v.retornoBanco.veredicto, 'muestra insuficiente');
  assert.equal(Object.keys(v.modeloVsMercado).length, SPORT_IDS.length);
});

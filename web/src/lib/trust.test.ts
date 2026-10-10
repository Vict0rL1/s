// D2 (revisión del 8 de octubre): un horizonte que todavía no ha llegado (T-1h de un partido
// de pasado mañana) no es «sin observación»: está pendiente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoSinDeriva, etiquetaHorizonte, nombreDelPrePartido, type Horizonte } from './trust.ts';

const ahora = new Date('2026-10-09T12:00:00Z');
const h = (marca: string, fila: Horizonte['fila'] = null): Horizonte => ({ etiqueta: 'T-1h', marca, fila, minutosAntesDeLaMarca: null });

test('D2: marca futura sin fila → pendiente; marca pasada sin fila → sin observación; con fila → nada', () => {
  assert.equal(etiquetaHorizonte(h('2026-10-11T19:00:00Z'), ahora), 'fiarse.pendiente');
  assert.equal(etiquetaHorizonte(h('2026-10-09T11:00:00Z'), ahora), 'fiarse.sinObservacion');
  assert.equal(etiquetaHorizonte(h('2026-10-09T11:00:00Z', { probs: [0.6, 0.4], captured_at: '2026-10-09T10:50:00Z', outcomes: ['A', 'B'] }), ahora), null);
  assert.equal(etiquetaHorizonte(h('no es una fecha'), ahora), 'fiarse.sinObservacion', 'una marca ilegible no se da por futura');
});

// G1b (revisión de quant-reviewer al lote G): con G1 los horizontes futuros llegan vacíos, y la web
// tenía tres sitios que daban por hecho que siempre había fila.
test('G1b: el estado lo dice el servidor, con su reloj; el del navegador solo si no viene', () => {
  const pasada = '2026-10-09T11:59:59Z';
  const futura = '2026-10-09T12:00:01Z';
  assert.equal(etiquetaHorizonte({ ...h(pasada), estado: 'pendiente' }, ahora), 'fiarse.pendiente', 'un segundo de desfase no lo vuelve «sin observación»');
  assert.equal(etiquetaHorizonte({ ...h(futura), estado: 'sin_observacion' }, ahora), 'fiarse.sinObservacion');
});

test('G1b: el nombre del resultado sale de las instantáneas, aunque ningún horizonte haya llegado', () => {
  const vacio = { instantaneas: 3, outcomes: ['Toronto', 'Montréal'], horizontes: [h('2026-10-11T19:00:00Z')], cambios: [], final: null };
  assert.equal(nombreDelPrePartido(vacio), 'Toronto');
  assert.equal(nombreDelPrePartido({ ...vacio, outcomes: undefined, horizontes: [h(pasadaFila, { probs: [0.6, 0.4], captured_at: pasadaFila, outcomes: ['A', 'B'] })] }), 'A');
});

const pasadaFila = '2026-10-09T10:00:00Z';
test('G1b: sin dos horizontes con fila, el aviso dice lo que pasa (no «solo hay una instantánea» con cinco)', () => {
  const base = { outcomes: ['A', 'B'], horizontes: [], cambios: [], final: null };
  assert.equal(avisoSinDeriva({ ...base, instantaneas: 0 }), 'partido.sinInstantaneas');
  assert.equal(avisoSinDeriva({ ...base, instantaneas: 1 }), 'partido.unaInstantanea');
  assert.equal(avisoSinDeriva({ ...base, instantaneas: 5 }), 'partido.sinDosHorizontes');
});

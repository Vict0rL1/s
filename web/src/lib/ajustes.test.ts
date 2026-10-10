// D11 (revisión del 8 de octubre): los formularios de Ajustes. Tras aplicar una cadencia el
// campo se quedaba VACÍO; un PATCH rechazado se tragaba sin decir nada; la cadencia no se
// comprobaba en el cliente; el banco no se podía vaciar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { borradorTrasAplicar, errorDeRespuesta, leerImporte, validarCadencia } from './ajustes.ts';

test('D11: tras aplicar, el borrador se olvida (el campo enseña la cadencia nueva, no un hueco)', () => {
  const b = borradorTrasAplicar({ 'odds-refresh': '45', otro: '10' }, 'odds-refresh');
  assert.deepEqual(b, { otro: '10' });
  assert.equal(b['odds-refresh'] ?? '30', '30', 'el campo cae a la cadencia que venga del servidor');
});

test('D11: la cadencia se valida en el cliente con el mismo rango que el servidor (1 min – 7 días)', () => {
  assert.deepEqual(validarCadencia('45'), { ok: true, minutos: 45 });
  assert.deepEqual(validarCadencia(' 1 '), { ok: true, minutos: 1 });
  assert.deepEqual(validarCadencia('10080'), { ok: true, minutos: 10080 });
  assert.equal(validarCadencia('20000').ok, false);
  assert.equal(validarCadencia('0').ok, false);
  assert.equal(validarCadencia('2,5').ok, false, 'minutos enteros');
  assert.equal(validarCadencia('').ok, false);
});

test('D11: un PATCH rechazado devuelve el motivo del servidor para enseñarlo', async () => {
  assert.equal(await errorDeRespuesta(new Response('{"ok":true}', { status: 200 })), null);
  assert.equal(await errorDeRespuesta(new Response('{"error":"cadenciaMin: entre 1 minuto y 7 días"}', { status: 400 })), 'cadenciaMin: entre 1 minuto y 7 días');
  assert.equal(await errorDeRespuesta(new Response('no es json', { status: 403 })), 'HTTP 403');
});

test('D11: el banco acepta coma o punto, y vacío es «sin banco»', () => {
  assert.equal(leerImporte('1.250,5'), null, 'ambiguo: no se adivina');
  assert.equal(leerImporte('1250,5'), 1250.5);
  assert.equal(leerImporte('1250.5'), 1250.5);
  assert.equal(leerImporte(''), null);
  assert.equal(leerImporte('-3'), null, 'negativo no');
  assert.equal(leerImporte('abc'), null);
});

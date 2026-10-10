// D14 (revisión del 8 de octubre): con /meta sin cargar (o fallando), la pestaña vacía decía
// «falta la clave de cuotas» aunque la clave estuviera puesta (`hasKey ?? false`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motivoVacio } from './vacio.ts';

test('D14: sin saber si hay clave, no se culpa a la clave', () => {
  assert.equal(motivoVacio(null, null), 'vacio.estadoDesconocido');
  assert.equal(motivoVacio(null, false), 'vacio.sinClave');
  assert.equal(motivoVacio(null, true), 'vacio.sinCausa');
  assert.equal(motivoVacio('sin_clave', null), 'vacio.sinClave', 'si el servidor dice la causa, manda');
  assert.equal(motivoVacio('presupuesto', false), 'vacio.presupuesto');
});

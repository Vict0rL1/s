// D3 (revisión del 8 de octubre): «Cómo le fue al modelo» nacía abierto y con todos los
// deportes mezclados aunque se estuviera en la pestaña de uno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deporteInicial, panelAbierto } from './hoy.ts';

test('D3: sin preferencia guardada, «hoy» abierto y los resultados plegados; la preferencia manda', () => {
  assert.equal(panelAbierto(null, 'resultados'), false);
  assert.equal(panelAbierto(null, 'hoy'), true);
  assert.equal(panelAbierto('1', 'resultados'), true);
  assert.equal(panelAbierto('0', 'hoy'), false);
});

test('D3: en la pestaña de un deporte, los resultados nacen filtrados a ese deporte', () => {
  assert.equal(deporteInicial('football'), 'Fútbol', 'el nombre con el que llegan los resultados del servidor');
  assert.equal(deporteInicial('nhl'), 'NHL');
  assert.equal(deporteInicial('tennis'), 'Tenis');
  assert.equal(deporteInicial('picks'), null, 'en Destacados, todos');
  assert.equal(deporteInicial(null), null);
});

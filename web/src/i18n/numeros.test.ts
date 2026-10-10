// G5 (prueba en el navegador, 9 de octubre): un número que llega a `t()` sale con la coma o el
// punto del idioma. Antes se escribía con `String(v)`: «cuota 2.29» al lado de «41,2 %».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr } from './index';
import { es } from './es';

test('G5: un número con decimales sale con la coma en español y el punto en inglés', () => {
  assert.equal(tr('es', 'form.cuota', { c: 2.29 }), 'cuota 2,29');
  assert.equal(tr('en', 'form.cuota', { c: 2.29 }).endsWith(' 2.29'), true);
  assert.equal(tr('es', 'fiarse.ruido', { pp: 3.6 }), 'Ruido de rating: ±3,6 pp');
  // Los decimales que trae el número, ni uno más (un cálculo con ruido de coma flotante, a 4).
  assert.equal(tr('es', 'form.cuota', { c: 3.1 }), 'cuota 3,1');
  assert.equal(tr('es', 'form.cuota', { c: 0.1 + 0.2 }), 'cuota 0,3');
});

test('G5: los enteros no cambian (un año no lleva separador de miles) y el texto tampoco', () => {
  assert.equal(tr('es', 'form.cuota', { c: 2026 }), 'cuota 2026');
  assert.equal(tr('en', 'form.cuota', { c: 12345 }).endsWith(' 12345'), true);
  assert.equal(tr('es', 'form.cuota', { c: 'v1.2' }), 'cuota v1.2');
});

test('G5: en el catálogo español el «%» va separado por un espacio duro y los decimales con coma', () => {
  // Un separador de miles («20.214», «7.276») no es un decimal: tres cifras tras el punto y otra
  // delante que no sea 0.
  const decimalConPunto = /(?<![\w.,])(?:0\.\d+|\d+\.(?!\d{3}(?!\d))\d+)/;
  const malas = Object.entries(es).filter(([, v]) => /(\d|\})%/.test(v) || decimalConPunto.test(v));
  assert.deepEqual(malas.map(([k]) => k), []);
});

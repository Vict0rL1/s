// G5: la forma de los números en el texto del servidor, la misma que la web (web/src/lib/formato.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conSigno, num, pct } from './numeros.ts';

test('G5: coma decimal, «−» y «%» con espacio duro', () => {
  assert.equal(pct(0.416), '41,6 %');
  assert.equal(pct(0.64, 0), '64 %');
  assert.equal(num(2.29, 2), '2,29');
  assert.equal(num(-3.6, 1), '−3,6');
  assert.equal(num(-0.04, 1), '0,0');
  assert.equal(num(0.88), '0,88');
  assert.equal(conSigno(2.8), '+2,8');
  assert.equal(conSigno(-2.8), '−2,8');
  assert.equal(conSigno(0.01), '0,0');
});

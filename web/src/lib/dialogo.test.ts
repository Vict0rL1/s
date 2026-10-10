// D10 (revisión del 8 de octubre): los diálogos. Con un diálogo abierto, los atajos 1–9/0
// cambiaban de pestaña por debajo; el fondo seguía desplazándose; Escape no cerraba la mitad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atajoPermitido, bloquearScroll, siguienteFoco } from './dialogo.ts';

const doc = (modal: boolean) => ({ querySelector: (sel: string) => (modal && sel.includes('aria-modal') ? {} : null) });
const tecla = (key: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, target: null, ...extra });

test('D10: los atajos no actúan con un diálogo modal abierto ni dentro de un campo', () => {
  assert.equal(atajoPermitido(tecla('2'), doc(false)), true);
  assert.equal(atajoPermitido(tecla('2'), doc(true)), false, 'con un diálogo abierto, el 2 no cambia de pestaña');
  assert.equal(atajoPermitido(tecla('2', { target: { tagName: 'INPUT' } }), doc(false)), false);
  assert.equal(atajoPermitido(tecla('2', { ctrlKey: true }), doc(false)), false);
});

test('D10: el bloqueo del scroll de fondo se anida y deja lo que había', () => {
  const body = { style: { overflow: 'auto' } };
  const a = bloquearScroll(body);
  const b = bloquearScroll(body);
  assert.equal(body.style.overflow, 'hidden');
  a();
  assert.equal(body.style.overflow, 'hidden', 'el segundo diálogo sigue abierto');
  b();
  assert.equal(body.style.overflow, 'auto');
});

test('D10: Tab da la vuelta dentro del diálogo', () => {
  const [x, y, z] = ['x', 'y', 'z'];
  assert.equal(siguienteFoco([x, y, z], z, false), x, 'Tab en el último → el primero');
  assert.equal(siguienteFoco([x, y, z], x, true), z, 'Mayús+Tab en el primero → el último');
  assert.equal(siguienteFoco([x, y, z], y, false), null, 'en medio, el navegador lo hace solo');
  assert.equal(siguienteFoco([x, y, z], 'fuera', false), x, 'el foco fuera del diálogo vuelve dentro');
  assert.equal(siguienteFoco([], 'fuera', false), null);
});

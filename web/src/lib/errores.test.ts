// D7 (revisión del 8 de octubre): tras un despliegue, una pantalla diferida que ya no existe
// dejaba la app en blanco: no había ErrorBoundary. Ahora un error de carga de trozo recarga una
// vez (la página nueva trae los nombres nuevos) y, si vuelve a fallar, lo dice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esErrorDeChunk, debeRecargar } from './errores.ts';

test('D7: reconoce el error de carga de un trozo en los tres navegadores', () => {
  assert.equal(esErrorDeChunk(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Ajustes-abc.js')), true);
  assert.equal(esErrorDeChunk(new TypeError('error loading dynamically imported module')), true);
  assert.equal(esErrorDeChunk(new TypeError('Importing a module script failed.')), true);
  assert.equal(esErrorDeChunk(new Error('Unable to preload CSS for /assets/x.css')), true);
  assert.equal(esErrorDeChunk(new TypeError("Cannot read properties of undefined (reading 'x')")), false);
  assert.equal(esErrorDeChunk(null), false);
});

test('D7: recarga una vez; si ya se recargó hace poco, no entra en bucle', () => {
  const ahora = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(debeRecargar(null, ahora), true);
  assert.equal(debeRecargar(String(ahora - 5_000), ahora), false);
  assert.equal(debeRecargar(String(ahora - 10 * 60_000), ahora), true, 'una marca vieja no bloquea la siguiente vez');
  assert.equal(debeRecargar('basura', ahora), true);
});

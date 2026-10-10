// D6 (revisión del 8 de octubre): con el interruptor «sin conexión» apagado no se registraba
// el service worker, pero el que ya estaba instalado seguía sirviendo lo guardado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrarServiceWorker } from './sinConexion.ts';

function entorno(activa: boolean) {
  const llamadas: string[] = [];
  const sw = {
    register: async () => void llamadas.push('register'),
    getRegistrations: async () => [{ unregister: async () => (llamadas.push('unregister'), true) }],
  };
  const pedir = async () => new Response(JSON.stringify({ features: { 'interfaz.sinConexion': { activa } } }), { headers: { 'content-type': 'application/json' } });
  return { llamadas, deps: { serviceWorker: sw, pedir } };
}

test('D6: interruptor apagado → se desregistra el que hubiera', async () => {
  const { llamadas, deps } = entorno(false);
  await registrarServiceWorker(deps);
  assert.deepEqual(llamadas, ['unregister']);
});

test('D6: interruptor encendido → se registra', async () => {
  const { llamadas, deps } = entorno(true);
  await registrarServiceWorker(deps);
  assert.deepEqual(llamadas, ['register']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simularFetch } from './setup.ts';

test('la preparación aísla la base de datos y la clave', async () => {
  assert.match(process.env.DATA_DIR ?? '', /predicciones-test-/);
  const { env, DB_PATH } = await import('../config.ts');
  assert.equal(env.oddsApiKey, 'clave-de-test-0000000000000000000');
  assert.ok(!DB_PATH.includes('/data/tennis.db'), `la base de test no puede ser la real: ${DB_PATH}`);
});

test('fetch sin simular falla en vez de salir a la red', async () => {
  simularFetch(null);
  await assert.rejects(() => fetch('https://api.the-odds-api.com/v4/sports'), /intentó salir a la red/);
});

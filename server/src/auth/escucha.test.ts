// D15 (revisión del 8 de octubre): en desarrollo, la API, Vite y la sonda de puertos se ataban
// a todas las interfaces. Con APP_AUTH apagado (lo normal en el portátil), la app entera —con
// el registro de apuestas— quedaba abierta a cualquiera de la misma red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { hostDeEscucha } = await import('./mode.ts');
const deScripts = (await import('../../../scripts/escucha.mjs')) as { hostDeEscucha: (e: Record<string, string | undefined>) => string };

const CASOS: [Record<string, string | undefined>, string][] = [
  [{ NODE_ENV: 'test' }, '127.0.0.1'],
  [{}, '127.0.0.1'],
  [{ NODE_ENV: 'development', APP_AUTH: 'off' }, '127.0.0.1'],
  [{ APP_AUTH: 'on' }, '0.0.0.0'],
  [{ NODE_ENV: 'production' }, '0.0.0.0'],
  [{ DEV_LAN: 'on' }, '0.0.0.0'],
  [{ HOST: '192.168.1.20' }, '192.168.1.20'],
];

test('D15: solo se escucha en la red local con contraseña, en producción o pidiéndolo (DEV_LAN=on)', () => {
  for (const [entorno, esperado] of CASOS) assert.equal(hostDeEscucha(entorno as NodeJS.ProcessEnv), esperado, JSON.stringify(entorno));
});

test('D15: la regla de scripts/ (Vite y dev.mjs) es la misma que la del servidor', () => {
  for (const [entorno, esperado] of CASOS) assert.equal(deScripts.hostDeEscucha(entorno), esperado, JSON.stringify(entorno));
});

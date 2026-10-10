// G9 (lote G): la web pedía la simulación de temporada para todos los deportes y la NHL dejaba
// un 404 en la consola de cada ficha de equipo y de liga. La web pide solo la de los deportes que
// el servidor simula; este test ata las dos listas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { DEPORTES_SIMULABLES } = await import('./season.ts');
const WEB = '../../../web/src';
const { SIMULABLES } = (await import(`${WEB}/lib/simulacion.ts`)) as { SIMULABLES: string[] };

test('G9: la web pide la simulación de temporada solo para los deportes que el servidor simula', () => {
  assert.deepEqual([...SIMULABLES].sort(), [...DEPORTES_SIMULABLES].sort());
  assert.ok(!SIMULABLES.includes('nhl') && !SIMULABLES.includes('ufc') && !SIMULABLES.includes('tennis'));
});

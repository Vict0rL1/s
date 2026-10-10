// B5: BACKUP_HOURS y RESULTS_REFRESH_HOURS sin tope. Un setTimeout por encima de 2³¹−1 ms
// (24,8 días) dispara en el acto: BACKUP_HOURS=1000 haría la copia en bucle.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { horasDesdeEntorno: horasResultados } = await import('../ingest/scheduler.ts');
const { horasDesdeEntorno, HORAS_MAXIMAS } = await import('./horas.ts');

test('B5: las horas de una cadencia se acotan a 7 días; 0 apaga; lo que no es un número vuelve al valor por defecto', () => {
  assert.equal(HORAS_MAXIMAS, 168);
  assert.equal(horasDesdeEntorno({ BACKUP_HOURS: '1000' } as NodeJS.ProcessEnv, 'BACKUP_HOURS', 24), 168);
  assert.equal(horasDesdeEntorno({ BACKUP_HOURS: '0' } as NodeJS.ProcessEnv, 'BACKUP_HOURS', 24), 0);
  assert.equal(horasDesdeEntorno({} as NodeJS.ProcessEnv, 'BACKUP_HOURS', 24), 24);
  assert.equal(horasDesdeEntorno({ BACKUP_HOURS: 'nada' } as NodeJS.ProcessEnv, 'BACKUP_HOURS', 24), 24);
  assert.equal(horasDesdeEntorno({ BACKUP_HOURS: '-3' } as NodeJS.ProcessEnv, 'BACKUP_HOURS', 24), 24);
  assert.equal(horasResultados({ RESULTS_REFRESH_HOURS: '1000' } as NodeJS.ProcessEnv), 168);
  assert.equal(horasResultados({ RESULTS_REFRESH_HOURS: '6' } as NodeJS.ProcessEnv), 6);
});

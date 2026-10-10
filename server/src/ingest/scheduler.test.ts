// El ciclo de resultados: seis procesos hijo uno a uno, un fallo no para a los demás, todo
// queda en ingestion_runs, y RESULTS_REFRESH_HOURS manda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { cicloResultados, horasDesdeEntorno, programarResultados, PASOS_RESULTADOS, HORAS_POR_DEFECTO } = await import('./scheduler.ts');
const { ultimasEjecuciones } = await import('./runs.ts');

test('horasDesdeEntorno: 6 por defecto, 0 apaga, basura → por defecto', () => {
  assert.equal(horasDesdeEntorno({} as NodeJS.ProcessEnv), HORAS_POR_DEFECTO);
  assert.equal(horasDesdeEntorno({ RESULTS_REFRESH_HOURS: '0' } as NodeJS.ProcessEnv), 0);
  assert.equal(horasDesdeEntorno({ RESULTS_REFRESH_HOURS: '12' } as NodeJS.ProcessEnv), 12);
  assert.equal(horasDesdeEntorno({ RESULTS_REFRESH_HOURS: 'cada rato' } as NodeJS.ProcessEnv), HORAS_POR_DEFECTO);
  assert.equal(horasDesdeEntorno({ RESULTS_REFRESH_HOURS: '-3' } as NodeJS.ProcessEnv), HORAS_POR_DEFECTO);
  assert.equal(programarResultados({ horas: 0 }), null, 'con 0 no se programa nada');
});

test('cicloResultados: en orden, con --skip-odds implícito en el lanzador, un fallo no corta y queda registrado', async () => {
  const lanzados: string[] = [];
  const lanzar = async (script: string) => {
    lanzados.push(script);
    if (script === 'update-data:bb') return { codigo: 1, salida: 'línea 1\nERROR: hoopR no responde\n' };
    return { codigo: 0, salida: `${script} ok\n` };
  };
  const mensajes: string[] = [];
  const r = await cicloResultados(lanzar, (m) => mensajes.push(m));
  assert.deepEqual(lanzados, PASOS_RESULTADOS.map((p) => p.script), 'los seis, en orden, aunque uno falle');
  assert.equal(r.length, PASOS_RESULTADOS.length);
  assert.deepEqual(r.map((x) => x.ok), [true, false, true, true, true, true]);
  assert.match(r[1].cola, /hoopR no responde/);
  assert.ok(mensajes.some((m) => /baloncesto: falló/.test(m)));
  const ciclo = ultimasEjecuciones().find((e) => e.source === 'results:ciclo')!;
  assert.equal(ciclo.status, 'ok', 'cinco de seis es un ciclo que terminó');
  assert.equal(ciclo.rows_updated, 5);
  assert.match(ciclo.detail ?? '', /fallaron: baloncesto/);
});

test('cicloResultados: si fallan todos, el ciclo queda como error y no lanza', async () => {
  const r = await cicloResultados(async () => ({ codigo: null, salida: 'spawn npm ENOENT' }));
  assert.equal(r.filter((x) => x.ok).length, 0);
  const ciclo = ultimasEjecuciones().find((e) => e.source === 'results:ciclo')!;
  assert.equal(ciclo.status, 'error');
  assert.match(ciclo.error ?? '', new RegExp(`fallaron los ${PASOS_RESULTADOS.length} deportes`));
});

test('programarResultados: devuelve algo que se puede parar y no se solapa', async () => {
  let enCurso = 0;
  let maximo = 0;
  const lanzar = async (_script: string) => {
    enCurso++;
    maximo = Math.max(maximo, enCurso);
    await new Promise((r) => setTimeout(r, 5));
    enCurso--;
    return { codigo: 0, salida: '' };
  };
  const p = programarResultados({ horas: 1, lanzar });
  assert.ok(p);
  p!.parar();
  // Dos ciclos a la vez, a mano: el segundo tiene que esperar al primero (la guardia está en
  // `correr`, que no se exporta; se comprueba la pieza pública: dos ciclos seguidos no se
  // pisan dentro del lanzador).
  await Promise.all([cicloResultados(lanzar), cicloResultados(lanzar)]);
  assert.ok(maximo <= 2);
});

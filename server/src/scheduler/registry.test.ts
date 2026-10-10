// El registro de trabajos: registra, ejecuta midiendo, anota errores sin lanzar, respeta el
// interruptor y no se solapa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { reiniciarRegistro, registrar, ejecutar, estado, habilitar, habilitado, arrancar, parar, registroArrancado, configurar } = await import('./registry.ts');
const { valorDe } = await import('../observability/metrics.ts');

test('registrar + ejecutar: ok y error quedan anotados con duración y contadores', async () => {
  let t = Date.parse('2026-10-07T10:00:00Z');
  reiniciarRegistro({ ahora: () => new Date(t) });
  registrar({ nombre: 'bien', descripcion: 'va bien', cadenciaMin: 30, primeraEnMin: 1, fn: async () => { t += 1500; } });
  registrar({ nombre: 'mal', descripcion: 'falla', cadenciaMin: 0, primeraEnMin: 0, fn: () => { throw new Error('la fuente no responde'); } });
  registrar({ nombre: 'nunca', descripcion: 'no aplica', cadenciaMin: 5, primeraEnMin: 0, fn: () => {}, cuando: () => false });
  assert.deepEqual(estado().map((e) => e.nombre), ['bien', 'mal'], 'el condicionado no se registra');
  const r = await ejecutar('bien');
  assert.deepEqual(r, { ok: true, ms: 1500, error: null, saltado: false });
  const e = estado().find((x) => x.nombre === 'bien')!;
  assert.equal(e.lastStatus, 'ok');
  assert.equal(e.lastDurationMs, 1500);
  assert.equal(e.runsOk, 1);
  assert.equal(e.nextRunAt, new Date(t + 30 * 60_000).toISOString());
  assert.equal(valorDe('trabajo_duracion_segundos', { trabajo: 'bien' }), 1.5);
  const m = await ejecutar('mal');
  assert.equal(m.ok, false);
  assert.match(m.error ?? '', /no responde/);
  const em = estado().find((x) => x.nombre === 'mal')!;
  assert.equal(em.lastStatus, 'error');
  assert.equal(em.runsError, 1);
  assert.equal(em.nextRunAt, null, 'sin cadencia no hay siguiente');
  assert.equal((await ejecutar('desconocido')).saltado, true);
});

test('habilitar/deshabilitar sobrevive al proceso (está en la base) y el tic lo respeta; /ready sabe si arrancó', async () => {
  reiniciarRegistro();
  let veces = 0;
  registrar({ nombre: 'tic', descripcion: 'cuenta', cadenciaMin: 1, primeraEnMin: 0, fn: () => { veces++; } });
  assert.equal(habilitado('tic'), true);
  assert.equal(habilitar('tic', false)?.enabled, false);
  assert.equal(habilitado('tic'), false);
  assert.equal(habilitar('no-existe', false), null);
  assert.equal(registroArrancado(), false);
  arrancar();
  assert.equal(registroArrancado(), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(veces, 0, 'apagado: el tic no lo ejecuta');
  parar();
  assert.equal(registroArrancado(), false);
  habilitar('tic', true);
  // Dos ejecuciones a la vez: la segunda se salta.
  reiniciarRegistro();
  registrar({ nombre: 'lento', descripcion: 'tarda', cadenciaMin: 0, primeraEnMin: 0, fn: () => new Promise((r) => setTimeout(r, 20)) });
  const [a, b] = await Promise.all([ejecutar('lento'), ejecutar('lento')]);
  assert.equal(a.ok, true);
  assert.equal(b.saltado, true);
});

test('B5: cambiar la cadencia mientras el trabajo corre no deja dos temporizadores vivos', async () => {
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let t = Date.parse('2026-10-08T10:00:00Z');
    reiniciarRegistro({ ahora: () => new Date(t) });
    let corridas = 0;
    let liberar: (() => void) | null = null;
    registrar({
      nombre: 'carrera',
      descripcion: 'x',
      cadenciaMin: 1,
      primeraEnMin: 0,
      fn: () => {
        corridas++;
        // La primera pasada dura hasta que el test la suelte; las demás, nada.
        if (corridas === 1) return new Promise<void>((r) => (liberar = r));
        return undefined;
      },
    });
    arrancar();
    const respira = () => new Promise<void>((r) => setImmediate(r));
    mock.timers.tick(0);
    await respira();
    assert.equal(corridas, 1, 'la primera pasada está en marcha');
    // Mientras corre, Ajustes cambia la cadencia a 2 min: programa su tic en T+2.
    configurar('carrera', { cadenciaMin: 2 });
    // Medio minuto después acaba la pasada: el tic viejo NO debe programar otro en T+2,5.
    t += 30_000;
    mock.timers.tick(30_000);
    liberar!();
    await respira();
    await respira();
    t += 90_000;
    mock.timers.tick(90_000); // T+2: el tic de Ajustes
    await respira();
    await respira();
    assert.equal(corridas, 2);
    t += 60_000;
    mock.timers.tick(60_000); // T+3: aquí no debe haber nada (el siguiente es T+4)
    await respira();
    await respira();
    assert.equal(corridas, 2, 'un solo temporizador por trabajo');
    t += 60_000;
    mock.timers.tick(60_000); // T+4
    await respira();
    await respira();
    assert.equal(corridas, 3);
  } finally {
    mock.timers.reset();
    reiniciarRegistro();
  }
});

// El segundo intento de la UFC (docs/plans/ufc-combinado.md): la logística simétrica, el walk-forward
// que no mira el año que predice ni el holdout, los rasgos con lo sabido antes de la pelea, y la
// regla de publicación. Sin red y sin la base real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { ajustarLogistica, walkForward, evaluarCombinado, CANDIDATOS } = await import('./combinado.ts');
const { recorrer } = await import('./evaluacion.ts');
type PeleaUfc = import('./evaluacion.ts').PeleaUfc;
type FichaUfc = import('./evaluacion.ts').FichaUfc;

function rng(semilla: number) {
  let s = semilla;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

test('la logística recupera los pesos de datos simulados y es simétrica', () => {
  const rnd = rng(11);
  const verdad = [1.2, -0.6];
  const X: number[][] = [];
  const y: (0 | 1)[] = [];
  for (let i = 0; i < 6000; i++) {
    const x = [rnd() * 4 - 2, rnd() * 4 - 2];
    X.push(x);
    y.push(rnd() < 1 / (1 + Math.exp(-(verdad[0] * x[0] + verdad[1] * x[1]))) ? 1 : 0);
  }
  const w = ajustarLogistica(X, y);
  assert.ok(Math.abs(w[0] - verdad[0]) < 0.1 && Math.abs(w[1] - verdad[1]) < 0.1, `pesos ${w}`);
  // Dar la vuelta a todas las filas (rasgos y resultado) da los mismos pesos: no hay término independiente.
  const w2 = ajustarLogistica(
    X.map((x) => x.map((v) => -v)),
    y.map((v) => (1 - v) as 0 | 1),
  );
  assert.ok(w.every((v, i) => Math.abs(v - w2[i]) < 1e-9));
  assert.deepEqual(ajustarLogistica([], []), []);
});

// Una liga sintética con fuerza y edad: el más joven gana algo más, además del más fuerte.
function liga(n: number): { peleas: PeleaUfc[]; fichas: Map<string, FichaUfc> } {
  const rnd = rng(5);
  const N = 60;
  const fuerza = Array.from({ length: N }, () => rnd() * 300 - 150);
  const nacio = Array.from({ length: N }, () => 1975 + Math.floor(rnd() * 20));
  const fichas = new Map<string, FichaUfc>(
    Array.from({ length: N }, (_, i) => [`L${String(i).padStart(2, '0')}`, { nacimiento: i % 17 === 0 ? null : `${nacio[i]}-01-01`, alcance_cm: 170 + (i % 11) }]),
  );
  const peleas = Array.from({ length: n }, (_, i) => {
    const x = Math.floor(rnd() * N);
    const z = (x + 1 + Math.floor(rnd() * (N - 1))) % N;
    const anio = 2005 + Math.floor((i / n) * 22);
    const dr = fuerza[x] - fuerza[z] + 25 * (nacio[x] - nacio[z]);
    const ganaX = rnd() < 1 / (1 + 10 ** (-dr / 400));
    return { id: `f${i}`, fecha: `${anio}-06-${String(1 + (i % 28)).padStart(2, '0')}`, orden: 0, luchador_a: `L${String(x).padStart(2, '0')}`, luchador_b: `L${String(z).padStart(2, '0')}`, resultado: ganaX ? 'A' : 'B', metodo: 'Decision - Unanimous', ambigua: 0 } as PeleaUfc;
  });
  return { peleas, fichas };
}

test('rasgos: con lo sabido antes, orientados por id, y lo que falta vale 0', () => {
  const { peleas, fichas } = liga(1200);
  const r = recorrer(peleas, undefined, fichas).pasos;
  // La primera pelea: todos en 1500, sin peleas ni récord.
  assert.equal(r[0].rasgos.elo, 0);
  assert.equal(r[0].rasgos.record, 0);
  assert.equal(r[0].rasgos.experiencia, 0);
  // Un luchador sin fecha de nacimiento (i % 17 === 0): edad 0 en sus peleas.
  peleas.forEach((f, i) => {
    if (f.luchador_a === 'L00' || f.luchador_b === 'L00') assert.equal(r[i].rasgos.edad, 0);
  });
  // Dar la vuelta al orden de la fuente no cambia nada (los rasgos van del primero por id al otro).
  const girada = peleas.map((f) => ({ ...f, luchador_a: f.luchador_b, luchador_b: f.luchador_a, resultado: (f.resultado === 'A' ? 'B' : 'A') as 'A' | 'B' }));
  assert.deepEqual(recorrer(girada, undefined, fichas).pasos, r);
  // Sin fichas, edad y alcance son 0 y lo demás igual.
  const sin = recorrer(peleas).pasos;
  assert.ok(sin.every((x, i) => x.rasgos.edad === 0 && x.rasgos.alcance === 0 && x.rasgos.elo === r[i].rasgos.elo));
});

test('walk-forward: lo que pasa en el año que se predice (o después) no cambia su predicción; el holdout no entra', () => {
  const { peleas, fichas } = liga(6000);
  const base = recorrer(peleas, undefined, fichas).pasos;
  const wf = walkForward(base, 'elo+record+ficha');
  const Y = 2015;
  // Cambiar los resultados de 2015 en adelante SOLO en las filas (no en el Elo): las predicciones de 2015 no se mueven.
  const otro = base.map((x) => (x.anio >= Y ? { ...x, y: (1 - x.y) as 0 | 1 } : x));
  const wf2 = walkForward(otro, 'elo+record+ficha');
  base.forEach((x, i) => {
    if (x.anio === Y && x.puntuable) assert.equal(wf2.p[i], wf.p[i]);
  });
  // Ni el holdout (2026 →) ni lo no puntuable tienen predicción.
  base.forEach((x, i) => {
    if (!x.puntuable) assert.equal(wf.p[i], null);
  });
  assert.ok(base.some((x) => x.anio >= 2026) && base.filter((x) => x.anio >= 2026).every((x) => !x.puntuable));
  assert.ok(![...wf.pesos.keys()].some((a) => a >= 2026));
});

test('la prueba: elige con el entrenamiento, compara con las cuatro referencias y con el Elo, y aplica la regla', () => {
  const { peleas, fichas } = liga(9000);
  const r = evaluarCombinado(peleas, fichas);
  assert.deepEqual(r.eleccion.map((x) => x.candidato).sort(), Object.keys(CANDIDATOS).sort());
  const mejor = r.eleccion.reduce((a, b) => (b.llEntrenamiento < a.llEntrenamiento ? b : a));
  assert.equal(r.elegido, mejor.candidato);
  // En esta liga la edad importa de verdad: el candidato con ficha gana en el entrenamiento y le da peso negativo a ser mayor.
  assert.equal(r.elegido, 'elo+record+ficha');
  assert.ok(r.pesosValidacion.edad < 0, `peso de la edad ${r.pesosValidacion.edad}`);
  assert.equal(r.todo.referencias.length, 4);
  assert.ok(r.validacion.n > 0 && r.validacion.n < r.todo.n);
  assert.equal(r.pasa, [r.todo, r.validacion].every((t) => t.referencias.every((x) => x.hi < 0)));
  assert.equal(r.mejoraAlElo, r.validacion.contraElo.hi < 0);
  assert.ok(r.todo.contraElo.mean < 0, 'con la edad como señal, el combinado mejora al Elo solo');
});

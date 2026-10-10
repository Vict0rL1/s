// D14 (revisión del 8 de octubre): tres detalles que se comprueban sobre el fuente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';

const SRC = path.join(import.meta.dirname, '..');
const ficheros = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? ficheros(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));

test('D14: todo mensaje de error en pantalla ({error && <p …>}) se anuncia (role="alert")', () => {
  const sin: string[] = [];
  for (const f of ficheros(SRC)) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\{error && <p\b[^>]*>/g)) if (!m[0].includes('role="alert"')) sin.push(`${path.relative(SRC, f)}: ${m[0].slice(0, 60)}`);
  }
  assert.deepEqual(sin, []);
});

test('D14: el anillo de foco sigue la forma del elemento (sin border-radius propio)', () => {
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  const bloque = /:focus-visible\s*\{([^}]*)\}/.exec(css);
  assert.ok(bloque, 'hay una regla :focus-visible');
  assert.doesNotMatch(bloque![1], /border-radius/);
});

test('D14: sin plurales «(s)»: cada cuenta tiene su forma de uno y de varios', () => {
  for (const [nombre, cat] of [['es', es], ['en', en]] as const) {
    const malos = Object.entries(cat as Record<string, string>).filter(([, v]) => /\w\(s\)|\w\(es\)/.test(v)).map(([k]) => k);
    assert.deepEqual(malos, [], `${nombre}: claves con «(s)»`);
  }
});

test('D14: «{n|uno|varios}» elige la forma por el número', async () => {
  const { tr } = await import('../i18n/index.tsx');
  assert.equal(tr('es', 'pap.apuntados', { n: 1 }), '1 punto apuntado');
  assert.equal(tr('es', 'pap.apuntados', { n: 3 }), '3 puntos apuntados');
  assert.equal(tr('es', 'ufc.descartadas', { n: 1 }).startsWith('En la última actualización de cuotas se descartó 1 pelea '), true);
});

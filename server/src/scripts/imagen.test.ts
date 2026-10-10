// A4: la imagen de Fly ejecutaba `npx tsx` con tsx en devDependencies (instalada con
// --omit=dev): npx la descargaba sin fijar en cada arranque frío, como root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const leer = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('A4: tsx es dependencia del servidor, fijada a una versión exacta', () => {
  const pkg = JSON.parse(leer('server/package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  assert.match(pkg.dependencies.tsx ?? '', /^\d+\.\d+\.\d+$/, `dependencies.tsx = ${pkg.dependencies.tsx}`);
  assert.equal(pkg.devDependencies.tsx, undefined, 'no en las dos listas');
  // Y el lockfile no la marca como de desarrollo: `npm ci --omit=dev` la tiene que instalar.
  const lock = JSON.parse(leer('package-lock.json')) as { packages: Record<string, { version: string; dev?: boolean }> };
  const entrada = lock.packages['node_modules/tsx'];
  assert.ok(entrada, 'tsx en package-lock.json');
  assert.equal(entrada.version, pkg.dependencies.tsx);
  assert.notEqual(entrada.dev, true, 'tsx no es de desarrollo en el lockfile');
});

test('A4: el arranque de la imagen usa el tsx instalado, no npx, y suelta los privilegios', () => {
  const sh = leer('scripts/docker-start.sh');
  // Lo que se ejecuta (los comentarios cuentan la historia, y pueden decir «npx»).
  const comandos = sh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(comandos, /\bnpx\b/, 'sin npx: nada se descarga al arrancar');
  assert.match(sh, /node_modules\/\.bin\/tsx/);
  assert.match(sh, /setpriv|runuser/, 'el servidor corre como node, no como root');
  assert.match(sh, /chown/, 'el disco de Fly se monta de root: hay que cedérselo a node');
});

// ---------------------------------------------------------------------------
// B5: la semilla de la imagen, y lo que se comprueba antes de publicar
// ---------------------------------------------------------------------------
test('B5: la semilla de la imagen es una exportación (VACUUM INTO), no el fichero crudo sin su WAL', () => {
  const dockerfile = leer('Dockerfile');
  assert.doesNotMatch(dockerfile, /COPY data\/history\.db /, 'el fichero crudo pierde lo que está en history.db-wal');
  assert.match(dockerfile, /db:export-history/);
  assert.match(dockerfile, /COPY --from=build \S*seed\S* \/seed\/history\.db/);
  const ignore = leer('.dockerignore').split('\n').map((l) => l.trim());
  assert.ok(!ignore.includes('data/*.db-wal'), 'history.db-wal tiene que entrar en el contexto para que la exportación vea sus páginas');
  assert.ok(ignore.some((l) => /^data\/ledger\.db\*?$/.test(l)), 'el libro mayor no viaja al contexto de construcción');
});

test('B5: check-publishable usa la lista de tablas del libro mayor del servidor, y el workflow comprueba lo que exporta', () => {
  const script = leer('scripts/check-publishable.mjs');
  assert.doesNotMatch(script, /const TABLAS_LEDGER = \[/, 'sin copia a mano de la lista');
  assert.match(script, /server\/src\/db\/tables\.ts/);
  const wf = leer('.github/workflows/data.yml');
  const exporta = wf.indexOf('db:export-history');
  const comprueba = wf.indexOf('check-publishable');
  assert.ok(exporta > 0 && comprueba > exporta, 'primero se exporta y después se comprueba el fichero exportado');
  assert.match(wf, /check-publishable[^\n]*history\.export\.db/);
});

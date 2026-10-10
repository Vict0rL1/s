// D4 (revisión del 8 de octubre): Ajustes pintaba once claves de la política tal cual
// («recortes.oodLeve»). Toda clave numérica de la política de fábrica tiene que tener su
// etiqueta en la web, en español y en inglés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { politicaPorDefecto } = await import('./policyStore.ts');
// Rutas en variables: así el typecheck del servidor no compila ficheros de la web.
const WEB = '../../../web/src';
const { ETIQUETA_POLITICA } = (await import(`${WEB}/lib/politica.ts`)) as { ETIQUETA_POLITICA: Record<string, string> };
const { es } = (await import(`${WEB}/i18n/es.ts`)) as { es: Record<string, string> };
const { en } = (await import(`${WEB}/i18n/en.ts`)) as { en: Record<string, string> };

test('D4: cada clave numérica de la política tiene etiqueta en es y en', () => {
  const claves: string[] = [];
  for (const [grupo, valores] of Object.entries(politicaPorDefecto())) {
    for (const [k, v] of Object.entries(valores as Record<string, unknown>)) if (typeof v === 'number') claves.push(`${grupo}.${k}`);
  }
  assert.ok(claves.length >= 19, `la política tiene ${claves.length} claves numéricas`);
  const sinEtiqueta = claves.filter((c) => !(c in ETIQUETA_POLITICA));
  assert.deepEqual(sinEtiqueta, [], 'claves sin etiqueta');
  for (const c of claves) {
    const k = ETIQUETA_POLITICA[c];
    assert.ok(typeof es[k] === 'string' && es[k].length > 0, `${c}: falta ${k} en es`);
    assert.ok(typeof en[k] === 'string' && en[k].length > 0, `${c}: falta ${k} en en`);
  }
});

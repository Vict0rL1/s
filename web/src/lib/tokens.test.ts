// G6 (prueba en el navegador, 9 de octubre): los colores de estado se leen como TEXTO sobre su
// propio fondo teñido, también cuando la insignia cae sobre una superficie elevada. En claro,
// «BAJA» daba 4,48:1 y «Confianza media» 4,26:1. Se calcula con los tokens de index.css, en el
// peor fondo en que la app pone una insignia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contraste, sobre } from './contraste';

const css = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8');

function bloque(selector: string): Record<string, string> {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, selector);
  const cuerpo = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  return Object.fromEntries([...cuerpo.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
/** Un token rgba(r, g, b, a) encima de un hex. */
function capa(rgba: string, fondo: string): string {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number);
  const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  return sobre(hex, a, fondo);
}

const TEMAS = { oscuro: bloque(":root[data-theme='oscuro']"), claro: bloque(":root[data-theme='claro']") };

test('G6: el tema «auto» claro es el mismo que el claro elegido', () => {
  const auto = bloque(":root:not([data-theme='oscuro']):not([data-theme='claro'])");
  assert.deepEqual(auto, TEMAS.claro);
});

for (const [tema, t] of Object.entries(TEMAS)) {
  const fondos = {
    tarjeta: t['surface-card'],
    pagina: t['surface-page'],
    carril: t['surface-rail'],
    'tarjeta tintada': capa(t['tint'], t['surface-card']),
    'elevado sobre la página': capa(t['raised'], t['surface-page']),
    'elevado sobre la tarjeta': capa(t['raised'], t['surface-card']),
  };
  test(`G6: en ${tema}, cada estado como texto sobre su fondo teñido (12–14 %) pasa de 4,5:1`, () => {
    const bajos: string[] = [];
    for (const estado of ['good', 'warning', 'critical', 'neutral']) {
      const color = t[`status-${estado}`];
      for (const [donde, base] of Object.entries(fondos)) {
        for (const alfa of [0.12, 0.14]) {
          const r = contraste(color, sobre(color, alfa, base));
          if (r < 4.5) bajos.push(`${estado} (${color}) al ${Math.round(alfa * 100)} % sobre ${donde}: ${r.toFixed(2)}`);
        }
      }
    }
    assert.deepEqual(bajos, []);
  });
  test(`G6: en ${tema}, la tinta sobre relleno se lee sobre el rojo de estado (la campana)`, () => {
    assert.ok(contraste(t['ink-on-fill'], t['status-critical']) >= 4.5, `${t['ink-on-fill']} sobre ${t['status-critical']}`);
  });
}

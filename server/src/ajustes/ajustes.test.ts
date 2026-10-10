// Ajustes y seguimiento: lo válido entra, lo desconocido no, y seguir dos veces no duplica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { validarAjustes, guardarAjustes, leerAjustes, idiomaDeAcceptLanguage, AJUSTES_POR_DEFECTO } = await import('./index.ts');
const { seguir, listarSeguidos, dejarDeSeguir, seguido, validarSeguido } = await import('../watchlist/index.ts');

test('validarAjustes: claves conocidas y valores válidos; el resto se rechaza', () => {
  assert.deepEqual(validarAjustes({ tema: 'claro', idioma: 'en', bancoPersonal: 250.555, recorridoVisto: 1 }), { tema: 'claro', idioma: 'en', bancoPersonal: 250.56, recorridoVisto: true });
  assert.throws(() => validarAjustes({ tema: 'rosa' }), /tema/);
  assert.throws(() => validarAjustes({ idioma: 'fr' }), /idioma/);
  assert.throws(() => validarAjustes({ bancoPersonal: -1 }), /bancoPersonal/);
  assert.throws(() => validarAjustes({ deportesOcultos: ['curling'] }), /deportes conocidos/);
  assert.throws(() => validarAjustes({ deportesOcultos: ['tennis', 'football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc'] }), /visible/);
  assert.throws(() => validarAjustes({ otra: 1 }), /desconocido/);
  assert.deepEqual(leerAjustes(), AJUSTES_POR_DEFECTO);
  const g = guardarAjustes({ deportesOcultos: ['tennis', 'tennis'], tema: 'oscuro' });
  assert.deepEqual(g.deportesOcultos, ['tennis']);
  assert.equal(leerAjustes().tema, 'oscuro');
  assert.equal(idiomaDeAcceptLanguage('en-US,en;q=0.9,es;q=0.8'), 'en');
  assert.equal(idiomaDeAcceptLanguage('es-ES,es;q=0.9'), 'es');
  assert.equal(idiomaDeAcceptLanguage(undefined), 'es');
});

test('seguimiento: seguir, listar, no duplicar, saber si un partido se sigue, dejar de seguir', () => {
  const a = seguir(validarSeguido({ kind: 'equipo', sport: 'football', league: 'epl', ref_id: 'arsenal', label: 'Arsenal' }));
  const b = seguir(validarSeguido({ kind: 'equipo', sport: 'football', league: 'epl', ref_id: 'arsenal', label: 'Arsenal FC' }));
  assert.equal(a.id, b.id, 'la misma referencia no se duplica');
  seguir(validarSeguido({ kind: 'partido', sport: 'nfl', ref_id: 'nfl-2026-6-KC-BUF', label: 'KC @ BUF' }));
  assert.equal(listarSeguidos().length, 2);
  assert.equal(seguido('nfl', 'nfl-2026-6-KC-BUF'), true);
  assert.equal(seguido('football', 'x', ['arsenal', 'chelsea']), true);
  assert.equal(seguido('football', 'x', ['chelsea']), false);
  assert.throws(() => validarSeguido({ kind: 'cosa', sport: 'football', ref_id: 'x', label: 'x' }), /tipo/);
  assert.throws(() => validarSeguido({ kind: 'equipo', sport: 'curling', ref_id: 'x', label: 'x' }), /deporte/);
  assert.equal(dejarDeSeguir(a.id), true);
  assert.equal(dejarDeSeguir(a.id), false);
});

// D8 (revisión del 8 de octubre): enlaces profundos. Un `?dia=` se borraba mientras cargaban
// los partidos (todavía sin días), y una liga que contestaba tarde pisaba a la elegida después.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conservarDia, contadorDePeticiones } from './carga.ts';

test('D8: el día del enlace se conserva mientras carga y solo se quita si de verdad no existe', () => {
  assert.equal(conservarDia('2026-10-11', [], true), '2026-10-11', 'cargando: sin días todavía');
  assert.equal(conservarDia('2026-10-11', [], false), '2026-10-11', 'antes de la primera carga tampoco hay días');
  assert.equal(conservarDia('2026-10-11', ['2026-10-10'], true), '2026-10-11', 'los días de la liga anterior no cuentan');
  assert.equal(conservarDia('2026-10-11', ['2026-10-10', '2026-10-11'], false), '2026-10-11');
  assert.equal(conservarDia('2026-10-11', ['2026-10-10'], false), null, 'cargado y sin ese día: fuera');
  assert.equal(conservarDia(null, ['2026-10-10'], false), null);
});

test('D8: solo la última petición escribe (cambiar dos veces de liga no deja la vieja)', async () => {
  const c = contadorDePeticiones();
  const escritas: string[] = [];
  const cargar = (liga: string, ms: number) => {
    const n = c.nueva();
    return new Promise((ok) => setTimeout(ok, ms)).then(() => {
      if (c.esUltima(n)) escritas.push(liga);
    });
  };
  await Promise.all([cargar('laliga', 30), cargar('epl', 5)]);
  assert.deepEqual(escritas, ['epl'], 'la Liga contestó tarde y no pisa a la Premier');
});

test('G2: el torneo del enlace se conserva mientras no ha llegado la lista de torneos', async () => {
  const { torneoValido } = await import('./carga.ts');
  const lista = [{ id: 'australian_open' }, { id: 'wimbledon' }];
  assert.equal(torneoValido('wimbledon', [], false), 'wimbledon', 'sin lista todavía: no se toca');
  assert.equal(torneoValido('wimbledon', lista, true), 'wimbledon');
  assert.equal(torneoValido('no_existe', lista, true), 'australian_open', 'cargada y sin él: el primero');
  assert.equal(torneoValido(null, lista, true), 'australian_open');
  assert.equal(torneoValido('wimbledon', [], true), null, 'cargada y vacía: ninguno');
});

test('G3: solo se pintan las filas de la liga elegida (las de la anterior, mientras carga, no)', async () => {
  const { filasDeLaLiga } = await import('./carga.ts');
  const filas = [{ fixture: { league: 'laliga', id: 1 } }, { fixture: { league: 'laliga', id: 2 } }];
  assert.deepEqual(filasDeLaLiga(filas, (f) => f.fixture.league, 'epl'), []);
  assert.deepEqual(filasDeLaLiga(filas, (f) => f.fixture.league, 'laliga'), filas);
  assert.deepEqual(filasDeLaLiga(filas, (f) => f.fixture.league, null), []);
});

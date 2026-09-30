import { test } from 'node:test';
import assert from 'node:assert/strict';
import './test/setup.ts';

const { SPORT_IDS, OUTCOMES, isSportId } = await import('./sports.ts');
const { versionsFor } = await import('./versions.ts');
const { evaluacionEnVivo } = await import('./evaluation/live.ts');

test('cada deporte de la lista tiene versión, resultados y evaluación en vivo', () => {
  for (const s of SPORT_IDS) {
    assert.match(versionsFor(s).model_version, new RegExp(`^${s}-[0-9a-f]{12}$`));
    assert.ok(OUTCOMES[s] === 2 || OUTCOMES[s] === 3);
  }
  assert.deepEqual(evaluacionEnVivo().map((r) => r.deporte), [...SPORT_IDS]);
});

// TEST NEGATIVO: un nombre parecido no cuela como deporte.
test('solo los cinco identificadores son deportes', () => {
  for (const s of SPORT_IDS) assert.ok(isSportId(s));
  for (const s of ['futbol', 'soccer', 'NFL', '', 'toString', 'constructor']) assert.equal(isSportId(s), false, s);
});

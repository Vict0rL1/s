// C10: el tenis se liquidaba comparando el nombre ACTUAL de `players` con el nombre apostado (el
// del registro): si difieren, la apuesta se daba por perdida. Ahora se resuelve el lado contra el
// registro y se liquida por id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { liquidador } = await import('./bankroll.ts');

const db = getDb();
db.prepare("INSERT INTO players (id, tour, name) VALUES (1, 'atp', 'Carlos Alcaraz'), (2, 'atp', 'Jannik Sinner')").run();
db.prepare(
  `INSERT INTO prediction_log (match_key, tour, upcoming_id, commence_time, p1_id, p2_id, p1_name, p2_name, prob1, market_prob1, predicted_at, winner_id, resolved_at)
   VALUES ('atp|1|2|20261010', 'atp', 'ev-1', '2026-10-10T12:00:00Z', 1, 2, 'C. Alcaraz', 'J. Sinner', 0.6, 0.55, '2026-10-09T12:00:00Z', 1, '2026-10-10T15:00:00Z')`,
).run();

test('C10: la apuesta se liquida por el id del ganador aunque el nombre de la ficha haya cambiado', () => {
  const liq = liquidador();
  assert.deepEqual(liq({ sport: 'tennis', match_key: 'atp|1|2|20261010', selection: 'C. Alcaraz' }), { status: 'won', resultado: 'ganó C. Alcaraz' });
  assert.equal(liq({ sport: 'tennis', match_key: 'atp|1|2|20261010', selection: 'J. Sinner' })?.status, 'lost');
  // Una selección que no es ninguno de los dos nombres del registro no se da por perdida: se anula.
  assert.equal(liq({ sport: 'tennis', match_key: 'atp|1|2|20261010', selection: 'Nadie' })?.status, 'void');
  assert.equal(liq({ sport: 'tennis', match_key: 'no-existe', selection: 'C. Alcaraz' }), null);
});

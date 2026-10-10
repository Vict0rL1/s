// C5: una estrategia congelaba su `staking`, pero los topes de grupo salían de la política
// VIGENTE en cada pasada; sus apuestas no guardaban la versión de la política; y el tope de
// equipo del 3 % recortaba la PRIMERA apuesta de una estrategia con tope por partido mayor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { crearEstrategia, colocarEstrategias, configDe, limitesDeEstrategia } = await import('./index.ts');
const { politica } = await import('../staking/policyStore.ts');

const db = getDb();
const H = 3_600_000;
const ahora = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const INICIO = iso(ahora + 48 * H);
db.prepare(
  `INSERT INTO fb_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_draw, odds_away, books, source, updated_at)
   VALUES ('cong-arsenal-chelsea', 'epl', ?, 'Arsenal', 'Chelsea', 'ars', 'che', 2.5, 3.4, 3.0, 6, 'live', ?)`,
).run(INICIO, iso(ahora - 30 * 60_000));
db.prepare(
  `INSERT INTO fb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
     prob_home, prob_draw, prob_away, shown_home, shown_draw, shown_away, market_prob_home, market_prob_draw, market_prob_away, reliability, predicted_at)
   VALUES ('cong|ars|che', 'epl', 'cong-arsenal-chelsea', ?, 'ars', 'che', 'Arsenal', 'Chelsea', 0.54, 0.24, 0.22, 0.52, 0.25, 0.23, 0.385, 0.283, 0.332, 'high', ?)`,
).run(INICIO, iso(ahora - 1 * H));

test('C5: la configuración congela también los topes de grupo, y nunca por debajo del tope por partido', () => {
  const c = configDe({ nombre: 'x', staking: { maxPerEvent: 0.04 } });
  assert.deepEqual(c.grupos, { maxSameTeamExposure: politica().grupos.maxSameTeamExposure, maxSamePlayerExposure: politica().grupos.maxSamePlayerExposure });
  const limite = limitesDeEstrategia(c);
  assert.equal(limite('evento:football:x'), 0.04);
  assert.equal(limite('equipo:football:ars'), 0.04, 'el tope de equipo no puede ser menor que lo que una sola apuesta puede tomar');
  const holgado = limitesDeEstrategia({ ...c, grupos: { maxSameTeamExposure: 0.06, maxSamePlayerExposure: 0.07 } });
  assert.equal(holgado('equipo:football:ars'), 0.06);
  assert.equal(holgado('jugador:tennis:1'), 0.07);
  // Una estrategia anterior a esto (sin `grupos` guardado) usa la política vigente y lo dice.
  const antigua = limitesDeEstrategia({ ...c, grupos: undefined });
  assert.equal(antigua('equipo:football:ars'), Math.max(politica().grupos.maxSameTeamExposure, 0.04));
});

test('C5: la primera apuesta de una estrategia con tope por partido del 4 % no se recorta al 3 %, y guarda la versión de la política', () => {
  const e = crearEstrategia({ nombre: 'Holgada', deportes: ['football'], confianza: false, calibracion: false, staking: { minEdge: 0.01, maxPerEvent: 0.04, maxExposurePerDay: 0.08, maxExposurePerLeague: 0.08 } });
  const [pasada] = colocarEstrategias(new Date(ahora));
  assert.equal(pasada.colocadas, 1, JSON.stringify(pasada));
  const a = db.prepare('SELECT stake, policy_version_id FROM strategy_bets WHERE strategy_id = ?').get(e.id) as { stake: number; policy_version_id: number | null };
  assert.equal(a.stake, 40, 'Kelly/4 = 5 % recortado a su tope por partido del 4 %, no al 3 % de equipo');
  assert.ok(a.policy_version_id != null && a.policy_version_id > 0, 'la versión de la política con la que se apostó');
});

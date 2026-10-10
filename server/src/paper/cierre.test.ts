// C8: el cierre se tomaba de la última observación anterior al inicio aunque fuera ANTERIOR a la
// apuesta: sin nadie que volviera a pedir cuotas, el «cierre» era el snapshot con el que se apostó
// (CLV 0) o uno más viejo. Ahora el cierre exige una observación posterior a la apuesta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { place, captureClosing } = await import('./bankroll.ts');
const { recordOddsResponse } = await import('../odds/snapshots.ts');
const { crearEstrategia, colocarEstrategias, cierreEstrategias } = await import('../estrategias/index.ts');

const db = getDb();
const H = 3_600_000;
const ahora = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const INICIO = iso(ahora + 48 * H);

function snapshot(at: number, local: number) {
  recordOddsResponse('soccer_epl', 'h2h', {
    fetchedAt: iso(at),
    events: [{ id: 'epl-cierre', sport_key: 'soccer_epl', commence_time: INICIO, home_team: 'Arsenal', away_team: 'Chelsea', bookmakers: [{ key: 'pinnacle', title: 'P', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: local }, { name: 'Draw', price: 3.4 }, { name: 'Chelsea', price: 3.0 }] }] }] }],
  });
}
snapshot(ahora - 2 * H, 2.5);
db.prepare(
  `INSERT INTO fb_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_draw, odds_away, books, source, updated_at)
   VALUES ('epl-cierre', 'epl', ?, 'Arsenal', 'Chelsea', 'ars', 'che', 2.5, 3.4, 3.0, 6, 'live', ?)`,
).run(INICIO, iso(ahora - 30 * 60_000));
db.prepare(
  `INSERT INTO fb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
     prob_home, prob_draw, prob_away, shown_home, shown_draw, shown_away, market_prob_home, market_prob_draw, market_prob_away, reliability, predicted_at)
   VALUES ('epl|ars|che|c', 'epl', 'epl-cierre', ?, 'ars', 'che', 'Arsenal', 'Chelsea', 0.54, 0.24, 0.22, 0.52, 0.25, 0.23, 0.385, 0.283, 0.332, 'high', ?)`,
).run(INICIO, iso(ahora - 1 * H));
db.prepare(
  `INSERT INTO prediction_assessments (sport, match_key, event_id, commence_time, assessed_at, probs, decision, selection, odds, edge,
     stake_factor, confidence, data_quality, uncertainty_pp, stability, stability_pp, disagreement, disagreement_pp, market_quality, edge_vanish, ood, regime, reasons, model_version)
   VALUES ('football', 'epl|ars|che|c', 'epl-cierre', ?, ?, '[0.52,0.25,0.23]', 'BET', 0, 2.5, 0.3, 1, 'ALTA', 90, 3, 'ALTA', 2, 'BAJO', 2, 'ALTA', 0.01, '[]', 'temporada', '[]', 'football-x')`,
).run(INICIO, iso(ahora - 10 * 60_000));

test('C8: sin ninguna observación posterior a la apuesta, el cierre se queda a NULL (banco y estrategia)', () => {
  assert.equal(place().colocadas, 1);
  const e = crearEstrategia({ nombre: 'Cierre', deportes: ['football'], confianza: false, calibracion: false, staking: { minEdge: 0.01 } });
  assert.equal(colocarEstrategias(new Date(ahora)).find((p) => p.id === e.id)?.colocadas, 1);
  const despues = new Date(Date.parse(INICIO) + H);
  assert.equal(captureClosing(despues).fijados, 0, 'la única observación es anterior a la apuesta: no es un cierre');
  assert.equal(cierreEstrategias(despues).fijados, 0);
  assert.equal((db.prepare("SELECT closing_odds FROM paper_bets WHERE event_id = 'epl-cierre'").get() as { closing_odds: number | null }).closing_odds, null);
  assert.equal((db.prepare('SELECT closing_odds FROM strategy_bets WHERE strategy_id = ?').get(e.id) as { closing_odds: number | null }).closing_odds, null);
  // Con una observación después de apostar y antes del inicio, sí.
  snapshot(Date.parse(INICIO) - 10 * 60_000, 2.3);
  assert.equal(captureClosing(despues).fijados, 1);
  assert.equal(cierreEstrategias(despues).fijados, 1);
  assert.equal((db.prepare("SELECT closing_odds FROM paper_bets WHERE event_id = 'epl-cierre'").get() as { closing_odds: number }).closing_odds, 2.3);
});

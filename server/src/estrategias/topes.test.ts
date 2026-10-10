// A6 (estrategias): lo mismo que el banco de papel. Una estrategia con su propia política
// tampoco miraba los topes por día ni por liga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { crearEstrategia, colocarEstrategias } = await import('./index.ts');

const db = getDb();
const H = 3_600_000;
const ahora = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const base = new Date(ahora + 48 * H);
base.setUTCHours(12, 0, 0, 0);
const EQUIPOS = [['Arsenal', 'Chelsea'], ['Liverpool', 'Everton'], ['Spurs', 'Fulham'], ['Leeds', 'Burnley'], ['Wolves', 'Villa'], ['Brighton', 'Palace']];

for (const [i, [local, visitante]] of EQUIPOS.entries()) {
  const id = `lab-${local.toLowerCase()}`;
  const inicio = iso(base.getTime() + i * H);
  const lid = local.slice(0, 3).toLowerCase();
  const vid = visitante.slice(0, 3).toLowerCase();
  db.prepare(
    `INSERT INTO fb_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_draw, odds_away, books, source, updated_at)
     VALUES (?, 'epl', ?, ?, ?, ?, ?, 2.5, 3.4, 3.0, 6, 'live', ?)`,
  ).run(id, inicio, local, visitante, lid, vid, iso(ahora - 30 * 60_000));
  db.prepare(
    `INSERT INTO fb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
       prob_home, prob_draw, prob_away, shown_home, shown_draw, shown_away,
       market_prob_home, market_prob_draw, market_prob_away, reliability, predicted_at)
     VALUES (?, 'epl', ?, ?, ?, ?, ?, ?, 0.54, 0.24, 0.22, 0.52, 0.25, 0.23, 0.385, 0.283, 0.332, 'high', ?)`,
  ).run(`lab|${lid}|${vid}`, id, inicio, lid, vid, local, visitante, iso(ahora - 1 * H));
}

test('A6: una estrategia respeta los topes por día y por liga de su configuración', () => {
  // Tope por día del 3 %: más estricto que el de liga, para ver que manda el más bajo.
  const e = crearEstrategia({ nombre: 'Topes', deportes: ['football'], confianza: false, calibracion: false, staking: { minEdge: 0.01, maxExposurePerDay: 0.03 } });
  assert.equal(e.config.staking.maxExposurePerDay, 0.03);
  const [pasada] = colocarEstrategias(new Date(ahora));
  const abiertas = db.prepare("SELECT stake FROM strategy_bets WHERE strategy_id = ? AND status = 'pending'").all(e.id) as { stake: number }[];
  const total = abiertas.reduce((s, a) => s + a.stake, 0);
  assert.ok(abiertas.length >= 1, JSON.stringify(pasada));
  assert.ok(total <= 30 + 1e-9, `${total} el mismo día con tope 30: ${JSON.stringify(pasada)}`);
  assert.ok(Object.keys(pasada.rechazos).some((m) => /tope por día/.test(m)), JSON.stringify(pasada.rechazos));
});
